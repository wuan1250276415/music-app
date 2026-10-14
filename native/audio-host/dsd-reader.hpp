#pragma once
#include "dsd-source-info.hpp"
#include "dsd-block.hpp"
#include <algorithm>
#include <atomic>
#include <vector>

namespace aural_dsd {
enum class ReadStatus {success,end,cancelled,timedOut,ioError,invalid,unsupported};
class Reader {
    HANDLE file_=INVALID_HANDLE_VALUE;bool owns_=false;
    AuralDsdInfo info_{};uint64_t tick_=0,cacheAt_=UINT64_MAX,deadline_=0;
    std::vector<uint8_t> cache_;std::atomic<bool>* cancel_=nullptr;
    bool interrupted()const{return cancel_&&cancel_->load(std::memory_order_acquire)||GetTickCount64()>deadline_;}
    ReadStatus interruptedStatus()const{return cancel_&&cancel_->load(std::memory_order_acquire)?ReadStatus::cancelled:ReadStatus::timedOut;}
    bool load(uint64_t at,size_t count){
        if(interrupted()||at>INT64_MAX||at<info_.dataOffset||at-info_.dataOffset>info_.dataBytes||count>info_.dataBytes-(at-info_.dataOffset))return false;
        LARGE_INTEGER position{};position.QuadPart=int64_t(at);DWORD got=0;cache_.resize(count);
        if(!SetFilePointerEx(file_,position,nullptr,FILE_BEGIN)||!ReadFile(file_,cache_.data(),DWORD(count),&got,nullptr)||got!=count)return false;
        cacheAt_=at;return !interrupted();
    }
    bool byteAt(uint64_t frame,uint32_t channel,uint8_t& value){
        const uint64_t total=info_.validBitSamples/8+(info_.validBitSamples%8?1:0);
        if(frame>=total){value=0x69;return true;}
        uint64_t at,group;size_t groupBytes;
        if(info_.planar){
            const uint64_t stride=uint64_t(info_.blockBytes)*info_.channels;
            group=info_.dataOffset+(frame/info_.blockBytes)*stride;groupBytes=size_t(stride);
            at=group+uint64_t(channel)*info_.blockBytes+frame%info_.blockBytes;
        }else{
            const uint64_t offset=frame*info_.channels+channel;
            group=info_.dataOffset+(offset/65536)*65536;
            groupBytes=size_t(std::min<uint64_t>(65536,info_.dataBytes-(group-info_.dataOffset)));
            at=info_.dataOffset+offset;
        }
        if(cacheAt_!=group&&!load(group,groupBytes))return false;
        if(at<cacheAt_||at-cacheAt_>=cache_.size())return false;
        value=cache_[size_t(at-cacheAt_)];if(info_.lsbFirst)value=reverseByte(value);
        if(frame==total-1&&info_.validBitSamples%8){const uint8_t mask=uint8_t(0xffu<<(8-info_.validBitSamples%8));value=uint8_t((value&mask)|(0x69&~mask));}
        return true;
    }
public:
    Reader()=default;Reader(const Reader&)=delete;Reader& operator=(const Reader&)=delete;
    ~Reader(){close();}
    void close(){if(owns_&&file_!=INVALID_HANDLE_VALUE&&file_)CloseHandle(file_);file_=INVALID_HANDLE_VALUE;owns_=false;info_={};tick_=0;cacheAt_=UINT64_MAX;cache_.clear();cancel_=nullptr;}
    ReadStatus openHandle(HANDLE handle,bool takeOwnership=false,std::atomic<bool>* cancellation=nullptr){
        close();file_=handle;owns_=takeOwnership;cancel_=cancellation;deadline_=GetTickCount64()+20000;
        if(!handle||handle==INVALID_HANDLE_VALUE)return ReadStatus::invalid;
        BY_HANDLE_FILE_INFORMATION attributes{};if(!GetFileInformationByHandle(handle,&attributes)||attributes.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)return ReadStatus::invalid;
        std::string reason;const auto result=auralInspectDsd(handle,info_,reason,true);
        if(result!=AuralDsdProbe::valid){const auto status=result==AuralDsdProbe::unsupported||result==AuralDsdProbe::notDsd?ReadStatus::unsupported:ReadStatus::invalid;close();return status;}
        if(interrupted()){const auto status=interruptedStatus();close();return status;}return ReadStatus::success;
    }
    const AuralDsdInfo& info()const{return info_;}
    uint64_t cursorTick()const{return tick_;}
    bool atEnd()const{return info_.bitRate&&tick_==info_.validBitSamples;}
    ReadStatus seekTick(uint64_t value){if(file_==INVALID_HANDLE_VALUE||!info_.bitRate||value>info_.validBitSamples)return ReadStatus::invalid;tick_=value;return ReadStatus::success;}
    ReadStatus read(uint32_t maximumByteFrames,RawBlock& result){
        result={};if(file_==INVALID_HANDLE_VALUE||!info_.bitRate||!maximumByteFrames||maximumByteFrames>4096)return ReadStatus::invalid;
        result.bitRate=info_.bitRate;result.channels=info_.channels;result.startTick=tick_;
        if(atEnd())return ReadStatus::end;deadline_=GetTickCount64()+20000;
        if(cancel_&&cancel_->load(std::memory_order_acquire))return ReadStatus::cancelled;
        const uint64_t remaining=info_.validBitSamples-tick_;
        result.byteFrames=uint32_t(std::min<uint64_t>(maximumByteFrames,remaining/8+(remaining%8?1:0)));
        result.validBitsPerChannel=std::min<uint64_t>(remaining,uint64_t(result.byteFrames)*8);
        result.bytes.resize(size_t(result.byteFrames)*info_.channels);
        for(uint32_t frame=0;frame<result.byteFrames;++frame){
            const uint64_t position=tick_+uint64_t(frame)*8;const unsigned shift=unsigned(position%8);
            for(uint32_t ch=0;ch<info_.channels;++ch){
                uint8_t a=0,b=0;if(!byteAt(position/8,ch,a)||shift&&!byteAt(position/8+1,ch,b)){result.bytes.clear();return interrupted()?interruptedStatus():ReadStatus::ioError;}
                uint8_t value=shift?uint8_t((unsigned(a)<<shift)|(unsigned(b)>>(8-shift))):a;
                const unsigned valid=unsigned(std::min<uint64_t>(8,info_.validBitSamples-position));
                if(valid<8){const uint8_t mask=uint8_t(0xffu<<(8-valid));value=uint8_t((value&mask)|(silenceAt(position)&~mask));}
                result.bytes[size_t(frame)*info_.channels+ch]=value;
            }
        }
        tick_+=result.validBitsPerChannel;return ReadStatus::success;
    }
};
}
