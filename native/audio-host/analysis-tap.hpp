#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>
#include <stdexcept>
#include <windows.h>

namespace aural_analysis {
constexpr size_t channelsMax=16, packetFrames=512, slots=32, windowFrames=2048, bands=64, wavePoints=64;
static_assert(std::atomic<uint64_t>::is_always_lock_free && std::atomic<bool>::is_always_lock_free,
              "Analysis callback atomics must be lock-free");
enum class Format {f32,s16,s32};
struct Packet {
    uint64_t epoch=0, startFrame=0;
    uint32_t count=0;
    std::array<uint8_t,packetFrames*channelsMax*4> bytes{};
};
struct Snapshot {
    uint64_t serial=0,epoch=0,droppedFrames=0,invalidSamples=0,endFrame=0;
    uint32_t segmentIndex=0;
    std::array<float,channelsMax> peakDb{},rmsDb{};
    std::array<float,bands> spectrumDb{};
    std::array<std::array<float,2>,wavePoints> waveform{};
};

// One callback producer, one analysis consumer. The control thread only changes
// epoch/enabled: it must never reset these cursors while either side is active.
class Tap {
    std::vector<Packet> ring;
    std::atomic<uint64_t> read{0},write{0},dropped{0},epoch{1};
    std::atomic<bool> enabled{false},closing{false},healthy{true};
    uint32_t channels=0,rate=0,bytesPerSample=0;
    Format format=Format::f32;
    uint64_t boundary=UINT64_MAX;
    std::thread worker;
    std::mutex latestMutex;
    Snapshot latest;

    static float db(float value) {return std::round(std::clamp(20.f*std::log10(std::max(value,0.0000158489f)),-96.f,24.f)*100.f)/100.f;}
    static void fft(std::array<std::complex<float>,windowFrames>& data) {
        for(size_t i=1,j=0;i<windowFrames;++i){size_t bit=windowFrames>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)std::swap(data[i],data[j]);}
        constexpr float pi=3.14159265358979323846f;
        for(size_t size=2;size<=windowFrames;size<<=1){
            const std::complex<float> step(std::cos(-2*pi/float(size)),std::sin(-2*pi/float(size)));
            for(size_t begin=0;begin<windowFrames;begin+=size){std::complex<float> weight(1,0);for(size_t j=0;j<size/2;++j){
                const auto a=data[begin+j],b=data[begin+j+size/2]*weight;data[begin+j]=a+b;data[begin+j+size/2]=a-b;weight*=step;
            }}
        }
    }
    float sample(const uint8_t* bytes,uint64_t& invalid) const {
        float value=0;
        if(format==Format::s16){int16_t raw;std::memcpy(&raw,bytes,2);value=float(raw)/32768.f;}
        else if(format==Format::s32){int32_t raw;std::memcpy(&raw,bytes,4);value=float(double(raw)/2147483648.);}
        else std::memcpy(&value,bytes,4);
        if(!std::isfinite(value)){++invalid;return 0;}
        if(std::abs(value)>16.f){++invalid;return std::clamp(value,-16.f,16.f);}
        return value;
    }
    void run() noexcept {
        // Allocation/FFT/JSON/IPC are never done by the WASAPI callback.
        try{
            std::vector<std::array<float,windowFrames>> history(channels);
            std::array<float,windowFrames> hann{};float gain=0;
            constexpr float pi=3.14159265358979323846f;
            for(size_t i=0;i<windowFrames;++i){hann[i]=.5f-.5f*std::cos(2*pi*float(i)/float(windowFrames-1));gain+=hann[i];}
            std::array<float,channelsMax> peaks{};std::array<double,channelsMax> squares{};
            size_t cursor=0,filled=0;uint64_t intervalFrames=0,lastEpoch=0,endFrame=0,serial=0,invalid=0;uint32_t segment=0;
            auto lastPublish=std::chrono::steady_clock::now();
            const auto reset=[&](){cursor=filled=0;intervalFrames=0;peaks.fill(0);squares.fill(0);};
            while(!closing.load(std::memory_order_acquire)){
                const uint64_t currentEpoch=epoch.load(std::memory_order_acquire);
                if(currentEpoch!=lastEpoch){lastEpoch=currentEpoch;reset();}
                const uint64_t consumed=read.load(std::memory_order_relaxed),written=write.load(std::memory_order_acquire);
                if(!enabled.load(std::memory_order_acquire)){read.store(written,std::memory_order_release);reset();std::this_thread::sleep_for(std::chrono::milliseconds(10));continue;}
                if(consumed==written){std::this_thread::sleep_for(std::chrono::milliseconds(3));continue;}
                const auto& packet=ring[consumed%slots];
                if(packet.epoch==lastEpoch){
                    // A missing analysis block is a discontinuity, not a run of
                    // adjacent samples. Never FFT across a dropped block/CUE edge.
                    if(filled&&packet.startFrame!=endFrame)reset();
                    for(uint32_t frame=0;frame<packet.count;++frame){
                        const uint64_t absolute=packet.startFrame+frame;const uint32_t part=absolute>=boundary?1:0;
                        if(filled&&part!=segment)reset();segment=part;
                        for(uint32_t ch=0;ch<channels;++ch){const float value=sample(packet.bytes.data()+(size_t(frame)*channels+ch)*bytesPerSample,invalid);
                            history[ch][cursor]=value;peaks[ch]=std::max(peaks[ch],std::abs(value));squares[ch]+=double(value)*value;
                        }
                        cursor=(cursor+1)%windowFrames;filled=std::min(filled+1,windowFrames);++intervalFrames;endFrame=absolute+1;
                    }
                }
                read.store(consumed+1,std::memory_order_release);
                const auto now=std::chrono::steady_clock::now();
                if(filled<windowFrames||!intervalFrames||now-lastPublish<std::chrono::milliseconds(40))continue;
                Snapshot snapshot;snapshot.serial=++serial;snapshot.epoch=lastEpoch;snapshot.endFrame=endFrame;snapshot.segmentIndex=segment;
                snapshot.droppedFrames=dropped.load(std::memory_order_relaxed);snapshot.invalidSamples=invalid;
                for(uint32_t ch=0;ch<channels;++ch){snapshot.peakDb[ch]=db(peaks[ch]);snapshot.rmsDb[ch]=db(float(std::sqrt(squares[ch]/double(intervalFrames))));}
                std::array<float,windowFrames/2+1> power{};
                for(uint32_t ch=0;ch<channels;++ch){
                    std::array<std::complex<float>,windowFrames> values{};
                    for(size_t i=0;i<windowFrames;++i)values[i]=history[ch][(cursor+i)%windowFrames]*hann[i];
                    fft(values);
                    for(size_t bin=1;bin<=windowFrames/2;++bin)power[bin]+=std::norm(values[bin])*(bin==windowFrames/2?1.f:4.f)/(gain*gain*float(channels));
                }
                const float high=float(rate)/2.f,low=std::min(20.f,high);
                for(size_t band=0;band<bands;++band){
                    const float a=low*std::pow(high/low,float(band)/float(bands)),b=low*std::pow(high/low,float(band+1)/float(bands));
                    const size_t first=std::clamp(size_t(std::ceil(a*windowFrames/float(rate))),size_t(1),windowFrames/2);
                    const size_t last=band+1==bands?windowFrames/2+1:std::min(size_t(std::ceil(b*windowFrames/float(rate))),windowFrames/2+1);
                    float maximum=0;for(size_t bin=first;bin<last;++bin)maximum=std::max(maximum,power[bin]);snapshot.spectrumDb[band]=db(std::sqrt(maximum));
                }
                for(size_t point=0;point<wavePoints;++point){float lo=1,hi=-1;
                    for(size_t i=point*windowFrames/wavePoints;i<(point+1)*windowFrames/wavePoints;++i)
                        for(uint32_t ch=0;ch<channels;++ch){const float value=std::clamp(history[ch][(cursor+i)%windowFrames],-1.f,1.f);lo=std::min(lo,value);hi=std::max(hi,value);}
                    snapshot.waveform[point]={std::round(lo*10000)/10000,std::round(hi*10000)/10000};
                }
                if(epoch.load(std::memory_order_acquire)==lastEpoch&&enabled.load(std::memory_order_acquire)){
                    std::lock_guard<std::mutex> guard(latestMutex);latest=snapshot;
                }
                peaks.fill(0);squares.fill(0);intervalFrames=0;lastPublish=now;
            }
        }catch(...){healthy.store(false,std::memory_order_release);enabled.store(false,std::memory_order_release);} // Analysis failure never stops audio.
    }
public:
    // Pure analysis of a complete, valid copy. Never called from an audio callback.
    static Snapshot floatWindow(const float* input,uint32_t channels,uint32_t rate,uint64_t endFrame){
        if(!input||!channels||channels>channelsMax||rate<40)throw std::invalid_argument("invalid analysis window");
        Snapshot out;out.endFrame=endFrame;
        std::vector<float> clean(windowFrames*channels);std::array<float,windowFrames> hann{};
        float gain=0;constexpr float pi=3.14159265358979323846f;
        for(size_t i=0;i<windowFrames;++i){hann[i]=.5f-.5f*std::cos(2*pi*float(i)/float(windowFrames-1));gain+=hann[i];}
        std::array<float,windowFrames/2+1> power{};
        for(uint32_t ch=0;ch<channels;++ch){float peak=0;double squares=0;std::array<std::complex<float>,windowFrames> bins{};
            for(size_t i=0;i<windowFrames;++i){float v=input[i*channels+ch];if(!std::isfinite(v)){v=0;++out.invalidSamples;}else if(std::abs(v)>16){v=std::clamp(v,-16.f,16.f);++out.invalidSamples;}
                clean[i*channels+ch]=v;peak=std::max(peak,std::abs(v));squares+=double(v)*v;bins[i]={v*hann[i],0};}
            out.peakDb[ch]=db(peak);out.rmsDb[ch]=db(float(std::sqrt(squares/windowFrames)));fft(bins);
            for(size_t i=1;i<power.size();++i)power[i]+=std::norm(bins[i])*(i==windowFrames/2?1.f:4.f)/(gain*gain*channels);
        }
        for(size_t band=0;band<bands;++band){const float a=20*std::pow(float(rate)/40,float(band)/bands),b=20*std::pow(float(rate)/40,float(band+1)/bands);
            const auto first=std::clamp(size_t(std::ceil(a*windowFrames/rate)),size_t(1),windowFrames/2);
            const auto last=band+1==bands?windowFrames/2+1:std::min(size_t(std::ceil(b*windowFrames/rate)),windowFrames/2+1);
            float maximum=0;for(size_t i=first;i<last;++i)maximum=std::max(maximum,power[i]);out.spectrumDb[band]=db(std::sqrt(maximum));}
        for(size_t p=0;p<wavePoints;++p){float lo=1,hi=-1;for(size_t i=p*windowFrames/wavePoints;i<(p+1)*windowFrames/wavePoints;++i)for(uint32_t ch=0;ch<channels;++ch){const float v=std::clamp(clean[i*channels+ch],-1.f,1.f);lo=std::min(lo,v);hi=std::max(hi,v);}out.waveform[p]={std::round(lo*10000)/10000,std::round(hi*10000)/10000};}
        return out;
    }
    ~Tap(){stop();}
    void start(uint32_t channelCount,uint32_t sampleRate,Format type,uint64_t cueBoundary){
        channels=channelCount;rate=sampleRate;format=type;boundary=cueBoundary;bytesPerSample=type==Format::s16?2:4;
        if(!channels||channels>channelsMax||!rate)return;
        try{ring.resize(slots);worker=std::thread([this](){SetThreadPriority(GetCurrentThread(),THREAD_PRIORITY_BELOW_NORMAL);run();});}
        catch(...){closing.store(true,std::memory_order_release);}
    }
    void configure(bool value){epoch.fetch_add(1,std::memory_order_acq_rel);enabled.store(value&&healthy.load()&&!closing.load()&&!ring.empty(),std::memory_order_release);}
    void reset(){epoch.fetch_add(1,std::memory_order_acq_rel);}
    void stop(){enabled.store(false,std::memory_order_release);closing.store(true,std::memory_order_release);if(worker.joinable())worker.join();}
    void capture(const void* output,uint32_t count,uint64_t startFrame) noexcept {
        if(!count||!enabled.load(std::memory_order_acquire))return;
        const uint64_t produced=write.load(std::memory_order_relaxed),consumed=read.load(std::memory_order_acquire);
        const uint64_t needed=(uint64_t(count)+packetFrames-1)/packetFrames;
        if(count>8192||needed>slots-(produced-consumed)){dropped.fetch_add(count,std::memory_order_relaxed);return;}
        const uint64_t version=epoch.load(std::memory_order_acquire);const auto* source=static_cast<const uint8_t*>(output);
        for(uint64_t index=0,offset=0;index<needed;++index){auto& packet=ring[(produced+index)%slots];packet.epoch=version;packet.startFrame=startFrame+offset;
            packet.count=uint32_t(std::min<uint64_t>(packetFrames,count-offset));
            std::memcpy(packet.bytes.data(),source+offset*channels*bytesPerSample,size_t(packet.count)*channels*bytesPerSample);offset+=packet.count;
        }
        write.store(produced+needed,std::memory_order_release);
    }
    bool snapshot(Snapshot& value,uint64_t after){
        std::unique_lock<std::mutex> guard(latestMutex,std::try_to_lock);
        if(!guard||!enabled.load(std::memory_order_acquire)||latest.epoch!=epoch.load(std::memory_order_acquire)||latest.serial<=after)return false;
        value=latest;return true;
    }
};
}
