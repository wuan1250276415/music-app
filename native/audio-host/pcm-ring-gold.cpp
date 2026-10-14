#include "pcm-ring.hpp"

#include <atomic>
#include <cstdint>
#include <iostream>
#include <vector>

struct Buffer {
    std::vector<uint8_t> ring;
    uint32_t bytesPerFrame=1;
    uint64_t capacityFrames=0;
    uint64_t maxFrames=UINT64_MAX;
    uint64_t boundaryRelativeFrame=UINT64_MAX;
    std::atomic<uint64_t> readFrames{0},writeFrames{0},positionBaseFrames{0};
    std::atomic<uint64_t> callbackCount{0},bufferUnderrunCallbacks{0},bufferUnderrunFrames{0};
    std::atomic<bool> eof{false},finished{false},boundaryReached{false};
    std::atomic<int> boundaryState{0};
};

static bool expect(const std::vector<uint8_t>& actual,const std::vector<uint8_t>& wanted,const char* name) {
    if(actual==wanted)return true;
    std::cerr<<name<<" output mismatch\n";
    return false;
}

int main() {
    {
        Buffer b;b.ring={5,6,0,4};b.capacityFrames=4;b.readFrames=3;b.writeFrames=6;
        std::vector<uint8_t> out(3,0xff);consumePcmFrames(b,out.data(),3);
        if(!expect(out,{4,5,6},"ring wrap")||b.readFrames!=6||b.bufferUnderrunFrames!=0)return 1;
    }
    {
        Buffer b;b.ring={4,5,6,1,2,3};b.capacityFrames=2;b.bytesPerFrame=3;
        b.readFrames=1;b.writeFrames=3;
        std::vector<uint8_t> out(6,0xff);consumePcmFrames(b,out.data(),2);
        if(!expect(out,{1,2,3,4,5,6},"multibyte wrap"))return 2;
    }
    {
        Buffer b;b.ring={1,2,3,4,5,6,7,8};b.capacityFrames=8;b.maxFrames=8;
        b.boundaryRelativeFrame=4;b.writeFrames=8;
        std::vector<uint8_t> first(4,0xff),second(4,0xff);
        consumePcmFrames(b,first.data(),4);
        if(!expect(first,{1,2,3,4},"first CUE span")||b.boundaryState!=1||!b.boundaryReached)return 3;
        b.eof=true;
        consumePcmFrames(b,second.data(),4);
        if(!expect(second,{5,6,7,8},"second CUE span")||!b.finished||b.bufferUnderrunFrames!=0)return 4;
    }
    {
        Buffer b;b.ring={1,2,3,4,5,6,7,8};b.capacityFrames=8;b.maxFrames=8;
        b.boundaryRelativeFrame=4;b.writeFrames=8;b.boundaryState=2;
        std::vector<uint8_t> out(6,0xff);consumePcmFrames(b,out.data(),6);
        if(!expect(out,{1,2,3,4,0,0},"cancelled next span")||b.readFrames!=4||
           !b.finished||b.boundaryReached||b.bufferUnderrunFrames!=0)return 5;
    }
    {
        Buffer b;b.ring={1,2,3,4,5,6,7,8};b.capacityFrames=8;b.maxFrames=8;
        b.boundaryRelativeFrame=4;b.readFrames=4;b.writeFrames=4;
        std::vector<uint8_t> out(2,0xff);consumePcmFrames(b,out.data(),2);
        if(!expect(out,{0,0},"empty boundary")||b.boundaryState!=0||b.boundaryReached)return 6;
    }
    {
        Buffer b;b.ring={91,32,33,34};b.capacityFrames=4;b.maxFrames=10;
        b.positionBaseFrames=5;b.writeFrames=1; // After seek, old bytes remain but are unpublished.
        std::vector<uint8_t> out(3,0xff);consumePcmFrames(b,out.data(),3);
        if(!expect(out,{91,0,0},"seek discards old buffer")||b.readFrames!=1||
           b.bufferUnderrunCallbacks!=1||b.bufferUnderrunFrames!=2)return 7;
    }
    {
        Buffer b;b.ring={7,8,0,0};b.capacityFrames=4;b.maxFrames=2;b.writeFrames=2;b.eof=true;
        std::vector<uint8_t> out(4,0xff);consumePcmFrames(b,out.data(),4);
        if(!expect(out,{7,8,0,0},"intentional end padding")||!b.finished||
           b.bufferUnderrunCallbacks!=0||b.bufferUnderrunFrames!=0)return 8;
    }
    std::cout<<"PCM ring wrap, boundary, cancellation, seek isolation and underrun gold passed\n";
    return 0;
}
