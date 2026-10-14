#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>

// Called only by the output callback. The producer publishes writeFrames after
// copying PCM into the ring; seek resets the cursors while the device is stopped.
template <typename Buffer>
void consumePcmFrames(Buffer& buffer,void* output,uint32_t frameCount) {
    buffer.callbackCount.fetch_add(1,std::memory_order_relaxed);
    auto* dst=static_cast<uint8_t*>(output);
    const uint64_t read=buffer.readFrames.load(std::memory_order_relaxed);
    const uint64_t written=buffer.writeFrames.load(std::memory_order_acquire);
    const uint64_t available=written>=read?written-read:0;
    uint64_t count=std::min<uint64_t>(available,frameCount);
    const uint64_t absoluteRead=buffer.positionBaseFrames.load(std::memory_order_relaxed)+read;
    if(buffer.boundaryRelativeFrame!=UINT64_MAX &&
       absoluteRead<buffer.boundaryRelativeFrame && count>=buffer.boundaryRelativeFrame-absoluteRead){
        int expected=0;
        if(buffer.boundaryState.compare_exchange_strong(expected,1,std::memory_order_acq_rel))
            buffer.boundaryReached.store(true,std::memory_order_release);
    }
    if(buffer.boundaryState.load(std::memory_order_acquire)==2){
        const uint64_t remaining=absoluteRead<buffer.boundaryRelativeFrame?
            buffer.boundaryRelativeFrame-absoluteRead:0;
        count=std::min(count,remaining);
    }
    if(count<frameCount && !buffer.eof.load(std::memory_order_acquire) &&
       buffer.boundaryState.load(std::memory_order_acquire)!=2 &&
       read<buffer.maxFrames && count<buffer.maxFrames-read){
        buffer.bufferUnderrunCallbacks.fetch_add(1,std::memory_order_relaxed);
        buffer.bufferUnderrunFrames.fetch_add(frameCount-count,std::memory_order_relaxed);
    }
    const uint64_t first=std::min<uint64_t>(count,buffer.capacityFrames-(read%buffer.capacityFrames));
    if(first)std::memcpy(dst,buffer.ring.data()+(read%buffer.capacityFrames)*buffer.bytesPerFrame,
                         first*buffer.bytesPerFrame);
    if(count>first)std::memcpy(dst+first*buffer.bytesPerFrame,buffer.ring.data(),
                              (count-first)*buffer.bytesPerFrame);
    if(count<frameCount)std::memset(dst+count*buffer.bytesPerFrame,0,
                                   (frameCount-count)*buffer.bytesPerFrame);
    buffer.readFrames.store(read+count,std::memory_order_release);
    if(buffer.boundaryState.load(std::memory_order_acquire)==2 &&
       absoluteRead+count>=buffer.boundaryRelativeFrame)
        buffer.finished.store(true,std::memory_order_release);
    if(buffer.eof.load(std::memory_order_acquire)&&read+count==written)
        buffer.finished.store(true,std::memory_order_release);
}
