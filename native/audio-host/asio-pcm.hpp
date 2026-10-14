#pragma once
#include "../asio-probe/vendor/asio.h"
#include "asio-backend.hpp"
#include <cmath>
#include <cstring>
#include <limits>

namespace aural_asio {
struct Layout {
    uint32_t bytes = 0, bits = 0;
    bool floating = false, bigEndian = false, rightAligned = false;
};
inline Layout layout(ASIOSampleType type) noexcept {
    switch(type) {
    case ASIOSTInt16MSB: return {2,16,false,true,false};
    case ASIOSTInt24MSB: return {3,24,false,true,false};
    case ASIOSTInt32MSB: return {4,32,false,true,false};
    case ASIOSTFloat32MSB: return {4,32,true,true,false};
    case ASIOSTFloat64MSB: return {8,64,true,true,false};
    case ASIOSTInt16LSB: return {2,16,false,false,false};
    case ASIOSTInt24LSB: return {3,24,false,false,false};
    case ASIOSTInt32LSB: return {4,32,false,false,false};
    case ASIOSTFloat32LSB: return {4,32,true,false,false};
    case ASIOSTFloat64LSB: return {8,64,true,false,false};
    // SDK 2.3 specification pp.33-34: right aligned, high bits sign extended.
    case ASIOSTInt32MSB16: return {4,16,false,true,true};
    case ASIOSTInt32MSB18: return {4,18,false,true,true};
    case ASIOSTInt32MSB20: return {4,20,false,true,true};
    case ASIOSTInt32MSB24: return {4,24,false,true,true};
    case ASIOSTInt32LSB16: return {4,16,false,false,true};
    case ASIOSTInt32LSB18: return {4,18,false,false,true};
    case ASIOSTInt32LSB20: return {4,20,false,false,true};
    case ASIOSTInt32LSB24: return {4,24,false,false,true};
    default: return {}; // DSD is a different transport, never PCM silence/packing.
    }
}
inline uint32_t sourceBytes(PcmFormat f) noexcept {
    switch(f){case PcmFormat::s16:return 2;case PcmFormat::s24:return 3;
    case PcmFormat::s32:case PcmFormat::f32:return 4;case PcmFormat::f64:return 8;}
    return 0;
}
inline bool floating(PcmFormat f) noexcept {return f==PcmFormat::f32||f==PcmFormat::f64;}
inline bool exactPacking(const SourceFormat& source,const Layout& output) noexcept {
    if(!output.bytes)return false;
    if(floating(source.format))return output.floating&&output.bytes==sourceBytes(source.format);
    return !output.floating&&output.bits>=source.validBits;
}
inline uint64_t littleWord(const uint8_t* source,uint32_t bytes) noexcept {
    uint64_t word=0;for(uint32_t i=0;i<bytes;++i)word|=uint64_t(source[i])<<(i*8);return word;
}
inline void storeWord(uint8_t* target,uint64_t word,const Layout& output) noexcept {
    for(uint32_t i=0;i<output.bytes;++i)target[output.bigEndian?output.bytes-1-i:i]=uint8_t(word>>(i*8));
}
struct PackCounters {uint64_t saturated=0,nonfinite=0;bool invalidPadding=false;};
inline void packSample(const uint8_t* input,uint8_t* target,const SourceFormat& source,
                       const Layout& output,bool strict,PackCounters& counters) noexcept {
    const uint32_t bytes=sourceBytes(source.format),containerBits=bytes*8;
    const uint64_t word=littleWord(input,bytes);
    if(floating(source.format)&&output.floating&&bytes==output.bytes){storeWord(target,word,output);return;}
    int64_t integer=0;double value=0;
    if(!floating(source.format)){
        integer=(word&(uint64_t(1)<<(containerBits-1)))?int64_t(word)-int64_t(uint64_t(1)<<containerBits):int64_t(word);
        const uint32_t padding=containerBits-source.validBits;
        if(strict&&padding&&(word&((uint64_t(1)<<padding)-1))){counters.invalidPadding=true;return;}
        value=double(integer)/double(uint64_t(1)<<(containerBits-1));
    }else{
        if(bytes==4){const uint32_t raw=uint32_t(word);float sample;std::memcpy(&sample,&raw,4);value=sample;}
        else std::memcpy(&value,&word,8);
        if(!std::isfinite(value)){value=0;++counters.nonfinite;}
    }
    if(output.floating){
        if(output.bytes==8){uint64_t raw;std::memcpy(&raw,&value,8);storeWord(target,raw,output);}
        else{float sample=float(value);if(!std::isfinite(sample)){sample=0;++counters.nonfinite;}
            uint32_t raw;std::memcpy(&raw,&sample,4);storeWord(target,raw,output);}
        return;
    }
    if(!floating(source.format)){
        if(output.bits>=containerBits)integer*=int64_t(uint64_t(1)<<(output.bits-containerBits));
        else integer/=int64_t(uint64_t(1)<<(containerBits-output.bits)); // Truncate toward zero only when permitted.
    }else{
        const int64_t scale=int64_t(uint64_t(1)<<(output.bits-1));
        if(value>=1){integer=scale-1;++counters.saturated;}
        else if(value< -1){integer=-scale;++counters.saturated;}
        else{integer=std::llround(value*double(scale));if(integer>=scale){integer=scale-1;++counters.saturated;}}
    }
    // Conversion to unsigned is modulo 2^64. Right-aligned negative samples
    // retain sign extension; no implementation-defined negative right shift.
    uint64_t packed=uint64_t(integer);
    if(!output.rightAligned&&output.bytes*8>output.bits)packed<<=output.bytes*8-output.bits;
    storeWord(target,packed,output);
}
}
