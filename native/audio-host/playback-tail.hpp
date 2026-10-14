#pragma once
#include <atomic>
#include <chrono>
#include <mutex>
#include "device-clock.hpp"

namespace aural_tail {
class Completion {
 // 0 feeding, 1 flushing, 2 draining, 3 completed, 4 cancelled, 5 failed.
 std::atomic<int> phase{0};uint32_t sourceRate=0,deviceRate=0,bufferFrames=0;
 bool src=false;uint64_t requested=0,sourceEnd=0,inputEnd=0,extra=0,deadlineInput=0,target=0,committed=0,pad=0;
 std::chrono::steady_clock::time_point started;
 int proofKind=0;AuralClockReading clockProof;AuralPaddingReading paddingProof;uint64_t elapsedMs=0;
 mutable std::mutex cacheMutex;nlohmann::json cached=nullptr;
 static bool fatal(int32_t hr){const auto value=static_cast<uint32_t>(hr);return value==0x88890004||value==0x88890010||value==0x88890026;}
 static std::string hresult(int32_t hr){char value[11]{};snprintf(value,sizeof(value),"0x%08X",static_cast<unsigned>(hr));return value;}
public:
 std::atomic<bool> ready{false};
 void configure(uint32_t inputRate,uint32_t outputRate,bool resampled,uint64_t inputDelay,uint32_t frames){
  sourceRate=inputRate;deviceRate=outputRate;src=resampled;bufferFrames=frames;
  // A finite declared IIR tail budget, not a measured group-delay/error bound.
  extra=src?inputDelay+(uint64_t(inputRate)+9)/10:0;
 }
 void reset(){phase=0;ready=false;requested=0;sourceEnd=0;inputEnd=0;deadlineInput=0;target=0;committed=0;pad=0;proofKind=0;elapsedMs=0;clockProof={};paddingProof={};std::lock_guard<std::mutex> lock(cacheMutex);cached=nullptr;}
 int status()const{return phase.load(std::memory_order_acquire);}
 void noteInput(uint32_t count,uint64_t valid,uint64_t end,bool finished){
  if(UINT64_MAX-requested<count||valid>count){phase=5;return;}
  if(!status()&&finished){
   inputEnd=requested+valid;sourceEnd=end;
   if(UINT64_MAX-inputEnd<extra){phase=5;return;}
   deadlineInput=inputEnd+extra;started=std::chrono::steady_clock::now();phase.store(1,std::memory_order_release);
  }
  requested+=count;
 }
 uint64_t allowed(uint64_t consumed,uint64_t wanted)const{
  if(!status())return wanted;return consumed<deadlineInput?std::min(wanted,deadlineInput-consumed):0;
 }
 uint32_t requestBudget(uint32_t wanted)const{return static_cast<uint32_t>(allowed(requested,wanted));}
 bool expired()const{return status()!=0&&std::chrono::steady_clock::now()-started>std::chrono::seconds(30);}
 template<class Submission,class Flush>
 ma_result drain(ma_device* device,Submission& submission,uint64_t produced,Flush flush){
  if(status()!=1)return submission.fail(E_FAIL);
  const auto released=flush();if(released!=MA_SUCCESS){phase=5;return released;}
  target=produced;committed=submission.committed.load(std::memory_order_acquire);pad=submission.padding.load(std::memory_order_acquire);
  if(committed<target||committed-target!=pad){phase=5;return submission.fail(E_FAIL);}
  phase.store(2,std::memory_order_release);
  const auto lastSubmit=std::chrono::steady_clock::now();
  void* clock=auralClockOpen(device->wasapi.pAudioClientPlayback);
  while(ma_device_get_state(device)==ma_device_state_started){
   if(expired()){auralClockClose(clock);phase=5;return submission.fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));}
   clockProof=auralClockRead(clock);
   if(expired()){auralClockClose(clock);phase=5;return submission.fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));}
   if(fatal(clockProof.result)){auralClockClose(clock);phase=5;return submission.fail(clockProof.result);}
   elapsedMs=static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-lastSubmit).count());
   if(device->playback.shareMode==ma_share_mode_shared){
    paddingProof=auralPaddingRead(device->wasapi.pAudioClientPlayback);
    if(expired()){auralClockClose(clock);phase=5;return submission.fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));}
    if(!paddingProof.available||paddingProof.frames>bufferFrames){auralClockClose(clock);phase=5;return submission.fail(paddingProof.available?E_FAIL:paddingProof.result);}
    if(paddingProof.frames==0){proofKind=2;break;}
   }else{
    if(clockProof.precise&&clockProof.frequency&&clockProof.frequency<=1000000000000ULL){
     const auto seconds=clockProof.position/clockProof.frequency,remainder=clockProof.position%clockProof.frequency;
     if(seconds<=UINT64_MAX/deviceRate){const auto fraction=remainder*deviceRate/clockProof.frequency;
      if(fraction<=UINT64_MAX-seconds*deviceRate&&seconds*deviceRate+fraction>=committed){proofKind=1;break;}
     }
    }else if(elapsedMs>=(uint64_t(bufferFrames)*3000+deviceRate-1)/deviceRate+100){proofKind=3;break;}
   }
   WaitForSingleObject(static_cast<HANDLE>(device->wasapi.hEventPlayback),10);
  }
  auralClockClose(clock);
  if(!proofKind){phase.store(4,std::memory_order_release);return MA_SUCCESS;}
  ready.store(true,std::memory_order_release);return MA_SUCCESS;
 }
 void stopped(ma_result result){if(ready.load(std::memory_order_acquire))phase.store(result==MA_SUCCESS?3:5,std::memory_order_release);}
 // Only the control thread observes immutable fields belonging to the acquired
 // phase. The worker writes proof fields during phase 2; they are read only at 3.
 nlohmann::json observe(){
  const auto state=status();if(state<1||state>3)return snapshot();
  const bool submitted=state>=2,completed=state==3;
  const auto nullable=[](bool present,uint64_t value){return present?nlohmann::json(std::to_string(value)):nlohmann::json(nullptr);};
  nlohmann::json proof=nullptr;
  if(completed)proof={{"clockPosition",nullable(proofKind==1,clockProof.position)},{"clockFrequency",nullable(proofKind==1,clockProof.frequency)},{"paddingFrames",nullable(proofKind==2,paddingProof.frames)},{"elapsedMs",elapsedMs},{"bufferFrames",std::to_string(bufferFrames)}};
  const nlohmann::json value={{"version",1},{"status",state==1?"flushing":state==2?"draining":"completed"},{"evidence",completed?(proofKind==1?"device-clock":proofKind==2?"shared-padding":"exclusive-period-estimate"):"pending"},
   {"sourceFrame",std::to_string(sourceEnd)},{"sourceSampleRate",sourceRate},{"deviceSampleRate",deviceRate},{"inputEndFrame",std::to_string(inputEnd)},
   {"targetOutputFrames",submitted?nullable(true,target):nlohmann::json(nullptr)},{"committedOutputFrames",submitted?nullable(true,committed):nlohmann::json(nullptr)},{"packetPaddingFrames",submitted?nullable(true,pad):nlohmann::json(nullptr)},
   {"filterTailInputFrames",std::to_string(extra)},{"policy",src?"linear-src-100ms":"no-resampler"},{"probeHresult",completed?nlohmann::json(hresult(proofKind==2?paddingProof.result:clockProof.result)):nlohmann::json(nullptr)},{"proof",proof},{"hardwareVerified",false}};
  std::lock_guard<std::mutex> lock(cacheMutex);cached=value;return value;
 }
 nlohmann::json snapshot()const{std::lock_guard<std::mutex> lock(cacheMutex);return cached;}
};
}
