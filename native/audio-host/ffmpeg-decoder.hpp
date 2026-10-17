#pragma once
// First-party adapter. FFmpeg types stay inside the native decode boundary.
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/mem.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}
#include <windows.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>
#include "dsd-source-info.hpp"
#include "opus-gain.hpp"
#include "playback-file.hpp"

inline bool auralFfmpegRuntime() {
    // Imports are delay-loaded. Never resolve media DLLs from PATH or the working directory.
    static const bool ready=[](){
        wchar_t executable[32768]{};const DWORD size=GetModuleFileNameW(nullptr,executable,32768);
        if(!size||size>=32768)return false;
        std::wstring folder(executable,size);const auto separator=folder.find_last_of(L"\\/");
        if(separator==std::wstring::npos)return false;folder.resize(separator+1);
        for(const wchar_t* name:{L"avutil-60.dll",L"swresample-6.dll",L"avcodec-62.dll",L"avformat-62.dll"})
            if(!LoadLibraryExW((folder+name).c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32))return false;
        if((avutil_version()>>16)!=60||(avcodec_version()>>16)!=62||(avformat_version()>>16)!=62||(swresample_version()>>16)!=6)return false;
        av_log_set_level(AV_LOG_QUIET);av_max_alloc(32u*1024*1024);return true;
    }();return ready;
}

class AuralFfmpegDecoder {
    HANDLE file_=INVALID_HANDLE_VALUE;bool ownsFile_=false;
    AVFormatContext* demux_=nullptr;AVIOContext* io_=nullptr;AVCodecContext* codec_=nullptr;
    AVPacket* packet_=nullptr;AVFrame* frame_=nullptr;SwrContext* conversion_=nullptr;
    int stream_=-1;uint64_t deadline_=0,cursor_=0;bool draining_=false,eof_=false,apiAvailable_=false;
    int64_t origin_=AV_NOPTS_VALUE;AVRational timeBase_{};AVSampleFormat inputFormat_=AV_SAMPLE_FMT_NONE;
    AVChannelLayout layout_{};std::atomic<bool>* cancel_=nullptr;
    uint32_t inputRate_=0;uint64_t sourceDecodedFrames_=0,knownLength_=0;
    std::vector<uint8_t> block_;uint64_t blockFrames_=0,blockOffset_=0;
    std::vector<uint8_t> opusHeader_;
    int64_t verifiedOpusPage_=-1;
    static int interrupted(void* opaque){const auto* self=static_cast<AuralFfmpegDecoder*>(opaque);return (self->cancel_&&self->cancel_->load(std::memory_order_acquire))||GetTickCount64()>self->deadline_;}
    static int readFile(void* opaque,uint8_t* output,int wanted){
        auto* self=static_cast<AuralFfmpegDecoder*>(opaque);if(interrupted(self))return AVERROR_EXIT;
        DWORD got=0;if(wanted<=0||!ReadFile(self->file_,output,DWORD(wanted),&got,nullptr))return AVERROR(EIO);
        return got?int(got):AVERROR_EOF;
    }
    static int64_t seekFile(void* opaque,int64_t offset,int whence){
        auto* self=static_cast<AuralFfmpegDecoder*>(opaque);if(interrupted(self))return AVERROR_EXIT;
        if(whence&AVSEEK_SIZE){LARGE_INTEGER size{};return GetFileSizeEx(self->file_,&size)?size.QuadPart:AVERROR(EIO);}
        whence&=~AVSEEK_FORCE;DWORD origin;
        if(whence==SEEK_SET)origin=FILE_BEGIN;else if(whence==SEEK_CUR)origin=FILE_CURRENT;else if(whence==SEEK_END)origin=FILE_END;else return AVERROR(EINVAL);
        LARGE_INTEGER where{},result{};where.QuadPart=offset;
        return SetFilePointerEx(self->file_,where,&result,origin)?result.QuadPart:AVERROR(EIO);
    }
    ma_result nextBlock(int64_t* timestamp=nullptr){
        blockFrames_=blockOffset_=0;
        for(unsigned attempt=0;attempt<16384&&!interrupted(this);++attempt){
            const int received=avcodec_receive_frame(codec_,frame_);
            if(received==0){
                if((frame_->flags&AV_FRAME_FLAG_CORRUPT)||frame_->decode_error_flags||frame_->sample_rate!=int(inputRate_)||frame_->format!=inputFormat_||frame_->nb_samples<=0||frame_->nb_samples>65536||av_channel_layout_compare(&frame_->ch_layout,&layout_)!=0){av_frame_unref(frame_);return MA_INVALID_DATA;}
                if(dsd.bitRate&&(uint64_t(frame_->nb_samples)>dsd.validBitSamples/8||sourceDecodedFrames_>dsd.validBitSamples/8-uint64_t(frame_->nb_samples))){av_frame_unref(frame_);return MA_INVALID_DATA;}
                sourceDecodedFrames_+=frame_->nb_samples;
                const int64_t pts=frame_->best_effort_timestamp!=AV_NOPTS_VALUE?frame_->best_effort_timestamp:frame_->pts;
                if(timestamp)*timestamp=pts;
                const int capacity=dsd.bitRate?swr_get_out_samples(conversion_,frame_->nb_samples):frame_->nb_samples;
                if(capacity<=0||capacity>65536){av_frame_unref(frame_);return MA_INVALID_DATA;}
                block_.resize(size_t(capacity)*channels*ma_get_bytes_per_sample(format));
                uint8_t* outputs[]={block_.data()};
                const int converted=swr_convert(conversion_,outputs,capacity,const_cast<const uint8_t**>(frame_->extended_data),frame_->nb_samples);
                const int expected=frame_->nb_samples;av_frame_unref(frame_);
                // Ordinary PCM never changes rate/layout. DSD has an explicit fixed conversion profile.
                if(converted<0||converted>capacity||!dsd.bitRate&&(converted!=expected||swr_get_delay(conversion_,sampleRate)!=0))return MA_INVALID_DATA;
                if(format==ma_format_f32){const auto* samples=reinterpret_cast<const float*>(block_.data());for(size_t i=0;i<size_t(converted)*channels;++i)if(!std::isfinite(samples[i]))return MA_INVALID_DATA;}
                if(!converted)continue;blockFrames_=converted;return MA_SUCCESS;
            }
            if(received==AVERROR_EOF){
                if(dsd.bitRate){
                    if(sourceDecodedFrames_!=dsd.validBitSamples/8)return MA_INVALID_DATA;
                    const int capacity=swr_get_out_samples(conversion_,0);if(capacity<0||capacity>65536)return MA_INVALID_DATA;
                    if(capacity){
                        block_.resize(size_t(capacity)*channels*sizeof(float));uint8_t* outputs[]={block_.data()};
                        const int got=swr_convert(conversion_,outputs,capacity,nullptr,0);if(got<0||got>capacity)return MA_INVALID_DATA;
                        if(got){const auto* samples=reinterpret_cast<const float*>(block_.data());for(size_t i=0;i<size_t(got)*channels;++i)if(!std::isfinite(samples[i]))return MA_INVALID_DATA;blockFrames_=got;return MA_SUCCESS;}
                    }
                }
                eof_=true;return MA_AT_END;
            }
            if(received!=AVERROR(EAGAIN))return MA_INVALID_DATA;
            if(draining_)return MA_INVALID_DATA;
            bool sent=false;
            while(!sent&&!interrupted(this)){
                const int read=av_read_frame(demux_,packet_);
                if(read==AVERROR_EOF){draining_=true;const int result=avcodec_send_packet(codec_,nullptr);if(result<0&&result!=AVERROR_EOF)return MA_INVALID_DATA;sent=true;break;}
                if(read<0)return MA_IO_ERROR;
                if(packet_->size<0||packet_->size>8*1024*1024){av_packet_unref(packet_);return MA_INVALID_DATA;}
                if(packet_->stream_index==stream_){
                    if(opusGain.present){
                        const auto* stream=demux_->streams[stream_];const auto* parameters=stream->codecpar;
                        bool changed=packet_->pos<0||parameters->codec_id!=AV_CODEC_ID_OPUS||parameters->extradata_size!=int(opusHeader_.size())||!parameters->extradata||std::memcmp(parameters->extradata,opusHeader_.data(),opusHeader_.size())||(stream->event_flags&AVSTREAM_EVENT_FLAG_METADATA_UPDATED);
                        for(int i=0;i<packet_->side_data_elems;++i){const auto type=packet_->side_data[i].type;if(type==AV_PKT_DATA_NEW_EXTRADATA||type==AV_PKT_DATA_PARAM_CHANGE||type==AV_PKT_DATA_METADATA_UPDATE||type==AV_PKT_DATA_STRINGS_METADATA)changed=true;}
                        if(packet_->pos!=verifiedOpusPage_){if(!aural_opus::samePageStream(file_,packet_->pos,opusGain.serial,[this](){return interrupted(this)!=0;}))changed=true;else verifiedOpusPage_=packet_->pos;}
                        if(changed){failureReason="Opus 串接或播放中增益资料变化尚不支持";av_packet_unref(packet_);return MA_INVALID_DATA;}
                    }
                    const int result=avcodec_send_packet(codec_,packet_);av_packet_unref(packet_);if(result<0)return MA_INVALID_DATA;sent=true;
                }
                else av_packet_unref(packet_);
            }
        }
        return MA_IO_ERROR;
    }
public:
    ma_format format=ma_format_unknown,nativeIntegerFormat=ma_format_unknown;
    uint32_t channels=0,sampleRate=0,validBits=0;std::string codecName,containerName;int codecProfile=-99;
    AuralDsdInfo dsd;std::string failureReason;
    aural_opus::Info opusGain;
    std::array<ma_channel,16> channelMap{};
    AuralFfmpegDecoder()=default;AuralFfmpegDecoder(const AuralFfmpegDecoder&)=delete;AuralFfmpegDecoder& operator=(const AuralFfmpegDecoder&)=delete;
    ~AuralFfmpegDecoder(){close();}
    void close(){
        if(!apiAvailable_)return;
        swr_free(&conversion_);av_frame_free(&frame_);av_packet_free(&packet_);avcodec_free_context(&codec_);
        avformat_close_input(&demux_);if(io_){av_freep(&io_->buffer);avio_context_free(&io_);}
        av_channel_layout_uninit(&layout_);if(file_!=INVALID_HANDLE_VALUE){if(ownsFile_&&file_)CloseHandle(file_);file_=INVALID_HANDLE_VALUE;}ownsFile_=false;
        block_.clear();blockFrames_=blockOffset_=cursor_=0;origin_=AV_NOPTS_VALUE;stream_=-1;draining_=eof_=false;
        format=nativeIntegerFormat=ma_format_unknown;channels=sampleRate=validBits=0;codecName.clear();containerName.clear();codecProfile=-99;
        dsd={};opusGain={};opusHeader_.clear();verifiedOpusPage_=-1;inputRate_=0;sourceDecodedFrames_=0;knownLength_=0;
    }
    ma_result open(const std::wstring& filename,ma_format wanted,bool preferInteger,std::atomic<bool>* cancellation,bool allowDsdPcm=false){
        if(!auralFfmpegRuntime())return MA_NOT_IMPLEMENTED;
        std::wstring name=filename;
        if(name.rfind(L"\\\\?\\",0)!=0){if(name.rfind(L"\\\\",0)==0)name=L"\\\\?\\UNC\\"+name.substr(2);else if(name.size()>2&&name[1]==L':')name=L"\\\\?\\"+name;else return MA_INVALID_ARGS;}
        const HANDLE handle=CreateFileW(name.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(handle==INVALID_HANDLE_VALUE)return MA_DOES_NOT_EXIST;
        return openHandle(handle,wanted,preferInteger,cancellation,true,allowDsdPcm);
    }
    // Analysis borrows its already hashed and root-verified handle; never reopen by path.
    ma_result openHandle(HANDLE handle,ma_format wanted,bool preferInteger,std::atomic<bool>* cancellation,bool takeOwnership=false,bool allowDsdPcm=true){
        if(!auralFfmpegRuntime()){if(takeOwnership&&handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);return MA_NOT_IMPLEMENTED;}
        apiAvailable_=true;close();file_=handle;ownsFile_=takeOwnership;cancel_=cancellation;deadline_=GetTickCount64()+20000;
        if(file_==INVALID_HANDLE_VALUE||file_==nullptr)return MA_INVALID_ARGS;
        failureReason.clear();const auto probe=auralInspectDsd(file_,dsd,failureReason);
        if(probe==AuralDsdProbe::invalid){failureReason="DSD 容器长度、有效位数或参数校验失败";return MA_INVALID_DATA;}
        if(probe==AuralDsdProbe::unsupported)return MA_FORMAT_NOT_SUPPORTED;
        if(dsd.bitRate&&!allowDsdPcm){failureReason="DSD 需要明确选择转 PCM；原始格式／Native／DoP 尚未接入";return MA_FORMAT_NOT_SUPPORTED;}
        BY_HANDLE_FILE_INFORMATION info{};if(!GetFileInformationByHandle(file_,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))return MA_INVALID_FILE;
        LARGE_INTEGER zero{};if(!SetFilePointerEx(file_,zero,nullptr,FILE_BEGIN))return MA_BAD_SEEK;
        auto* buffer=static_cast<unsigned char*>(av_malloc(32768));if(!buffer)return MA_OUT_OF_MEMORY;
        io_=avio_alloc_context(buffer,32768,0,this,readFile,nullptr,seekFile);if(!io_){av_free(buffer);return MA_OUT_OF_MEMORY;}
        demux_=avformat_alloc_context();if(!demux_)return MA_OUT_OF_MEMORY;
        demux_->pb=io_;demux_->flags|=AVFMT_FLAG_CUSTOM_IO;demux_->interrupt_callback={interrupted,this};
        demux_->max_streams=16;demux_->probesize=2*1024*1024;demux_->max_analyze_duration=5*AV_TIME_BASE;
        demux_->format_whitelist=av_strdup("aac,mov,ogg,dsf,iff");if(!demux_->format_whitelist)return MA_OUT_OF_MEMORY;
        demux_->io_open=[](AVFormatContext*,AVIOContext**,const char*,int,AVDictionary**){return AVERROR(EACCES);};
        if(avformat_open_input(&demux_,nullptr,nullptr,nullptr)<0||avformat_find_stream_info(demux_,nullptr)<0)return MA_INVALID_FILE;
        const AVCodec* decoder=nullptr;stream_=av_find_best_stream(demux_,AVMEDIA_TYPE_AUDIO,-1,-1,&decoder,0);
        if(stream_<0||!decoder)return MA_INVALID_DATA;
        const std::string demuxName=demux_->iformat->name;containerName=demuxName=="aac"?"adts":demuxName=="ogg"?"ogg":demuxName=="dsf"?"dsf":demuxName=="iff"?"dff":demuxName.find("mov")!=std::string::npos?"mp4":"unknown";
        const auto id=decoder->id;const bool isDsd=id==AV_CODEC_ID_DSD_LSBF||id==AV_CODEC_ID_DSD_MSBF||id==AV_CODEC_ID_DSD_LSBF_PLANAR||id==AV_CODEC_ID_DSD_MSBF_PLANAR;
        if(id!=AV_CODEC_ID_AAC&&id!=AV_CODEC_ID_ALAC&&id!=AV_CODEC_ID_VORBIS&&id!=AV_CODEC_ID_OPUS&&!isDsd)return MA_FORMAT_NOT_SUPPORTED;
        if(isDsd!=(dsd.bitRate!=0))return MA_INVALID_DATA;
        if(id==AV_CODEC_ID_OPUS){
            const auto* parameters=demux_->streams[stream_]->codecpar;
            if(std::strcmp(decoder->name,"opus")||!demux_->iformat||std::strcmp(demux_->iformat->name,"ogg")||!aural_opus::read(file_,stream_,parameters->extradata,parameters->extradata_size,opusGain,[this](){return interrupted(this)!=0;})){
                failureReason="Opus 头部或原始增益标签无法验证（限 32 MiB 前缀／16 MiB 标签／4096 页）";return MA_INVALID_DATA;
            }
            opusHeader_.assign(parameters->extradata,parameters->extradata+parameters->extradata_size);
            demux_->streams[stream_]->event_flags&=~AVSTREAM_EVENT_FLAG_METADATA_UPDATED;
        }
        codec_=avcodec_alloc_context3(decoder);if(!codec_||avcodec_parameters_to_context(codec_,demux_->streams[stream_]->codecpar)<0)return MA_OUT_OF_MEMORY;
        codec_->thread_count=1;codec_->pkt_timebase=demux_->streams[stream_]->time_base;
        codec_->err_recognition=AV_EF_CRCCHECK|AV_EF_BITSTREAM|AV_EF_BUFFER|AV_EF_EXPLODE;
        if(avcodec_open2(codec_,decoder,nullptr)<0)return MA_INVALID_DATA;
        if(codec_->sample_rate<=0||codec_->sample_rate>(isDsd?1536000:768000)||codec_->ch_layout.nb_channels<=0||codec_->ch_layout.nb_channels>16)return MA_FORMAT_NOT_SUPPORTED;
        inputRate_=codec_->sample_rate;sampleRate=isDsd?auralDsdPcmRate:inputRate_;channels=codec_->ch_layout.nb_channels;inputFormat_=codec_->sample_fmt;timeBase_=codec_->pkt_timebase;
        if(isDsd&&(inputRate_*8!=dsd.bitRate||channels!=dsd.channels))return MA_INVALID_DATA;
        if(timeBase_.num<=0||timeBase_.den<=0)return MA_INVALID_DATA;
        if(av_channel_layout_copy(&layout_,&codec_->ch_layout)<0)return MA_OUT_OF_MEMORY;
        for(uint32_t i=0;i<channels;++i){
            switch(av_channel_layout_channel_from_index(&layout_,i)){
                case AV_CHAN_FRONT_LEFT:channelMap[i]=MA_CHANNEL_FRONT_LEFT;break;
                case AV_CHAN_FRONT_RIGHT:channelMap[i]=MA_CHANNEL_FRONT_RIGHT;break;
                case AV_CHAN_FRONT_CENTER:channelMap[i]=MA_CHANNEL_FRONT_CENTER;break;
                case AV_CHAN_LOW_FREQUENCY:channelMap[i]=MA_CHANNEL_LFE;break;
                case AV_CHAN_BACK_LEFT:channelMap[i]=MA_CHANNEL_BACK_LEFT;break;
                case AV_CHAN_BACK_RIGHT:channelMap[i]=MA_CHANNEL_BACK_RIGHT;break;
                case AV_CHAN_FRONT_LEFT_OF_CENTER:channelMap[i]=MA_CHANNEL_FRONT_LEFT_CENTER;break;
                case AV_CHAN_FRONT_RIGHT_OF_CENTER:channelMap[i]=MA_CHANNEL_FRONT_RIGHT_CENTER;break;
                case AV_CHAN_BACK_CENTER:channelMap[i]=MA_CHANNEL_BACK_CENTER;break;
                case AV_CHAN_SIDE_LEFT:channelMap[i]=MA_CHANNEL_SIDE_LEFT;break;
                case AV_CHAN_SIDE_RIGHT:channelMap[i]=MA_CHANNEL_SIDE_RIGHT;break;
                case AV_CHAN_TOP_CENTER:channelMap[i]=MA_CHANNEL_TOP_CENTER;break;
                case AV_CHAN_TOP_FRONT_LEFT:channelMap[i]=MA_CHANNEL_TOP_FRONT_LEFT;break;
                case AV_CHAN_TOP_FRONT_CENTER:channelMap[i]=MA_CHANNEL_TOP_FRONT_CENTER;break;
                case AV_CHAN_TOP_FRONT_RIGHT:channelMap[i]=MA_CHANNEL_TOP_FRONT_RIGHT;break;
                case AV_CHAN_TOP_BACK_LEFT:channelMap[i]=MA_CHANNEL_TOP_BACK_LEFT;break;
                case AV_CHAN_TOP_BACK_CENTER:channelMap[i]=MA_CHANNEL_TOP_BACK_CENTER;break;
                case AV_CHAN_TOP_BACK_RIGHT:channelMap[i]=MA_CHANNEL_TOP_BACK_RIGHT;break;
                default:return MA_FORMAT_NOT_SUPPORTED; // Unknown/ambisonic positions are not guessed.
            }
        }
        validBits=id==AV_CODEC_ID_ALAC?uint32_t(std::max(0,codec_->bits_per_raw_sample)):0;codecName=decoder->name;
        if(id==AV_CODEC_ID_ALAC&&validBits>=1&&validBits<=32){const auto packed=av_get_packed_sample_fmt(inputFormat_);if(packed==AV_SAMPLE_FMT_S16&&validBits<=16)nativeIntegerFormat=ma_format_s16;else if(packed==AV_SAMPLE_FMT_S32)nativeIntegerFormat=ma_format_s32;}
        format=isDsd?ma_format_f32:preferInteger&&nativeIntegerFormat!=ma_format_unknown?nativeIntegerFormat:wanted;
        const AVSampleFormat output=format==ma_format_s16?AV_SAMPLE_FMT_S16:format==ma_format_s32?AV_SAMPLE_FMT_S32:format==ma_format_f32?AV_SAMPLE_FMT_FLT:AV_SAMPLE_FMT_NONE;
        if(output==AV_SAMPLE_FMT_NONE)return MA_FORMAT_NOT_SUPPORTED;
        if(swr_alloc_set_opts2(&conversion_,&layout_,output,sampleRate,&layout_,inputFormat_,inputRate_,0,nullptr)<0)return MA_INVALID_DATA;
        if(isDsd&&(av_opt_set_int(conversion_,"filter_size",128,0)<0||av_opt_set_double(conversion_,"cutoff",.5,0)<0||av_opt_set_int(conversion_,"filter_type",SWR_FILTER_TYPE_KAISER,0)<0||av_opt_set_double(conversion_,"kaiser_beta",9.,0)<0))return MA_INVALID_DATA;
        if(swr_init(conversion_)<0)return MA_INVALID_DATA;
        frame_=av_frame_alloc();packet_=av_packet_alloc();if(!frame_||!packet_)return MA_OUT_OF_MEMORY;
        codecProfile=codec_->profile;
        // Decoder handles leading priming; exact MP4 duration additionally bounds residual tail padding.
        const auto first=nextBlock(&origin_);if(first!=MA_SUCCESS)return first;
        const auto* stream=demux_->streams[stream_];
        // Some AAC/MP4 decodes leave a partial final codec frame. An exact
        // authoritative stream duration bounds it without trimming twice.
        if(id==AV_CODEC_ID_AAC&&containerName=="mp4"&&stream->duration>0&&stream->start_time==origin_){
            const auto frames=av_rescale_q(stream->duration,stream->time_base,AVRational{1,int(sampleRate)});
            if(frames>0&&av_rescale_q(frames,AVRational{1,int(sampleRate)},stream->time_base)==stream->duration)knownLength_=uint64_t(frames);
        }
        return MA_SUCCESS;
    }
    ma_result read(void* output,ma_uint64 wanted,ma_uint64* got){
        *got=0;deadline_=GetTickCount64()+20000;const size_t bytes=size_t(channels)*ma_get_bytes_per_sample(format);
        while(*got<wanted){
            if(knownLength_&&cursor_>=knownLength_)return MA_AT_END;
            if(blockOffset_==blockFrames_){if(eof_)return MA_AT_END;const auto result=nextBlock();if(result!=MA_SUCCESS)return result;}
            const auto count=std::min<uint64_t>(std::min<uint64_t>(wanted-*got,blockFrames_-blockOffset_),knownLength_?knownLength_-cursor_:UINT64_MAX);
            std::memcpy(static_cast<uint8_t*>(output)+size_t(*got)*bytes,block_.data()+size_t(blockOffset_)*bytes,size_t(count)*bytes);
            *got+=count;blockOffset_+=count;cursor_+=count;
        }return MA_SUCCESS;
    }
    ma_result replaySeek(ma_uint64 target,bool force=false){
        if(force||target<cursor_){
            const HANDLE handle=file_;const bool ownership=ownsFile_;auto* cancellation=cancel_;const auto selected=format;const bool isDsd=dsd.bitRate!=0;ownsFile_=false;
            if(openHandle(handle,selected,selected!=ma_format_f32,cancellation,ownership,isDsd)!=MA_SUCCESS)return MA_BAD_SEEK;
        }
        const uint64_t limit=GetTickCount64()+20000;std::vector<uint8_t> scratch(size_t(4096)*channels*ma_get_bytes_per_sample(format));
        while(cursor_<target&&!interrupted(this)&&GetTickCount64()<=limit){ma_uint64 got=0;const auto result=read(scratch.data(),std::min<uint64_t>(4096,target-cursor_),&got);if(!got||(result!=MA_SUCCESS&&result!=MA_AT_END))return MA_BAD_SEEK;}
        return cursor_==target?MA_SUCCESS:MA_BAD_SEEK;
    }
    ma_result length(ma_uint64* result)const{if(!knownLength_)return MA_NOT_IMPLEMENTED;*result=knownLength_;return MA_SUCCESS;}
    ma_result seek(ma_uint64 target){
        deadline_=GetTickCount64()+20000;
        if(knownLength_&&target>=knownLength_)return MA_BAD_SEEK;
        // AAC noise synthesis/priming state is not reconstructed by codec flush.
        // Preserve it on forward seeks and replay the pinned origin backwards.
        if(!dsd.bitRate&&(codecName=="aac"||codecName!="alac"&&target<=uint64_t(sampleRate)*2))return replaySeek(target);
        const auto result=indexedSeek(target);return result==MA_SUCCESS||dsd.bitRate?result:replaySeek(target,true);
    }
    ma_result indexedSeek(ma_uint64 target){
        // Initial codec priming is reconstructed from the original demuxer state.
        // A timestamp-zero demux seek is not equivalent to reopening the stream.
        if(dsd.bitRate){
            // Stateful DSD FIR has no decoder flush hook. Reinitialize and discard from the actual origin.
            const HANDLE handle=file_;const bool ownership=ownsFile_;auto* cancellation=cancel_;ownsFile_=false;
            if(openHandle(handle,ma_format_f32,false,cancellation,ownership,true)!=MA_SUCCESS)return MA_BAD_SEEK;
            const uint64_t limit=GetTickCount64()+20000;std::vector<float> scratch(size_t(2048)*channels);uint64_t done=0;
            while(done<target&&GetTickCount64()<=limit){ma_uint64 got=0;const auto wanted=std::min<uint64_t>(2048,target-done);const auto result=read(scratch.data(),wanted,&got);if(!got||(result!=MA_SUCCESS&&result!=MA_AT_END))return MA_BAD_SEEK;done+=got;}
            return done==target?MA_SUCCESS:MA_BAD_SEEK;
        }
        if(target>INT64_MAX||origin_==AV_NOPTS_VALUE)return MA_BAD_SEEK;
        deadline_=GetTickCount64()+20000;
        const auto preRoll=target>uint64_t(sampleRate)*2?target-uint64_t(sampleRate)*2:0;
        const int64_t offset=av_rescale_q(int64_t(preRoll),AVRational{1,int(sampleRate)},timeBase_);
        if(offset<0||origin_>INT64_MAX-offset)return MA_BAD_SEEK;
        if(avformat_seek_file(demux_,stream_,INT64_MIN,origin_+offset,origin_+offset,AVSEEK_FLAG_BACKWARD)<0)return MA_BAD_SEEK;
        avcodec_flush_buffers(codec_);swr_close(conversion_);if(swr_init(conversion_)<0)return MA_BAD_SEEK;
        draining_=eof_=false;blockFrames_=blockOffset_=0;verifiedOpusPage_=-1;
        while(!interrupted(this)){
            int64_t pts=AV_NOPTS_VALUE;const auto result=nextBlock(&pts);if(result!=MA_SUCCESS)return MA_BAD_SEEK;
            if(pts==AV_NOPTS_VALUE||origin_>0&&pts<INT64_MIN+origin_||origin_<0&&pts>INT64_MAX+origin_)return MA_BAD_SEEK;
            const int64_t begin=av_rescale_q(pts-origin_,timeBase_,AVRational{1,int(sampleRate)});
            if(begin>=0&&uint64_t(begin)>target)return MA_BAD_SEEK;
            const auto drop=begin<0?target+uint64_t(-(begin+1))+1:target-uint64_t(begin);
            if(drop>=blockFrames_)continue;
            blockOffset_=drop;cursor_=target;return MA_SUCCESS;
        }return MA_BAD_SEEK;
    }
};

class AuralPcmDecoder {
    AuralPlaybackFile ownedFile_;
    HANDLE sourceHandle_=INVALID_HANDLE_VALUE;ma_vfs* sourceVfs_=nullptr;
    std::atomic<bool>* cancel_=nullptr;bool allowDsd_=false;
    ma_decoder builtin_{};bool builtinReady_=false,extendedReady_=false;uint64_t logicalCursor_=0;
    AuralFfmpegDecoder extended_;
    void builtinCodec(){
        codecName="builtin-unknown";
        #ifndef MA_NO_WAV
        if(builtin_.pBackendVTable==&g_ma_decoding_backend_vtable_wav)codecName="wav";
        #endif
        #ifndef MA_NO_FLAC
        if(builtin_.pBackendVTable==&g_ma_decoding_backend_vtable_flac)codecName="flac";
        #endif
        #ifndef MA_NO_MP3
        if(builtin_.pBackendVTable==&g_ma_decoding_backend_vtable_mp3)codecName="mp3";
        #endif
    }

public:
    ma_format outputFormat=ma_format_unknown,nativeIntegerFormat=ma_format_unknown;
    uint32_t outputChannels=0,outputSampleRate=0;std::string backend="miniaudio",codecName,containerName;
    AuralDsdInfo dsd;std::string failureReason;
    aural_opus::Info opusGain;
    ~AuralPcmDecoder(){uninit();}
    nlohmann::json sourceEvidence()const{
        const char* encoding="unknown",*evidence="unknown";uint32_t valid=0,container=0;
        if(builtinReady_){
            #ifndef MA_NO_WAV
            if(builtin_.pBackendVTable==&g_ma_decoding_backend_vtable_wav){
                const auto& wav=static_cast<const ma_wav*>(builtin_.pBackend)->dr;
                if(wav.translatedFormatTag==MA_DR_WAVE_FORMAT_PCM||wav.translatedFormatTag==MA_DR_WAVE_FORMAT_IEEE_FLOAT){
                    encoding=wav.translatedFormatTag==MA_DR_WAVE_FORMAT_PCM?"pcm-integer":"pcm-float";container=wav.bitsPerSample;
                    valid=wav.fmt.formatTag==MA_DR_WAVE_FORMAT_EXTENSIBLE?wav.fmt.validBitsPerSample:container;evidence="decoder-header";
                    if(container<1||container>64||valid>container){container=valid=0;encoding="unknown";evidence="unknown";}
                }else{encoding="lossy";evidence="decoder-header";}
            }
            #endif
            #ifndef MA_NO_FLAC
            if(builtin_.pBackendVTable==&g_ma_decoding_backend_vtable_flac){
                const auto* flac=static_cast<const ma_flac*>(builtin_.pBackend)->dr;
                if(flac&&flac->bitsPerSample>=1&&flac->bitsPerSample<=32){encoding="lossless-integer";valid=flac->bitsPerSample;evidence="decoder-header";}
            }
            #endif
            #ifndef MA_NO_MP3
            if(builtin_.pBackendVTable==&g_ma_decoding_backend_vtable_mp3){encoding="lossy";evidence="decoder-header";}
            #endif
        }else if(extendedReady_){
            evidence="codec-context";
            if(dsd.bitRate)encoding="dsd";
            else if(codecName=="alac"){encoding="lossless-integer";if(extended_.validBits>=1&&extended_.validBits<=32)valid=extended_.validBits;}
            else if(codecName=="aac"||codecName=="vorbis"||codecName=="opus")encoding="lossy";
            else evidence="unknown";
        }
        const std::string kind=encoding;
        const char* conversion=kind=="pcm-integer"||kind=="lossless-integer"?(outputFormat==ma_format_f32?"integer-to-float":"integer-output"):kind=="pcm-float"?"float-output":kind=="lossy"?"lossy-decode":kind=="dsd"?"dsd-to-pcm":"unknown";
        return {{"version",1},{"encoding",encoding},{"validBits",valid?nlohmann::json(valid):nlohmann::json(nullptr)},{"containerBits",container?nlohmann::json(container):nlohmann::json(nullptr)},{"evidence",evidence},{"decoderConversion",conversion}};
    }
    nlohmann::json containerEvidence()const{return {{"version",1},{"family",containerName},{"profile",extendedReady_&&extended_.codecProfile!=-99?nlohmann::json(extended_.codecProfile):nlohmann::json(nullptr)}};}
    nlohmann::json fileBinding()const{return ownedFile_.binding();}
    ma_result validateSource(){return ownedFile_.handle!=INVALID_HANDLE_VALUE?ownedFile_.begin(true):MA_SUCCESS;}
    void closeCodec(){
        if(builtinReady_)ma_decoder_uninit(&builtin_);if(extendedReady_)extended_.close();builtinReady_=extendedReady_=false;
        outputFormat=nativeIntegerFormat=ma_format_unknown;outputChannels=outputSampleRate=0;backend="miniaudio";codecName.clear();containerName.clear();dsd={};opusGain={};failureReason.clear();
    }
    ma_result openCodec(ma_format wanted,bool preferInteger){
        closeCodec();logicalCursor_=0;if(sourceHandle_==INVALID_HANDLE_VALUE||!sourceVfs_)return MA_INVALID_OPERATION;
        if(ownedFile_.handle!=INVALID_HANDLE_VALUE){const auto rc=ownedFile_.begin(true);if(rc!=MA_SUCCESS)return rc;}
        const auto reset=[&](){LARGE_INTEGER zero{};return SetFilePointerEx(sourceHandle_,zero,nullptr,FILE_BEGIN)!=FALSE;};
        if(!reset())return MA_BAD_SEEK;
        auto config=ma_decoder_config_init(preferInteger?ma_format_s32:wanted,0,0);
        auto result=ma_decoder_init_vfs(sourceVfs_,ownedFile_.handle!=INVALID_HANDLE_VALUE?"aural-playback":"locked-media",&config,&builtin_);
        if(result==MA_SUCCESS){
            builtinReady_=true;builtinCodec();containerName=codecName;outputFormat=builtin_.outputFormat;outputChannels=builtin_.outputChannels;outputSampleRate=builtin_.outputSampleRate;
            const auto evidence=sourceEvidence();const std::string encoding=evidence.at("encoding").get<std::string>();
            const unsigned valid=evidence.at("validBits").is_null()?0:evidence.at("validBits").get<unsigned>();
            const unsigned container=evidence.at("containerBits").is_null()?0:evidence.at("containerBits").get<unsigned>();
            ma_format candidate=ma_format_unknown;
            if(valid>=1&&valid<=32&&(encoding=="pcm-integer"||encoding=="lossless-integer")){
                // A padded WAV container retains all declared container bits. FLAC is packed from its valid bits.
                const unsigned storage=encoding=="pcm-integer"?container:valid;
                if(storage>=1&&storage<=32&&(encoding!="pcm-integer"||storage==8||storage==16||storage==24||storage==32))candidate=storage<=16?ma_format_s16:ma_format_s32;
            }
            const auto selected=preferInteger&&candidate!=ma_format_unknown?candidate:wanted;
            if(outputFormat!=selected){
                const auto codec=codecName;const auto rate=outputSampleRate,channels=outputChannels;
                ma_decoder_uninit(&builtin_);builtinReady_=false;if(!reset())return MA_BAD_SEEK;
                config=ma_decoder_config_init(selected,0,0);
                result=ma_decoder_init_vfs(sourceVfs_,ownedFile_.handle!=INVALID_HANDLE_VALUE?"aural-playback":"locked-media",&config,&builtin_);
                if(result!=MA_SUCCESS)return result;
                builtinReady_=true;builtinCodec();containerName=codecName;outputFormat=builtin_.outputFormat;outputChannels=builtin_.outputChannels;outputSampleRate=builtin_.outputSampleRate;
                auto currentEvidence=sourceEvidence(),expectedEvidence=evidence;currentEvidence.erase("decoderConversion");expectedEvidence.erase("decoderConversion");
                if(codecName!=codec||outputSampleRate!=rate||outputChannels!=channels||currentEvidence!=expectedEvidence)return MA_INVALID_DATA;
            }
            // A decoder-level channel/format converter must not silently qualify as an integer path.
            // Reuse the opened source for a declared float fallback; original mode rejects that plan.
            if(preferInteger&&candidate!=ma_format_unknown&&!builtin_.converter.isPassthrough)return openCodec(wanted,false);
            nativeIntegerFormat=builtin_.converter.isPassthrough?candidate:ma_format_unknown;
            if(outputFormat!=selected)return MA_INVALID_DATA;
            if(ownedFile_.ioError!=MA_SUCCESS)return ownedFile_.ioError;
            return MA_SUCCESS;
        }
        if(ownedFile_.ioError!=MA_SUCCESS)return ownedFile_.ioError;
        const auto expanded=extended_.openHandle(sourceHandle_,wanted,preferInteger,cancel_,false,allowDsd_);
        if(expanded!=MA_SUCCESS){failureReason=extended_.failureReason;extended_.close();return expanded;}
        extendedReady_=true;outputFormat=extended_.format;outputChannels=extended_.channels;outputSampleRate=extended_.sampleRate;
        nativeIntegerFormat=extended_.nativeIntegerFormat;backend="ffmpeg-8.1.3";codecName=extended_.codecName;containerName=extended_.containerName;dsd=extended_.dsd;opusGain=extended_.opusGain;return MA_SUCCESS;
    }
    ma_result init(const std::wstring& filename,ma_format format,bool preferInteger,std::atomic<bool>* cancel,bool allowDsdPcm=false){
        uninit();const auto rc=ownedFile_.open(filename,cancel);if(rc!=MA_SUCCESS)return rc;
        sourceHandle_=ownedFile_.handle;sourceVfs_=&ownedFile_;cancel_=cancel;allowDsd_=allowDsdPcm;return openCodec(format,preferInteger);
    }
    ma_result reconfigure(ma_format format,bool preferInteger){return openCodec(format,preferInteger);}
    // Waveform analysis borrows its existing hashed/root-verified file and stays f32.
    ma_result initHandle(HANDLE handle,ma_vfs* vfs,std::atomic<bool>* cancel=nullptr){
        uninit();sourceHandle_=handle;sourceVfs_=vfs;cancel_=cancel;allowDsd_=true;return openCodec(ma_format_f32,false);
    }
    void uninit(){closeCodec();ownedFile_.close();sourceHandle_=INVALID_HANDLE_VALUE;sourceVfs_=nullptr;cancel_=nullptr;allowDsd_=false;}
    ma_result read(void* output,ma_uint64 frames,ma_uint64* got){
        *got=0;if(ownedFile_.handle!=INVALID_HANDLE_VALUE){const auto rc=ownedFile_.begin();if(rc!=MA_SUCCESS)return rc;}
        const auto rc=builtinReady_?ma_decoder_read_pcm_frames(&builtin_,output,frames,got):extendedReady_?extended_.read(output,frames,got):MA_INVALID_OPERATION;
        if(ownedFile_.handle!=INVALID_HANDLE_VALUE){if(ownedFile_.ioError!=MA_SUCCESS)return ownedFile_.ioError;if(!ownedFile_.allowed())return MA_CANCELLED;}
        if(builtinReady_&&codecName=="mp3")logicalCursor_+=*got;return rc;
    }
    ma_result seek(ma_uint64 frame){
        if(ownedFile_.handle!=INVALID_HANDLE_VALUE){const auto rc=ownedFile_.begin(true);if(rc!=MA_SUCCESS)return rc;}
        if(builtinReady_&&codecName=="mp3"){
            if(frame<logicalCursor_){const auto selected=outputFormat;if(openCodec(selected,false)!=MA_SUCCESS)return MA_BAD_SEEK;}
            const auto limit=GetTickCount64()+20000;std::vector<uint8_t> scratch(size_t(4096)*outputChannels*ma_get_bytes_per_sample(outputFormat));
            while(logicalCursor_<frame&&GetTickCount64()<=limit){ma_uint64 got=0;const auto result=read(scratch.data(),std::min<uint64_t>(4096,frame-logicalCursor_),&got);if(!got||(result!=MA_SUCCESS&&result!=MA_AT_END))return MA_BAD_SEEK;}
            return logicalCursor_==frame?MA_SUCCESS:MA_BAD_SEEK;
        }
        const auto rc=builtinReady_?ma_decoder_seek_to_pcm_frame(&builtin_,frame):extendedReady_?extended_.seek(frame):MA_INVALID_OPERATION;
        if(ownedFile_.handle!=INVALID_HANDLE_VALUE){if(ownedFile_.ioError!=MA_SUCCESS)return ownedFile_.ioError;if(!ownedFile_.allowed())return MA_CANCELLED;}
        return rc;
    }
    ma_result length(ma_uint64* length){return builtinReady_?ma_decoder_get_length_in_pcm_frames(&builtin_,length):extendedReady_?extended_.length(length):MA_NOT_IMPLEMENTED;}
    ma_channel* channelMap(){return extendedReady_?extended_.channelMap.data():nullptr;}
};
