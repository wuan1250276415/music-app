#pragma once
#include "asio-backend.hpp"
#include "dsd-reader.hpp"
#include <atomic>
#include <cstring>
#include <stdexcept>
#include <thread>

namespace aural_asio {
// One frozen source range, one producer and one render consumer. The caller
// owns the bound file handle and must retire Engine callbacks before this ring.
class DsdStream final {
    static constexpr size_t memoryBudget=32*1024*1024;
    DWORD owner_=GetCurrentThreadId();
    aural_dsd::Reader reader_;
    std::vector<uint8_t> ring_;
    std::thread producer_;
    std::atomic<bool> cancel_{false},finished_{true},eof_{false},failed_{false};
    std::atomic<uint64_t> written_{0},read_{0};
    std::atomic<aural_dsd::ReadStatus> status_{aural_dsd::ReadStatus::invalid};
    AuralDsdInfo info_;
    uint64_t firstTick_=0,totalBits_=0,totalBytes_=0,capacity_=0;
    bool dop_=false,started_=false,opened_=false,openUsed_=false;
    void produce() noexcept {
        try{
            uint64_t written=0;
            while(!cancel_.load(std::memory_order_acquire)&&written<totalBytes_){
                const auto read=read_.load(std::memory_order_acquire);
                if(read>written||written-read>capacity_)throw std::runtime_error("DSD ring indices are invalid");
                const auto free=capacity_-(written-read);
                if(!free){Sleep(2);continue;}
                const auto wanted=uint32_t(std::min<uint64_t>(4096,std::min(free,totalBytes_-written)));
                aural_dsd::RawBlock block;
                const auto result=reader_.read(wanted,block);
                if(result!=aural_dsd::ReadStatus::success){status_=result;failed_=result!=aural_dsd::ReadStatus::cancelled;break;}
                const auto remaining=totalBits_-written*8;
                const auto valid=std::min<uint64_t>(remaining,uint64_t(block.byteFrames)*8);
                if(!block.byteFrames||block.byteFrames>wanted||block.startTick!=firstTick_+written*8||block.bitRate!=info_.bitRate||
                    block.channels!=info_.channels||block.bytes.size()!=size_t(block.byteFrames)*info_.channels||
                    block.validBitsPerChannel<valid||valid<=uint64_t(block.byteFrames-1)*8)
                    throw std::runtime_error("DSD reader returned an inconsistent source block");
                // A range can end before the physical source ends. Remove all
                // out-of-range bits before they enter the playback ring.
                if(valid%8){const uint8_t mask=uint8_t(0xffu<<(8-unsigned(valid%8))),quiet=aural_dsd::silenceAt(firstTick_);
                    for(uint32_t channel=0;channel<info_.channels;++channel){auto& byte=block.bytes[size_t(block.byteFrames-1)*info_.channels+channel];byte=uint8_t((byte&mask)|(quiet&~mask));}}
                const auto first=std::min<uint64_t>(block.byteFrames,capacity_-written%capacity_);
                std::memcpy(ring_.data()+size_t(written%capacity_)*info_.channels,block.bytes.data(),size_t(first)*info_.channels);
                if(first<block.byteFrames)std::memcpy(ring_.data(),block.bytes.data()+size_t(first)*info_.channels,size_t(block.byteFrames-first)*info_.channels);
                written+=block.byteFrames;written_.store(written,std::memory_order_release);
            }
            if(!cancel_.load(std::memory_order_acquire)&&!failed_.load(std::memory_order_acquire)&&written==totalBytes_){status_=aural_dsd::ReadStatus::end;eof_.store(true,std::memory_order_release);}
            else if(cancel_.load(std::memory_order_acquire))status_=aural_dsd::ReadStatus::cancelled;
        }catch(...){status_=aural_dsd::ReadStatus::invalid;failed_.store(true,std::memory_order_release);}
        finished_.store(true,std::memory_order_release);
    }
public:
    DsdStream()=default;
    DsdStream(const DsdStream&)=delete;DsdStream& operator=(const DsdStream&)=delete;
    ~DsdStream() noexcept {if(!close()){TerminateProcess(GetCurrentProcess(),70);std::terminate();}}
    void open(HANDLE boundFile,uint32_t expectedRate,uint32_t expectedChannels,uint64_t firstTick,uint64_t endTick,DsdTransport transport){
        if(GetCurrentThreadId()!=owner_||openUsed_||started_)throw std::runtime_error("DSD source requires a fresh owning-thread stream");
        openUsed_=true;
        if(transport!=DsdTransport::nativeDsd&&transport!=DsdTransport::dop)throw std::runtime_error("DSD transport is invalid");
        const auto result=reader_.openHandle(boundFile,false,&cancel_);
        if(result!=aural_dsd::ReadStatus::success)throw std::runtime_error("DSD source container is unavailable, invalid or unsupported");
        info_=reader_.info();
        if(info_.bitRate!=expectedRate||info_.channels!=expectedChannels||firstTick>=endTick||endTick>info_.validBitSamples)
            throw std::runtime_error("DSD source format or approved range changed");
        if(reader_.seekTick(firstTick)!=aural_dsd::ReadStatus::success)throw std::runtime_error("DSD source position is invalid");
        firstTick_=firstTick;totalBits_=endTick-firstTick;totalBytes_=totalBits_/8+(totalBits_%8?1:0);
        capacity_=memoryBudget/info_.channels;ring_.resize(size_t(capacity_)*info_.channels);dop_=transport==DsdTransport::dop;
        status_=aural_dsd::ReadStatus::success;opened_=true;
    }
    void start(){
        if(GetCurrentThreadId()!=owner_||!opened_||started_)throw std::runtime_error("DSD producer is not eligible to start");
        started_=true;finished_.store(false,std::memory_order_release);
        try{producer_=std::thread([this]{produce();});}catch(...){finished_=true;failed_=true;status_=aural_dsd::ReadStatus::invalid;throw;}
    }
    DsdReadResult consume(uint8_t* output,uint32_t maximum) noexcept {
        DsdReadResult result;
        if(!opened_||!started_||!output||!maximum||maximum>65536||failed_.load(std::memory_order_acquire)||cancel_.load(std::memory_order_acquire))return result;
        const auto read=read_.load(std::memory_order_relaxed),written=written_.load(std::memory_order_acquire);
        if(read>written||written>totalBytes_||written-read>capacity_){failed_.store(true,std::memory_order_release);status_=aural_dsd::ReadStatus::invalid;return result;}
        if(read==totalBytes_){result.terminal=true;return result;}
        uint64_t count=std::min<uint64_t>(maximum,written-read);
        if(dop_&&count%2&&read+count!=totalBytes_)--count; // Keep an unfinished DoP pair in the ring.
        const auto first=std::min<uint64_t>(count,capacity_-read%capacity_);
        if(first)std::memcpy(output,ring_.data()+size_t(read%capacity_)*info_.channels,size_t(first)*info_.channels);
        if(count>first)std::memcpy(output+size_t(first)*info_.channels,ring_.data(),size_t(count-first)*info_.channels);
        result.byteFrames=uint32_t(count);result.validBitsPerChannel=std::min<uint64_t>(count*8,totalBits_-read*8);
        result.terminal=read+count==totalBytes_;read_.store(read+count,std::memory_order_release);return result;
    }
    static DsdReadResult renderRead(void* context,uint8_t* output,uint32_t frames) noexcept {return static_cast<DsdStream*>(context)->consume(output,frames);}
    uint64_t availableByteFrames() const noexcept {const auto written=written_.load(std::memory_order_acquire),read=read_.load(std::memory_order_acquire);return read<=written?written-read:0;}
    uint64_t writtenByteFrames() const noexcept {return written_.load(std::memory_order_acquire);}
    uint64_t capacityByteFrames() const noexcept {return capacity_;}
    uint64_t consumedSourceBits() const noexcept {const auto read=read_.load(std::memory_order_acquire);return read==totalBytes_?totalBits_:read*8;}
    bool eof() const noexcept {return eof_.load(std::memory_order_acquire);}
    bool failed() const noexcept {return failed_.load(std::memory_order_acquire);}
    aural_dsd::ReadStatus status() const noexcept {return status_.load(std::memory_order_acquire);}
    const AuralDsdInfo& info() const noexcept {return info_;}
    bool close() noexcept {
        if(GetCurrentThreadId()!=owner_)return false;
        cancel_.store(true,std::memory_order_release);
        if(producer_.joinable()){
            const auto deadline=GetTickCount64()+2000;
            while(!finished_.load(std::memory_order_acquire)){
                CancelSynchronousIo(producer_.native_handle());if(GetTickCount64()>=deadline)return false;Sleep(1);
            }
            producer_.join();
        }
        reader_.close();opened_=false;return true;
    }
};
}
