#pragma once
#include "cue-frames.hpp"

struct CueTwoSpanPlan {
    uint64_t startPcmFrame;
    uint64_t boundaryPcmFrame;
    uint64_t endPcmFrame;
};

inline bool cueTwoSpanPlan(uint64_t firstStartCue,uint64_t firstEndCue,
                           uint64_t secondStartCue,uint64_t secondEndCue,
                           uint32_t sampleRate,CueTwoSpanPlan& plan) {
    if(firstStartCue>=firstEndCue || secondStartCue!=firstEndCue || secondEndCue<=secondStartCue)
        return false;
    if(!cueToPcmFrame(firstStartCue,sampleRate,plan.startPcmFrame) ||
       !cueToPcmFrame(firstEndCue,sampleRate,plan.boundaryPcmFrame) ||
       !cueToPcmFrame(secondEndCue,sampleRate,plan.endPcmFrame))return false;
    return plan.startPcmFrame<plan.boundaryPcmFrame && plan.boundaryPcmFrame<plan.endPcmFrame;
}
