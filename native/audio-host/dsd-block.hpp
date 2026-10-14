#pragma once
#include <cstdint>
#include <vector>
namespace aural_dsd {
enum class BlockKind {rawDsdMsbFirst};
inline uint8_t reverseByte(uint8_t value){value=uint8_t((value>>4)|(value<<4));value=uint8_t(((value&0xcc)>>2)|((value&0x33)<<2));return uint8_t(((value&0xaa)>>1)|((value&0x55)<<1));}
inline uint8_t silenceAt(uint64_t tick){const unsigned shift=unsigned(tick%8);return shift?uint8_t((0x69u<<shift)|(0x69u>>(8-shift))):0x69;}
struct RawBlock {
    BlockKind kind=BlockKind::rawDsdMsbFirst;
    uint32_t bitRate=0,channels=0,byteFrames=0;
    uint64_t startTick=0,validBitsPerChannel=0;
    // Byte frames interleave channels; oldest bit is always bit 7. PCM is never represented here.
    std::vector<uint8_t> bytes;
};
}
