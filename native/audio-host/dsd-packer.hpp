#pragma once
#include "dsd-block.hpp"
#include <algorithm>
#include <array>
#include <string>
namespace aural_dsd {
enum class TransportKind {nativeDsd,dop};
enum class NativeFormat {msbFirst,lsbFirst};
enum class DopFormat {s24le,s32leLeftAligned24};
struct TransportBlock {
    TransportKind kind=TransportKind::nativeDsd;
    uint32_t bitRate=0,channels=0,storageRate=0,frames=0,bytesPerSample=0;
    uint64_t sourceStartTick=0,validSourceBitsPerChannel=0;
    bool protocolSilence=false;
    std::vector<uint8_t> interleaved;
    std::vector<std::vector<uint8_t>> planes;
};
inline bool validRawBlock(const RawBlock& input){
    return input.kind==BlockKind::rawDsdMsbFirst&&input.channels>0&&input.channels<=16&&
        (input.bitRate==2822400||input.bitRate==5644800||input.bitRate==11289600)&&input.byteFrames<=4096&&
        input.bytes.size()==size_t(input.byteFrames)*input.channels&&input.validBitsPerChannel<=uint64_t(input.byteFrames)*8&&
        (!input.byteFrames?input.validBitsPerChannel==0:input.validBitsPerChannel>uint64_t(input.byteFrames-1)*8)&&
        input.startTick<=UINT64_MAX-input.validBitsPerChannel;
}
inline uint8_t normalizedByte(const RawBlock& input,uint32_t frame,uint32_t channel){
    uint8_t value=input.bytes[size_t(frame)*input.channels+channel];const uint64_t used=uint64_t(frame)*8;
    const unsigned valid=unsigned(std::min<uint64_t>(8,input.validBitsPerChannel-used));
    if(valid<8){const uint8_t mask=uint8_t(0xffu<<(8-valid));value=uint8_t((value&mask)|(silenceAt(input.startTick+used)&~mask));}return value;
}
inline bool packNative(const RawBlock& input,NativeFormat format,TransportBlock& output){
    output={};if(!validRawBlock(input)||(format!=NativeFormat::msbFirst&&format!=NativeFormat::lsbFirst))return false;
    output.kind=TransportKind::nativeDsd;output.bitRate=input.bitRate;output.channels=input.channels;
    output.storageRate=input.bitRate/8;output.frames=input.byteFrames;output.bytesPerSample=1;
    output.sourceStartTick=input.startTick;output.validSourceBitsPerChannel=input.validBitsPerChannel;
    output.planes.resize(input.channels);for(auto& plane:output.planes)plane.resize(input.byteFrames);
    for(uint32_t frame=0;frame<input.byteFrames;++frame)for(uint32_t ch=0;ch<input.channels;++ch){const auto value=normalizedByte(input,frame,ch);output.planes[ch][frame]=format==NativeFormat::msbFirst?value:reverseByte(value);}
    return true;
}
inline bool nativeSilence(uint32_t bitRate,uint32_t channels,uint32_t frames,NativeFormat format,TransportBlock& output){
    RawBlock raw;raw.bitRate=bitRate;raw.channels=channels;raw.byteFrames=frames;raw.validBitsPerChannel=uint64_t(frames)*8;
    if(frames>4096||!channels||channels>16)return false;raw.bytes.assign(size_t(frames)*channels,0x69);
    if(!packNative(raw,format,output))return false;output.validSourceBitsPerChannel=0;output.protocolSilence=true;return true;
}
class DopPacker {
    uint32_t rate_=0,channels_=0;DopFormat format_=DopFormat::s24le;
    uint64_t expectedTick_=0,firstTick_=0,carrierFrames_=0;
    std::array<uint8_t,16> pending_{};unsigned pendingBits_=0;
    bool markerHigh_=false,ended_=false;
    bool emit(const std::array<uint8_t,16>& older,const std::array<uint8_t,16>& newer,TransportBlock& result){
        if(carrierFrames_==UINT64_MAX)return false;const uint8_t marker=markerHigh_?0xfa:0x05;
        for(uint32_t ch=0;ch<channels_;++ch){
            // Oldest bit occupies payload bit 15: little-endian storage writes the newer byte first.
            if(format_==DopFormat::s32leLeftAligned24)result.interleaved.push_back(0);
            result.interleaved.push_back(newer[ch]);result.interleaved.push_back(older[ch]);result.interleaved.push_back(marker);
        }
        markerHigh_=!markerHigh_;++carrierFrames_;++result.frames;return true;
    }
    void describe(TransportBlock& result,bool silence=false){result={};result.kind=TransportKind::dop;result.bitRate=rate_;result.channels=channels_;result.storageRate=rate_/16;result.bytesPerSample=format_==DopFormat::s24le?3:4;result.sourceStartTick=expectedTick_;result.protocolSilence=silence;}
public:
    bool reset(uint32_t rate,uint32_t channels,uint64_t firstTick,DopFormat format=DopFormat::s24le){
        rate_=0;if((rate!=2822400&&rate!=5644800&&rate!=11289600)||!channels||channels>16||(format!=DopFormat::s24le&&format!=DopFormat::s32leLeftAligned24))return false;
        rate_=rate;channels_=channels;format_=format;firstTick_=expectedTick_=firstTick;carrierFrames_=0;pendingBits_=0;markerHigh_=false;ended_=false;return true;
    }
    bool encode(const RawBlock& input,bool final,TransportBlock& result){
        result={};if(!rate_||ended_||!validRawBlock(input)||input.bitRate!=rate_||input.channels!=channels_||input.startTick!=expectedTick_||!final&&input.validBitsPerChannel%8)return false;
        const uint64_t available=uint64_t(input.byteFrames)+(pendingBits_?1:0),frames=available/2+(final&&available%2?1:0);
        if(carrierFrames_>UINT64_MAX-frames)return false;
        describe(result);if(pendingBits_)result.sourceStartTick-=pendingBits_;
        const unsigned before=pendingBits_;uint64_t represented=input.validBitsPerChannel+before;
        result.interleaved.reserve(size_t((input.byteFrames+2)/2)*channels_*result.bytesPerSample);
        for(uint32_t frame=0;frame<input.byteFrames;++frame){
            std::array<uint8_t,16> next{};for(uint32_t ch=0;ch<channels_;++ch)next[ch]=normalizedByte(input,frame,ch);
            const unsigned bits=unsigned(std::min<uint64_t>(8,input.validBitsPerChannel-uint64_t(frame)*8));
            if(!pendingBits_){pending_=next;pendingBits_=bits;}
            else {if(!emit(pending_,next,result))return false;pendingBits_=0;}
        }
        expectedTick_+=input.validBitsPerChannel;
        if(final&&pendingBits_){std::array<uint8_t,16> padding{};padding.fill(silenceAt((expectedTick_%8+8-pendingBits_)%8));if(!emit(pending_,padding,result))return false;pendingBits_=0;}
        if(final)ended_=true;
        result.validSourceBitsPerChannel=represented-pendingBits_;
        return true;
    }
    bool silence(uint32_t frames,TransportBlock& result){
        result={};if(!rate_||frames>4096||carrierFrames_>UINT64_MAX-frames)return false;describe(result,true);result.sourceStartTick-=pendingBits_;
        std::array<uint8_t,16> quiet{};quiet.fill(silenceAt(firstTick_));
        result.interleaved.reserve(size_t(frames)*channels_*result.bytesPerSample);
        for(uint32_t frame=0;frame<frames;++frame)if(!emit(quiet,quiet,result))return false;return true;
    }
    uint64_t carrierFrameCount()const{return carrierFrames_;}
};
}
