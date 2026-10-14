#pragma once
#include <cstdint>

inline bool cueToPcmFrame(uint64_t cueFrame,uint32_t sampleRate,uint64_t& pcmFrame) {
    if (sampleRate==0 || cueFrame>UINT64_MAX/sampleRate) return false;
    pcmFrame=cueFrame*sampleRate/75;
    return true;
}
