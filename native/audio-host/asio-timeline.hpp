#pragma once
#include "asio-backend.hpp"
#include <array>
#include <atomic>
#include <algorithm>
#include <cstdint>

namespace aural_asio_session {
// The sole render producer records only successfully published planes. The STA
// consumer maps callback sample positions plus the prepared output latency.
// Callback count, ring consumption and a filled plane are not presentation.
class Timeline {
    struct Span {uint64_t source=0,position=0,time=0;uint32_t frames=0,music=0;bool clock=false;};
    static constexpr uint64_t capacity=8192;
    std::array<Span,capacity> spans{};
    std::atomic<uint64_t> write{0},read{0};std::atomic<bool> overflow{false};
    uint64_t mapped=0,reported=0,seenPosition=0,seenTime=0,lastMusicEnd=0,publishedMusic=0;
    uint64_t observed=0,stable=0;
    bool hasTime=false,hasMusic=false,allMusicTimed=true,badPosition=false;
public:
    struct Reading {uint64_t source=0,device=0,time=0,publishedMusic=0,lastMusicEnd=0;bool mapped=false,musicTimed=false,healthy=true;};
    void reset(uint64_t source){mapped=reported=source;}
    void publish(const aural_asio::RenderObservation& value,uint64_t source) noexcept {
        const auto w=write.load(std::memory_order_relaxed),r=read.load(std::memory_order_acquire);
        if(w-r>=capacity){overflow.store(true,std::memory_order_release);return;}
        spans[w%capacity]={source,value.samplePosition,value.systemTimeNs,value.frames,value.musicFrames,value.clockValid};
        write.store(w+1,std::memory_order_release);
    }
    Reading observe(const aural_asio::Snapshot& snapshot,uint64_t consumed,uint32_t latency) {
        auto r=read.load(std::memory_order_relaxed);const auto w=write.load(std::memory_order_acquire);
        // Scan new publications once. Future presentation spans stay available
        // until their corresponding hardware boundary has passed.
        for(uint64_t cursor=observed;cursor<w;++cursor){
            const auto& span=spans[cursor%capacity];publishedMusic+=span.music;
            if(span.music){hasMusic=true;
                if(!span.clock||span.position>UINT64_MAX-latency||span.music>UINT64_MAX-span.position-latency)allMusicTimed=false;
                else lastMusicEnd=span.position+latency+span.music;
            }
            if(!span.clock){stable=0;hasTime=false;continue;}
            if(hasTime&&(span.position<seenPosition||(cursor>=2&&span.position==seenPosition)))badPosition=true;
            // Startup commonly reports the same wall time for the first two
            // switches; wait for three advancing time/position observations.
            if(hasTime&&span.position>seenPosition&&span.time>seenTime)++stable;else stable=0;
            seenPosition=span.position;seenTime=span.time;hasTime=true;
        }
        observed=w;
        const bool usable=snapshot.clockValid&&hasTime&&stable>=3&&!badPosition;
        bool located=false;
        while(r<w){
            const auto& span=spans[r%capacity];
            if(!span.clock||span.position>UINT64_MAX-latency){++r;continue;}
            const auto begin=span.position+latency;
            if(!usable){++r;continue;}
            if(snapshot.samplePosition<begin){located=true;break;}
            const auto offset=snapshot.samplePosition-begin;
            const auto value=span.source+std::min<uint64_t>(offset,span.music);
            mapped=std::max(mapped,value);located=true;
            if(offset<span.frames)break;
            ++r;
        }
        read.store(r,std::memory_order_release);
        const bool inTimeline=usable&&located&&mapped<=consumed;
        const bool valid=inTimeline&&mapped>=reported;
        // Hold an earlier callback estimate until real presentation catches
        // it. Advancing to consumed again here would perpetually outrun ASIO.
        if(valid)reported=mapped;else if(!inTimeline)reported=std::max(reported,consumed);
        return {reported,snapshot.samplePosition,snapshot.systemTimeNs,publishedMusic,lastMusicEnd,valid,
            hasMusic&&allMusicTimed, !overflow.load(std::memory_order_acquire)&&!badPosition};
    }
};
}
