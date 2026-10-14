#pragma once
#include "dsd-source-info.hpp"
#include "vendor/json.hpp"
inline nlohmann::json auralDsdDescription(const AuralDsdInfo& source){
    if(!source.bitRate)return nullptr;
    return {{"kind","dsd-to-pcm"},{"container",source.container},{"bitRate",source.bitRate},
        {"validBitSamples",std::to_string(source.validBitSamples)},{"intermediateRate",source.bitRate/8},
        {"pcmRate",auralDsdPcmRate},{"gainDb",0},{"profile",auralDsdPcmProfile},{"delayCompensation","pending"}};
}
