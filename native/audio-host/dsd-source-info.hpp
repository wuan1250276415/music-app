#pragma once
#include <windows.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <string>

// Container bounds and source ticks are checked before FFmpeg's /8-rate representation is used.
// This is a read-only header probe, not a Native DSD/DoP transport implementation.
constexpr uint32_t auralDsdPcmRate=176400;
constexpr const char* auralDsdPcmProfile="ff-dsd96-swr128-kaiser9-c0.5-v1";
struct AuralDsdInfo {
    uint32_t bitRate=0,channels=0,blockBytes=0;
    uint32_t layoutCode=0;std::array<uint32_t,16> channelTags{};
    uint64_t validBitSamples=0;
    uint64_t dataOffset=0,dataBytes=0;
    bool planar=false,lsbFirst=false;
    std::string container;
};
enum class AuralDsdProbe {notDsd,valid,invalid,unsupported};
inline AuralDsdProbe auralInspectDsd(HANDLE file,AuralDsdInfo& result,std::string& reason,bool allowPartialByte=false){
    result={};reason.clear();LARGE_INTEGER size{};
    if(!GetFileSizeEx(file,&size)||size.QuadPart<0)return AuralDsdProbe::invalid;
    const uint64_t bytes=uint64_t(size.QuadPart);
    const auto read=[&](uint64_t at,void* out,DWORD count){
        if(at>bytes||count>bytes-at||at>INT64_MAX)return false;
        LARGE_INTEGER where{};where.QuadPart=int64_t(at);DWORD got=0;
        return SetFilePointerEx(file,where,nullptr,FILE_BEGIN)&&ReadFile(file,out,count,&got,nullptr)&&got==count;
    };
    const auto le32=[](const uint8_t* p){uint32_t n=0;for(unsigned i=0;i<4;++i)n|=uint32_t(p[i])<<(8*i);return n;};
    const auto le64=[](const uint8_t* p){uint64_t n=0;for(unsigned i=0;i<8;++i)n|=uint64_t(p[i])<<(8*i);return n;};
    const auto be32=[](const uint8_t* p){uint32_t n=0;for(unsigned i=0;i<4;++i)n=(n<<8)|p[i];return n;};
    const auto be64=[](const uint8_t* p){uint64_t n=0;for(unsigned i=0;i<8;++i)n=(n<<8)|p[i];return n;};
    const auto validRate=[](uint32_t rate){return rate==2822400||rate==5644800||rate==11289600;};
    std::array<uint8_t,92> header{};
    if(bytes<4||!read(0,header.data(),4))return AuralDsdProbe::notDsd;
    if(!std::memcmp(header.data(),"DSD ",4)){
        if(!read(0,header.data(),DWORD(header.size()))||le64(header.data()+4)!=28||le64(header.data()+12)!=bytes||
            std::memcmp(header.data()+28,"fmt ",4)||le64(header.data()+32)!=52||le32(header.data()+40)!=1||le32(header.data()+44)!=0||
            std::memcmp(header.data()+80,"data",4))return AuralDsdProbe::invalid;
        result.container="dsf";result.planar=true;result.channels=le32(header.data()+52);result.bitRate=le32(header.data()+56);
        const uint32_t order=le32(header.data()+60),layout=le32(header.data()+48);result.blockBytes=le32(header.data()+72);
        result.layoutCode=layout;
        result.validBitSamples=le64(header.data()+64);result.lsbFirst=order==1;
        constexpr uint32_t layoutCounts[]={0,1,2,3,4,4,5,6};
        if(layout>=8||!result.channels||layoutCounts[layout]!=result.channels||!result.validBitSamples||
           (order!=1&&order!=8)||!result.blockBytes||result.blockBytes>65536)return AuralDsdProbe::invalid;
        if(!validRate(result.bitRate)){reason="当前转换适配 DSD64、DSD128 和 DSD256 的 44.1 kHz 速率族";return AuralDsdProbe::unsupported;}
        if(result.validBitSamples%8&&!allowPartialByte){reason="当前转换暂不接受非整字节 DSD 末尾，避免丢失有效位";return AuralDsdProbe::unsupported;}
        const uint64_t perChannel=result.validBitSamples/8+(result.validBitSamples%8?1:0),blocks=perChannel/result.blockBytes+(perChannel%result.blockBytes?1:0);
        if(blocks>UINT64_MAX/result.blockBytes/result.channels)return AuralDsdProbe::invalid;
        const uint64_t payload=blocks*result.blockBytes*result.channels,chunk=le64(header.data()+84),id3=le64(header.data()+20);
        if(chunk<12||payload!=chunk-12||chunk>bytes-80||id3&&(id3<80+chunk||id3>=bytes))return AuralDsdProbe::invalid;
        result.dataOffset=92;result.dataBytes=payload;
        return AuralDsdProbe::valid;
    }
    if(std::memcmp(header.data(),"FRM8",4))return AuralDsdProbe::notDsd;
    if(!read(0,header.data(),16)||std::memcmp(header.data()+12,"DSD ",4))return AuralDsdProbe::notDsd;
    const uint64_t body=be64(header.data()+4);
    if(body<4||body!=bytes-12)return AuralDsdProbe::invalid;
    result.container="dff";
    bool haveProperties=false,haveRate=false,haveChannels=false,haveCompression=false,haveData=false;
    uint64_t payload=0;unsigned chunks=0;
    const auto paddedNext=[](uint64_t start,uint64_t count,uint64_t limit,uint64_t& next){
        if(start>limit||count>limit-start)return false;next=start+count;
        if(count&1){if(next==limit)return false;++next;}return true;
    };
    for(uint64_t at=16;at<bytes;){
        if(++chunks>4096||!read(at,header.data(),12))return AuralDsdProbe::invalid;
        const uint64_t length=be64(header.data()+4),start=at+12;uint64_t next=0;
        if(!paddedNext(start,length,bytes,next))return AuralDsdProbe::invalid;
        if(!std::memcmp(header.data(),"DST ",4)){reason="DST 压缩 DFF 不属于 V1 支持范围";return AuralDsdProbe::unsupported;}
        if(!std::memcmp(header.data(),"DSD ",4)){
            if(haveData||!length)return AuralDsdProbe::invalid;haveData=true;payload=length;result.dataOffset=start;result.dataBytes=length;
        }else if(!std::memcmp(header.data(),"PROP",4)){
            if(haveProperties||length<4||!read(start,header.data(),4)||std::memcmp(header.data(),"SND ",4))return AuralDsdProbe::invalid;
            haveProperties=true;
            for(uint64_t sub=start+4;sub<start+length;){
                if(++chunks>4096||!read(sub,header.data(),12))return AuralDsdProbe::invalid;
                const uint64_t n=be64(header.data()+4),value=sub+12;uint64_t following=0;
                if(!paddedNext(value,n,start+length,following))return AuralDsdProbe::invalid;
                if(!std::memcmp(header.data(),"FS  ",4)){
                    if(haveRate||n!=4||!read(value,header.data(),4))return AuralDsdProbe::invalid;
                    result.bitRate=be32(header.data());haveRate=true;
                }else if(!std::memcmp(header.data(),"CHNL",4)){
                    if(haveChannels||n<2||!read(value,header.data(),2))return AuralDsdProbe::invalid;
                    result.channels=(uint32_t(header[0])<<8)|header[1];haveChannels=true;
                    if(!result.channels||result.channels>16||n!=2+uint64_t(result.channels)*4)return AuralDsdProbe::invalid;
                    if(!read(value+2,header.data(),result.channels*4))return AuralDsdProbe::invalid;
                    for(uint32_t ch=0;ch<result.channels;++ch)result.channelTags[ch]=be32(header.data()+ch*4);
                }else if(!std::memcmp(header.data(),"CMPR",4)){
                    if(haveCompression||n<4||!read(value,header.data(),4))return AuralDsdProbe::invalid;
                    if(!std::memcmp(header.data(),"DST ",4)){reason="DST 压缩 DFF 不属于 V1 支持范围";return AuralDsdProbe::unsupported;}
                    if(std::memcmp(header.data(),"DSD ",4)){reason="DFF 压缩编码尚未适配";return AuralDsdProbe::unsupported;}haveCompression=true;
                }
                sub=following;
            }
        }
        at=next;
    }
    if(!haveData||!haveRate||!haveChannels||!haveCompression||payload%result.channels||payload/result.channels>UINT64_MAX/8)return AuralDsdProbe::invalid;
    result.validBitSamples=payload/result.channels*8;
    if(!validRate(result.bitRate)){reason="当前转换适配 DSD64、DSD128 和 DSD256 的 44.1 kHz 速率族";return AuralDsdProbe::unsupported;}
    return AuralDsdProbe::valid;
}
