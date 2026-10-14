#define NOMINMAX
#define MA_NO_DEVICE_IO
#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include "vendor/json.hpp"
#include "ffmpeg-decoder.hpp"
#include "playback-file.hpp"
#include "dsd-reader.hpp"
#include "analysis-tap.hpp"
#include "release.hpp"
#include <io.h>
#include <fcntl.h>
#include <iostream>
#include <stdexcept>
using json=nlohmann::json;
namespace {
constexpr const char* profile="raw-window-dsd96-swr128-kaiser9-c0.5-preroll8192-v1";
constexpr uint32_t rate=176400;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
bool fields(const json& value,std::initializer_list<const char*> names){if(!value.is_object()||value.size()!=names.size())return false;for(auto name:names)if(!value.contains(name))return false;return true;}
uint64_t tick(const json& value){require(value.is_string(),"tick must be a string");const auto s=value.get<std::string>();require(!s.empty()&&s.size()<=20&&(s.size()==1||s[0]!='0'),"invalid tick");uint64_t n=0;for(char c:s){require(c>='0'&&c<='9'&&n<=(UINT64_MAX-uint64_t(c-'0'))/10,"tick overflow");n=n*10+c-'0';}return n;}
std::string text(const json& value,size_t limit){require(value.is_string(),"text required");const auto s=value.get<std::string>();require(!s.empty()&&s.size()<=limit&&std::none_of(s.begin(),s.end(),[](unsigned char c){return c<32||c==127;}),"invalid text");return s;}
bool uuid(const std::string& s){if(s.size()!=36)return false;for(size_t i=0;i<s.size();++i){if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}else if(!std::isxdigit(static_cast<unsigned char>(s[i])))return false;}return true;}
std::wstring wide(const std::string& s){const int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0);require(n>0,"invalid path UTF8");std::wstring w(n,0);require(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),w.data(),n)==n,"invalid path UTF8");return w;}
bool receive(json& value){uint8_t h[4];if(!std::cin.read(reinterpret_cast<char*>(h),4)){require(std::cin.gcount()==0,"truncated prefix");return false;}const uint32_t n=uint32_t(h[0])|(uint32_t(h[1])<<8)|(uint32_t(h[2])<<16)|(uint32_t(h[3])<<24);require(n&&n<=65536,"input budget exceeded");std::string body(n,0);require(bool(std::cin.read(body.data(),n)),"truncated input");value=json::parse(body);return true;}
void send(const json& value){const auto s=value.dump();require(s.size()<=16384,"output budget exceeded");const uint32_t n=uint32_t(s.size());const char h[4]={char(n),char(n>>8),char(n>>16),char(n>>24)};std::cout.write(h,4);std::cout.write(s.data(),s.size());std::cout.flush();require(bool(std::cout),"output unavailable");}
json sourceInfo(const AuralDsdInfo& h,const json& binding){json tags=json::array();for(uint32_t i=0;i<h.channels;++i)tags.push_back(h.channelTags[i]);return {{"kind","dsd-msb-first-interleaved"},{"container",h.container},{"bitRate",h.bitRate},{"channels",h.channels},{"totalTicks",std::to_string(h.validBitSamples)},{"layoutCode",h.layoutCode},{"channelTags",tags},{"storage",{{"planar",h.planar},{"lsbFirst",h.lsbFirst},{"blockBytes",h.blockBytes}}},{"payload",{{"offset",std::to_string(h.dataOffset)},{"bytes",std::to_string(h.dataBytes)}}},{"fileBinding",binding}};}
struct Codec {
    AVCodecContext* codec=nullptr;AVPacket* packet=nullptr;AVFrame* frame=nullptr;SwrContext* swr=nullptr;AVChannelLayout layout{};
    ~Codec(){if(swr)swr_free(&swr);av_frame_free(&frame);av_packet_free(&packet);avcodec_free_context(&codec);av_channel_layout_uninit(&layout);}
    Codec(uint32_t channels,uint32_t bitRate){
        const auto* decoder=avcodec_find_decoder(AV_CODEC_ID_DSD_MSBF);require(decoder!=nullptr,"DSD decoder unavailable");
        codec=avcodec_alloc_context3(decoder);require(codec!=nullptr,"codec allocation failed");av_channel_layout_default(&layout,int(channels));
        require(av_channel_layout_copy(&codec->ch_layout,&layout)>=0,"layout allocation failed");codec->sample_rate=int(bitRate/8);codec->thread_count=1;
        require(avcodec_open2(codec,decoder,nullptr)>=0&&codec->sample_fmt==AV_SAMPLE_FMT_FLTP,"DSD decoder layout unsupported");
        require(swr_alloc_set_opts2(&swr,&layout,AV_SAMPLE_FMT_FLT,rate,&layout,AV_SAMPLE_FMT_FLTP,bitRate/8,0,nullptr)>=0,"SWR allocation failed");
        require(av_opt_set_int(swr,"filter_size",128,0)>=0&&av_opt_set_double(swr,"cutoff",.5,0)>=0&&av_opt_set_int(swr,"filter_type",SWR_FILTER_TYPE_KAISER,0)>=0&&av_opt_set_double(swr,"kaiser_beta",9.,0)>=0,"SWR profile unavailable");
        require(swr_init(swr)>=0,"SWR init failed");packet=av_packet_alloc();frame=av_frame_alloc();require(packet&&frame,"decode allocation failed");
    }
    void append(std::vector<float>& output,const uint8_t** input,int count,uint32_t channels){
        std::vector<float> block(size_t(16384)*channels);uint8_t* dst=reinterpret_cast<uint8_t*>(block.data());const int got=swr_convert(swr,&dst,16384,input,count);
        require(got>=0&&output.size()+size_t(got)*channels<=size_t(32768)*channels,"converted window budget exceeded");output.insert(output.end(),block.begin(),block.begin()+size_t(got)*channels);
    }
    void drain(std::vector<float>& output,uint32_t channels){while(true){const int result=avcodec_receive_frame(codec,frame);if(result==AVERROR(EAGAIN)||result==AVERROR_EOF)break;require(result>=0&&frame->format==AV_SAMPLE_FMT_FLTP&&frame->ch_layout.nb_channels==int(channels)&&frame->nb_samples>0&&frame->nb_samples<=4096,"unexpected decoded frame");append(output,const_cast<const uint8_t**>(frame->extended_data),frame->nb_samples,channels);av_frame_unref(frame);}}
};
}
int main(){
    _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);SetPriorityClass(GetCurrentProcess(),PROCESS_MODE_BACKGROUND_BEGIN);
    try{
        json init;require(receive(init)&&fields(init,{"version","kind","buildId","nonce","sessionId","generation","itemId","parentPid","path","source","range"}),"invalid init");
        require(init.at("version")==1&&init.at("kind")=="init"&&init.at("buildId")==aural_release::main_build_id,"build mismatch");
        const auto nonce=text(init.at("nonce"),36),session=text(init.at("sessionId"),36);require(uuid(nonce)&&uuid(session),"invalid session identity");text(init.at("itemId"),128);
        require(init.at("generation").is_number_unsigned()&&init.at("generation").get<uint64_t>()>0&&init.at("generation").get<uint64_t>()<=9007199254740991ull,"invalid generation");
        require(init.at("parentPid").is_number_unsigned(),"invalid owner");const uint64_t pid=init.at("parentPid").get<uint64_t>();require(pid&&pid<=UINT32_MAX,"invalid owner");
        HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,DWORD(pid));require(parent!=nullptr,"owner unavailable");std::thread([parent](){WaitForSingleObject(parent,INFINITE);ExitProcess(3);}).detach();
        require(auralFfmpegRuntime(),"FFmpeg runtime unavailable");
        struct File:AuralPlaybackFile{~File(){close();}} file;require(file.open(wide(text(init.at("path"),32767)),nullptr)==MA_SUCCESS,"copy file unavailable");
        aural_dsd::Reader reader;require(reader.openHandle(file.handle)==aural_dsd::ReadStatus::success,"raw copy header unavailable");const auto h=reader.info();
        require(h.channels&&h.channels<=16&&(h.bitRate==2822400||h.bitRate==5644800||h.bitRate==11289600),"analysis rate unsupported");
        const auto source=sourceInfo(h,file.binding());require(source==init.at("source"),"copy source differs from approved playback");
        const auto range=init.at("range");require(fields(range,{"startTick","endTick","initialTick"}),"invalid range");const uint64_t start=tick(range.at("startTick")),end=tick(range.at("endTick")),initial=tick(range.at("initialTick"));
        require(start<end&&end<=h.validBitSamples&&initial<end-start,"range outside source");
        json identity={{"version",1},{"buildId",aural_release::host_build_id},{"nonce",nonce},{"sessionId",session},{"generation",init.at("generation")},{"itemId",init.at("itemId")},{"profile",profile}};
        auto ready=identity;ready["kind"]="ready";ready["source"]=source;ready["range"]=range;send(ready);
        uint64_t sequence=0;const uint64_t ratio=h.bitRate/rate,warm=8192/(ratio/8);
        json request;
        while(receive(request)){
            require(fields(request,{"version","kind","nonce","sessionId","generation","requestId","sequence","positionTick"})&&request.at("version")==1&&request.at("kind")=="window"&&request.at("nonce")==nonce&&request.at("sessionId")==session&&request.at("generation")==init.at("generation"),"window identity mismatch");
            require(uuid(text(request.at("requestId"),36)),"invalid request identity");const auto next=tick(request.at("sequence"));require(sequence<UINT64_MAX&&next==sequence+1,"invalid request sequence");sequence=next;
            const uint64_t position=tick(request.at("positionTick"));require(position<=end-start,"window position outside range");
            auto reply=identity;reply["requestId"]=request.at("requestId");reply["sequence"]=request.at("sequence");reply["positionTick"]=request.at("positionTick");
            const uint64_t last=(start+position)/ratio,firstValid=start/ratio+(start%ratio?1:0);
            if(last<firstValid+2048){reply["kind"]="warming-up";send(reply);continue;}
            const uint64_t windowStart=last-2048,decodeStart=windowStart>warm?windowStart-warm:0,decodeEnd=std::min(h.validBitSamples/ratio,last+warm);
            require(decodeEnd>decodeStart&&decodeEnd-decodeStart<=32768&&reader.seekTick(decodeStart*ratio)==aural_dsd::ReadStatus::success&&file.begin(true)==MA_SUCCESS,"copy window unavailable");
            Codec codec(h.channels,h.bitRate);std::vector<float> pcm;pcm.reserve(size_t(decodeEnd-decodeStart)*h.channels);
            const uint64_t stop=decodeEnd*ratio;
            while(reader.cursorTick()<stop){aural_dsd::RawBlock raw;const uint32_t count=uint32_t(std::min<uint64_t>(4096,(stop-reader.cursorTick())/8));require(count&&reader.read(count,raw)==aural_dsd::ReadStatus::success&&raw.validBitsPerChannel==uint64_t(count)*8&&raw.bytes.size()==size_t(count)*h.channels,"incomplete raw window");
                require(av_new_packet(codec.packet,int(raw.bytes.size()))>=0,"packet allocation failed");std::memcpy(codec.packet->data,raw.bytes.data(),raw.bytes.size());require(avcodec_send_packet(codec.codec,codec.packet)>=0,"DSD packet rejected");av_packet_unref(codec.packet);codec.drain(pcm,h.channels);}
            require(avcodec_send_packet(codec.codec,nullptr)>=0,"decoder flush failed");codec.drain(pcm,h.channels);for(int i=0;i<16;++i){const auto before=pcm.size();codec.append(pcm,nullptr,0,h.channels);if(before==pcm.size())break;require(i<15,"conversion drain exceeded");}
            const size_t offset=size_t(windowStart-decodeStart)*h.channels;require(offset+size_t(2048)*h.channels<=pcm.size()&&file.begin(true)==MA_SUCCESS&&file.binding()==source.at("fileBinding"),"converted window incomplete or file changed");
            const auto analysis=aural_analysis::Tap::floatWindow(pcm.data()+offset,h.channels,rate,last);
            reply["kind"]="window";reply["windowStartFrame"]=std::to_string(windowStart);reply["windowEndFrame"]=std::to_string(last);reply["sampleRate"]=rate;reply["channels"]=h.channels;reply["windowFrames"]=2048;
            reply["peakDb"]=json::array();reply["rmsDb"]=json::array();for(uint32_t ch=0;ch<h.channels;++ch){reply["peakDb"].push_back(analysis.peakDb[ch]);reply["rmsDb"].push_back(analysis.rmsDb[ch]);}reply["spectrumDb"]=analysis.spectrumDb;reply["waveform"]=analysis.waveform;reply["invalidSamples"]=analysis.invalidSamples;send(reply);
        }
        return 0;
    }catch(const std::exception& e){std::cerr<<"DSD analysis copy: "<<e.what()<<"\n";return 2;}catch(...){return 2;}
}
