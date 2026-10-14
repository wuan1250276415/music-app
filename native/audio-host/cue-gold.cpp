#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include "cue-frames.hpp"
#include "cue-timeline.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>

static void append16(std::vector<uint8_t>& out,uint16_t value) {
    out.push_back(static_cast<uint8_t>(value));
    out.push_back(static_cast<uint8_t>(value>>8));
}
static void append32(std::vector<uint8_t>& out,uint32_t value) {
    append16(out,static_cast<uint16_t>(value));
    append16(out,static_cast<uint16_t>(value>>16));
}
static int16_t sampleAt(uint64_t index) {
    return static_cast<int16_t>(int64_t((index*37)%60001)-30000);
}
static int32_t sample24At(uint64_t index) {
    return static_cast<int32_t>(int64_t((index*937)%16000001)-8000000);
}
static std::vector<uint8_t> makeWav(uint32_t rate) {
    const uint32_t frames=rate*3;
    std::vector<uint8_t> wav;
    wav.reserve(44+frames*2);
    for (char c: {'R','I','F','F'}) wav.push_back(static_cast<uint8_t>(c));
    append32(wav,36+frames*2);
    for (char c: {'W','A','V','E','f','m','t',' '}) wav.push_back(static_cast<uint8_t>(c));
    append32(wav,16);append16(wav,1);append16(wav,1);
    append32(wav,rate);append32(wav,rate*2);append16(wav,2);append16(wav,16);
    for (char c: {'d','a','t','a'}) wav.push_back(static_cast<uint8_t>(c));
    append32(wav,frames*2);
    for (uint32_t i=0;i<frames;++i)append16(wav,static_cast<uint16_t>(sampleAt(i)));
    return wav;
}

static bool readSpan(ma_decoder& decoder,uint32_t rate,uint32_t bits,uint64_t cueStart,uint64_t cueEnd,
                     std::vector<float>& samples) {
    uint64_t start=0,end=0;
    if (!cueToPcmFrame(cueStart,rate,start)||!cueToPcmFrame(cueEnd,rate,end)||end<=start) return false;
    if (ma_decoder_seek_to_pcm_frame(&decoder,start)!=MA_SUCCESS) return false;
    samples.resize(static_cast<size_t>(end-start));
    ma_uint64 got=0;
    if (ma_decoder_read_pcm_frames(&decoder,samples.data(),samples.size(),&got)!=MA_SUCCESS || got!=samples.size())
        return false;
    for (uint64_t i=0;i<got;++i) {
        const float expected=bits==24?float(sample24At(start+i))/8388608.0f:
            float(sampleAt(start+i))/32768.0f;
        if (std::fabs(samples[static_cast<size_t>(i)]-expected)>0.000001f) return false;
    }
    return true;
}

static bool verifySpans(ma_decoder& decoder,uint32_t rate,uint32_t bits) {
    for (uint64_t boundary: {1ull,3ull,74ull,149ull}) {
        std::vector<float> first,second,joined;
        // Repeated backward and forward seeks must return the same source samples.
        const bool valid=readSpan(decoder,rate,bits,boundary+1,boundary+2,second) &&
            readSpan(decoder,rate,bits,boundary,boundary+2,joined) &&
            readSpan(decoder,rate,bits,boundary,boundary+1,first) && first.size()+second.size()==joined.size();
        if (!valid) return false;
        for (size_t i=0;i<first.size();++i) if(first[i]!=joined[i]) return false;
        for (size_t i=0;i<second.size();++i) if(second[i]!=joined[first.size()+i]) return false;
        if(rate==44117 && boundary==3 && (first.size()!=588 || second.size()!=589)) return false;
    }
    return true;
}

static bool verifyIntegerSpans(ma_decoder& decoder,uint32_t rate,uint32_t bits) {
    for(uint64_t boundary:{1ull,74ull,149ull}) {
        uint64_t start=0,end=0;
        if(!cueToPcmFrame(boundary,rate,start)||!cueToPcmFrame(boundary+1,rate,end)||end<=start)return false;
        if(ma_decoder_seek_to_pcm_frame(&decoder,start)!=MA_SUCCESS)return false;
        ma_uint64 got=0;
        if(bits==16) {
            std::vector<int16_t> samples(static_cast<size_t>(end-start));
            if(ma_decoder_read_pcm_frames(&decoder,samples.data(),samples.size(),&got)!=MA_SUCCESS||got!=samples.size())return false;
            for(size_t i=0;i<samples.size();++i)if(samples[i]!=sampleAt(start+i))return false;
        }else{
            std::vector<int32_t> samples(static_cast<size_t>(end-start));
            if(ma_decoder_read_pcm_frames(&decoder,samples.data(),samples.size(),&got)!=MA_SUCCESS||got!=samples.size())return false;
            for(size_t i=0;i<samples.size();++i)if(samples[i]!=sample24At(start+i)*256)return false;
        }
    }
    return true;
}

template<typename Sample,typename Expected>
static bool verifyContinuousSamples(ma_decoder& decoder,const CueTwoSpanPlan& plan,Expected expected) {
    if(ma_decoder_seek_to_pcm_frame(&decoder,plan.startPcmFrame)!=MA_SUCCESS)return false;
    std::vector<Sample> block(257);
    uint64_t position=plan.startPcmFrame;
    uint32_t boundaryCount=0;
    while(position<plan.endPcmFrame){
        const ma_uint64 wanted=std::min<uint64_t>(block.size(),plan.endPcmFrame-position);
        ma_uint64 got=0;
        if(ma_decoder_read_pcm_frames(&decoder,block.data(),wanted,&got)!=MA_SUCCESS||got!=wanted)return false;
        for(ma_uint64 i=0;i<got;++i){
            const uint64_t frame=position+i;
            if(frame==plan.boundaryPcmFrame)++boundaryCount;
            if(block[static_cast<size_t>(i)]!=expected(frame))return false;
        }
        position+=got;
    }
    return boundaryCount==1 && position==plan.endPcmFrame;
}

static bool verifyContinuousTwoSpans(ma_decoder& decoder,uint32_t rate,uint32_t bits) {
    CueTwoSpanPlan plan{};
    if(!cueTwoSpanPlan(1,74,74,149,rate,plan) ||
       cueTwoSpanPlan(1,74,75,149,rate,plan) ||
       cueTwoSpanPlan(74,74,74,149,rate,plan))return false;
    if(bits==16)return verifyContinuousSamples<int16_t>(decoder,plan,[](uint64_t frame){return sampleAt(frame);});
    return verifyContinuousSamples<int32_t>(decoder,plan,[](uint64_t frame){return sample24At(frame)*256;});
}

int wmain(int argc,wchar_t** argv) {
    if (argc!=3) {std::cerr<<"usage: cue-gold.exe <16-bit-flac> <24-bit-flac>\n";return 1;}
    for (uint32_t rate: {44100u,48000u,44117u}) {
        const auto wav=makeWav(rate);
        ma_decoder decoder{};
        const auto config=ma_decoder_config_init(ma_format_f32,0,0);
        if (ma_decoder_init_memory(wav.data(),wav.size(),&config,&decoder)!=MA_SUCCESS) return 1;
        if (decoder.outputSampleRate!=rate || decoder.outputChannels!=1) return 2;
        if (!verifySpans(decoder,rate,16)) {std::cerr<<"WAV CUE span failed at "<<rate<<" Hz\n";return 3;}
        ma_decoder_uninit(&decoder);
        ma_decoder integerDecoder{};
        const auto integerConfig=ma_decoder_config_init(ma_format_s16,0,0);
        if(ma_decoder_init_memory(wav.data(),wav.size(),&integerConfig,&integerDecoder)!=MA_SUCCESS)return 7;
        const bool integerValid=integerDecoder.outputFormat==ma_format_s16&&verifyIntegerSpans(integerDecoder,rate,16)&&
            verifyContinuousTwoSpans(integerDecoder,rate,16);
        ma_decoder_uninit(&integerDecoder);
        if(!integerValid){std::cerr<<"WAV integer mismatch at "<<rate<<" Hz\n";return 8;}
    }
    const auto config=ma_decoder_config_init(ma_format_f32,0,0);
    for (int fixture=1;fixture<=2;++fixture) {
        const uint32_t rate=fixture==1?44100:48000;
        const uint32_t bits=fixture==1?16:24;
        ma_decoder flac{};
        if (ma_decoder_init_file_w(argv[fixture],&config,&flac)!=MA_SUCCESS) {
            std::cerr<<"FLAC fixture could not be decoded\n";return 4;
        }
        const bool valid=flac.outputSampleRate==rate && flac.outputChannels==1 && verifySpans(flac,rate,bits);
        ma_decoder_uninit(&flac);
        if (!valid) {std::cerr<<"FLAC CUE sample or seek mismatch at "<<rate<<" Hz/"<<bits<<"-bit\n";return 5;}
        ma_decoder integerDecoder{};
        const auto integerConfig=ma_decoder_config_init(bits==16?ma_format_s16:ma_format_s32,0,0);
        if(ma_decoder_init_file_w(argv[fixture],&integerConfig,&integerDecoder)!=MA_SUCCESS)return 9;
        const bool integerValid=integerDecoder.outputFormat==(bits==16?ma_format_s16:ma_format_s32)&&
            verifyIntegerSpans(integerDecoder,rate,bits)&&verifyContinuousTwoSpans(integerDecoder,rate,bits);
        ma_decoder_uninit(&integerDecoder);
        if(!integerValid){std::cerr<<"FLAC integer mismatch at "<<rate<<" Hz/"<<bits<<"-bit\n";return 10;}
    }
    std::cout<<"WAV CUE gold passed at 44100/48000/44117 Hz; FLAC 16-bit/24-bit gold passed; integer PCM gold passed; continuous two-span gold passed\n";
    return 0;
}
