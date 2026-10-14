#pragma once
#include "asio-pcm.hpp"
#include "dsd-block.hpp"

namespace aural_asio {
inline bool dsdBitRate(uint32_t rate) noexcept {return rate==2822400||rate==5644800||rate==11289600;}
inline bool nativeDsdSample(int32_t type) noexcept {return type==ASIOSTDSDInt8MSB1||type==ASIOSTDSDInt8LSB1;}
inline bool dopLayout(const Layout& output) noexcept {
    return !output.floating&&((output.bytes==3&&output.bits==24&&!output.rightAligned)||
        (output.bytes==4&&((output.bits==32&&!output.rightAligned)||(output.bits==24&&output.rightAligned))));
}
inline void nativeDsdPlane(uint8_t* output,const uint8_t* raw,uint32_t byteFrames,uint32_t count,uint64_t validBits,
                           uint32_t channel,uint32_t channels,int32_t type,uint8_t quiet) noexcept {
    const bool reverse=type==ASIOSTDSDInt8LSB1;
    for(uint32_t frame=0;frame<byteFrames;++frame){
        uint8_t value=quiet;
        if(frame<count){value=raw[size_t(frame)*channels+channel];
            const auto remaining=validBits-uint64_t(frame)*8;
            if(remaining<8){const uint8_t mask=uint8_t(0xffu<<(8-unsigned(remaining)));value=uint8_t((value&mask)|(quiet&~mask));}}
        output[frame]=reverse?aural_dsd::reverseByte(value):value;
    }
}
inline void dopPlane(uint8_t* output,const uint8_t* raw,uint32_t carrierFrames,uint32_t count,uint64_t validBits,
                     uint32_t channel,uint32_t channels,const Layout& layout,uint8_t quiet) noexcept {
    // An even driver buffer keeps 0x05/0xFA phase identical across initial
    // silent priming, either callback half, discarded blocks and quiet tails.
    for(uint32_t frame=0;frame<carrierFrames;++frame){
        uint8_t older=quiet,newer=quiet;
        for(uint32_t ordinal=0;ordinal<2;++ordinal){const uint32_t byte=frame*2+ordinal;
            uint8_t value=quiet;if(byte<count){value=raw[size_t(byte)*channels+channel];
                const auto remaining=validBits-uint64_t(byte)*8;
                if(remaining<8){const uint8_t mask=uint8_t(0xffu<<(8-unsigned(remaining)));value=uint8_t((value&mask)|(quiet&~mask));}}
            (ordinal?newer:older)=value;
        }
        const uint32_t marker=frame%2?0xfa:0x05;
        uint32_t word=(marker<<16)|(uint32_t(older)<<8)|newer;
        if(layout.bytes==4){if(layout.rightAligned){if(marker&0x80)word|=0xff000000u;}else word<<=8;}
        storeWord(output+size_t(frame)*layout.bytes,word,layout);
    }
}
}
