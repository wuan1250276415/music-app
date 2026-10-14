#pragma once
#include "gain-processing.hpp"
namespace aural_gain {
// One atomic word publishes the complete volume/mute target. The unused sign of
// the nonnegative attenuation magnitude carries mute; the double remains exact.
inline uint64_t volumeWord(double db,bool muted){double magnitude=-db;uint64_t bits=0;std::memcpy(&bits,&magnitude,sizeof(bits));return (bits&0x7fffffffffffffffULL)|(muted?0x8000000000000000ULL:0);}
inline double wordVolume(uint64_t bits){bits&=0x7fffffffffffffffULL;double magnitude=0;std::memcpy(&magnitude,&bits,sizeof(bits));return -magnitude;}
struct BaseGain {double normalization=0,ceiling=0;bool clipping=true,normalizing=false;};
struct LiveGain {
 static_assert(std::atomic<uint64_t>::is_always_lock_free,"live volume requires lock-free 64-bit atomics");
 std::atomic<uint64_t> requested{0};BaseGain bases[2];
 // Only the playback callback owns the envelope; reset only while the device is stopped.
 double current=1,target=1;uint64_t remaining=0;uint32_t rampFrames=1;int segment=-1;
 void initialize(const Plan* plans,uint32_t rate,uint64_t position,uint64_t boundary){
  rampFrames=std::max<uint32_t>(1,(rate+49)/50);
  for(int i=0;i<2;++i){const auto& p=plans[i].description;auto& b=bases[i];b.normalization=p.at("normalizationGainDb").get<double>()+(p.at("selection")=="none"?0:p.at("settings").at("preampDb").get<double>());b.ceiling=-20*std::log10(p.at("peak").is_null()?1:p.at("peak").get<double>());b.clipping=p.at("settings").at("preventClipping").get<bool>();b.normalizing=p.at("settings").at("replayGain")!="off";}
  const auto& s=plans[0].description.at("settings");requested=volumeWord(s.at("volumeDb").get<double>(),s.at("muted").get<bool>());
  reset(position,boundary);
 }
 double gain(int index,uint64_t word)const{if(word&0x8000000000000000ULL)return 0;const auto& b=bases[index];const double db=b.normalization+wordVolume(word);return std::pow(10.,(b.clipping?std::min(db,b.ceiling):db)/20);}
 void reset(uint64_t position,uint64_t boundary){segment=position<boundary?0:1;current=target=gain(segment,requested.load(std::memory_order_acquire));remaining=0;}
 void render(uint8_t* bytes,uint64_t frames,uint32_t channels,uint64_t position,uint64_t boundary,std::atomic<uint64_t>& clipped,std::atomic<uint64_t>& invalid){
  const uint64_t word=requested.load(std::memory_order_acquire);const double db=wordVolume(word);const bool mute=(word&0x8000000000000000ULL)!=0;
  const double targets[]={gain(0,word),gain(1,word)};uint64_t clipCount=0,invalidCount=0;
  for(uint64_t frame=0;frame<frames;++frame){
   const int next=position+frame<boundary?0:1;const auto& base=bases[next];
   if(next!=segment||targets[next]!=target){segment=next;target=targets[next];remaining=rampFrames;}
   const bool active=base.normalizing||mute||db!=0||remaining!=0||current!=1;
   if(remaining){current+=(target-current)/double(remaining);if(!--remaining)current=target;}
   if(!active)continue;
   for(uint32_t channel=0;channel<channels;++channel){const uint64_t index=frame*channels+channel;float input=0;std::memcpy(&input,bytes+index*sizeof(float),sizeof(float));double value=0;if(!std::isfinite(input))++invalidCount;else value=double(input)*current;
    if(base.clipping&&(value>1||value<-1)){++clipCount;value=std::max(-1.,std::min(1.,value));}
    if(!std::isfinite(value)||std::abs(value)>std::numeric_limits<float>::max()){++invalidCount;value=0;}
    const float output=static_cast<float>(value);std::memcpy(bytes+index*sizeof(float),&output,sizeof(float));
   }
  }
  clipped.fetch_add(clipCount,std::memory_order_relaxed);invalid.fetch_add(invalidCount,std::memory_order_relaxed);
 }
};
}
