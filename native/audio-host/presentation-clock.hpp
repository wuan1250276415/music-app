#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <cstdio>
#include <chrono>
#include "device-clock.hpp"
#include "output-conversion.hpp"

namespace aural_clock {
struct Span {uint64_t begin=0,end=0,source=0,valid=0;};
class Timeline {
 static constexpr uint64_t capacity=8192;
 std::array<Span,capacity> spans{};std::atomic<uint64_t> write{0},read{0};uint64_t stream=0;
 std::atomic<bool> overflow{false};uint64_t last=0,lastStream=0;
public:
 // Reset only while the callback is stopped. No allocation or driver query in push.
 void reset(uint64_t source){write=0;read=0;stream=0;overflow=false;last=source;lastStream=0;}
 void push(uint32_t count,uint64_t source,uint64_t valid){
  const uint64_t w=write.load(std::memory_order_relaxed),r=read.load(std::memory_order_acquire);
  if(UINT64_MAX-stream<count||w-r>=capacity){overflow=true;return;}
  spans[w%capacity]={stream,stream+count,source,valid};stream+=count;write.store(w+1,std::memory_order_release);
 }
 bool map(uint64_t frame,uint64_t& source){
  if(overflow.load())return false;uint64_t r=read.load(std::memory_order_relaxed);const uint64_t w=write.load(std::memory_order_acquire);
  source=last;
  for(uint64_t budget=0;r<w&&budget<capacity;++budget){
   const auto span=spans[r%capacity];if(frame<span.begin)return false;
   if(frame<span.end){source=span.source+std::min<uint64_t>(frame-span.begin,span.valid);return true;}
   last=span.source+span.valid;lastStream=span.end;source=last;++r;read.store(r,std::memory_order_release);
  }
  // No submitted sample means an initial or paused bookmark, not an advancing clock.
  return frame==lastStream;
 }
};
class Presentation {
 void* handle=nullptr;uint32_t rate=0,outputRate=0;uint64_t lastTicks=0,lastSource=0,lastMapped=0;
 aural_conversion::Pump* conversion=nullptr;
 const std::atomic<uint64_t>* outputPadding=nullptr;
 const char* bookmarkBasis="requested-position";
 mutable std::mutex mutex;nlohmann::json cached=nlohmann::json::object();
 std::chrono::steady_clock::time_point progressAt=std::chrono::steady_clock::now();
 static std::string result(int32_t code){char buffer[11]{};snprintf(buffer,sizeof(buffer),"0x%08X",static_cast<unsigned>(code));return buffer;}
public:
 Timeline timeline;
 void open(void* client,uint32_t sourceRate,uint32_t deviceRate,aural_conversion::Pump* pump,const std::atomic<uint64_t>* padding){handle=auralClockOpen(client);rate=sourceRate;outputRate=deviceRate;conversion=pump;outputPadding=padding;}
 void close(){if(handle){auralClockClose(handle);handle=nullptr;}}
 ~Presentation(){close();}
 void reset(uint64_t source,const char* basis="requested-position"){timeline.reset(source);lastTicks=0;lastSource=source;lastMapped=source;bookmarkBasis=basis;progressAt=std::chrono::steady_clock::now();publish(source,source,"paused-bookmark","stream-reset",{},0,true);}
 void publish(uint64_t source,uint64_t consumed,const char* authority,const char* reason,const AuralClockReading& reading,uint64_t committed,bool valid){
  // A frame-preserving converter publishes one counter for both sides. Reading
  // the two worker atomics separately could otherwise observe a half update.
  const auto produced=conversion->outputProduced.load(std::memory_order_acquire);
  const auto input=conversion->resampled?conversion->inputConsumed.load(std::memory_order_acquire):produced;
  const nlohmann::json value={{"version",4},{"authority",authority},{"reason",reason},{"sourceFrame",std::to_string(source)},{"callbackFrame",std::to_string(consumed)},{"sourceSampleRate",rate},
   {"devicePosition",reading.available?nlohmann::json(std::to_string(reading.position)):nlohmann::json(nullptr)},
   {"deviceFrequency",reading.available?nlohmann::json(std::to_string(reading.frequency)):nlohmann::json(nullptr)},
   {"qpc100ns",reading.available?nlohmann::json(std::to_string(reading.qpc100ns)):nlohmann::json(nullptr)},
   {"hresult",result(reading.result)},{"mappingUncertaintyFrames",std::string(authority)=="device-reported"?nlohmann::json(1):nlohmann::json(nullptr)},
   {"deviceSampleRate",outputRate},{"committedDeviceFrames",std::to_string(committed)},{"submissionValid",valid},
   {"bookmarkBasis",std::string(authority)=="paused-bookmark"?nlohmann::json(bookmarkBasis):nlohmann::json(nullptr)},
   {"conversion",{{"resampled",conversion->resampled},{"inputConsumed",std::to_string(input)},{"outputProduced",std::to_string(produced)},{"outputPaddingFrames",std::to_string(outputPadding->load(std::memory_order_acquire))},{"inputLatencyFrames",std::to_string(conversion->inputDelay)},{"outputLatencyFrames",std::to_string(conversion->outputDelay)},{"latencyEvidence",conversion->resampled?"converter-reported-estimate":"frame-preserving"}}},
   {"hardwareVerified",false}};
  std::lock_guard<std::mutex> lock(mutex);cached=value;
 }
 void sample(uint64_t consumed,bool paused,uint64_t committed,bool valid){
  if(paused){publish(lastSource,consumed,"paused-bookmark","paused",{},committed,valid);return;}
  sampleReading(auralClockRead(handle),consumed,committed,valid,false);
 }
 bool sampleReading(const AuralClockReading& value,uint64_t consumed,uint64_t committed,bool valid,bool frozen){
  uint64_t source=consumed;const char* reason="clock-unavailable";bool mapped=false;
  if(!valid)reason="submission-invalid";
  else if(!conversion)reason="converter-mapping-pending";
  else if(!value.precise)reason=value.available?"clock-reading-delayed":"clock-unavailable";
  else if(!value.frequency||value.frequency>1000000000000ULL)reason="clock-frequency-invalid";
  else if(value.position<lastTicks)reason="clock-regressed";
  else if(!frozen&&value.position==lastTicks&&consumed>lastMapped&&std::chrono::steady_clock::now()-progressAt>std::chrono::seconds(3))reason="clock-stalled";
  else {
   const uint64_t whole=value.position/value.frequency,remainder=value.position%value.frequency;
   uint64_t input=0;
   if(whole>UINT64_MAX/outputRate)reason="clock-overflow";
   else {const uint64_t fraction=remainder*outputRate/value.frequency;if(fraction>UINT64_MAX-whole*outputRate)reason="clock-overflow";
    else if(whole*outputRate+fraction>committed)reason="clock-beyond-submission";
    else if(!conversion->timeline.map(whole*outputRate+fraction,rate,outputRate,conversion->inputDelay,conversion->resampled,input))reason="converter-timeline-unavailable";
    else if(!timeline.map(input,source))reason="timeline-unavailable";
    else if(source>consumed||source<lastMapped)reason="source-mapping-invalid";
    else {mapped=true;reason=conversion->resampled?(frozen?"converted-frozen":"converted-timeline"):(frozen?"same-rate-frozen":"same-rate-timeline");if(value.position>lastTicks)progressAt=std::chrono::steady_clock::now();lastTicks=value.position;lastMapped=source;}
   }
  }
  if(!mapped)source=frozen?std::min(lastSource,consumed):consumed;lastSource=source;publish(source,consumed,mapped?(conversion->resampled?"converter-estimate":"device-reported"):"callback-estimate",reason,value,committed,valid);return mapped;
 }
 nlohmann::json snapshot()const{std::lock_guard<std::mutex> lock(mutex);return cached;}
 uint64_t sourceFrame()const{const auto value=snapshot();return std::stoull(value.at("sourceFrame").get<std::string>());}
};
}
