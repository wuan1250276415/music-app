#pragma once
#include <array>
#include <atomic>
#include <algorithm>
#include <cstdint>

namespace aural_conversion {
struct Span {uint64_t begin=0,end=0,inputBegin=0,inputEnd=0;};
class Timeline {
 static constexpr uint64_t capacity=8192;
 std::array<Span,capacity> spans{};std::atomic<uint64_t> write{0},read{0};
 std::atomic<bool> overflow{false};uint64_t lastOutput=0,lastInput=0;
public:
 void reset(){write=0;read=0;overflow=false;lastOutput=0;lastInput=0;}
 void push(uint64_t begin,uint64_t end,uint64_t inputBegin,uint64_t inputEnd){
  if(begin==end)return;
  const auto w=write.load(std::memory_order_relaxed),r=read.load(std::memory_order_acquire);
  if(end<begin||inputEnd<inputBegin||w-r>=capacity){overflow=true;return;}
  spans[w%capacity]={begin,end,inputBegin,inputEnd};write.store(w+1,std::memory_order_release);
 }
 // SRC uses the declared fixed-rate phase and reported input delay, checked against
 // actual converted spans. Filter group delay remains an estimate, never exact.
 bool map(uint64_t output,uint32_t inputRate,uint32_t outputRate,uint64_t delay,bool resampled,uint64_t& input){
  if(overflow.load()||!inputRate||!outputRate)return false;
  auto r=read.load(std::memory_order_relaxed);const auto w=write.load(std::memory_order_acquire);
  uint64_t nominal=0;
  if(resampled){const uint64_t whole=output/outputRate,part=output%outputRate;
   if(whole>UINT64_MAX/inputRate)return false;
   const uint64_t fraction=part*inputRate/outputRate;if(fraction>UINT64_MAX-whole*inputRate)return false;
   nominal=whole*inputRate+fraction;nominal=nominal>delay?nominal-delay:0;
  }
  for(uint64_t budget=0;r<w&&budget<capacity;++budget){
   const auto span=spans[r%capacity];if(output<span.begin)return false;
   if(output<span.end){
    if(resampled){if(nominal>span.inputEnd)return false;input=nominal;}
    else{if(span.inputEnd-span.inputBegin!=span.end-span.begin)return false;input=span.inputBegin+output-span.begin;}
    return true;
   }
   lastOutput=span.end;lastInput=span.inputEnd;++r;read.store(r,std::memory_order_release);
  }
  if(output!=lastOutput)return false;input=resampled?nominal:lastInput;return input<=lastInput;
 }
};
struct Pump {
 // Allocated with Player before Start, not on the audio thread's stack.
 std::array<uint8_t,65536> input{},output{};uint32_t cursor=0,remaining=0;
 std::atomic<uint64_t> inputConsumed{0},outputProduced{0};
 uint64_t inputDelay=0,outputDelay=0;bool resampled=false;Timeline timeline;
 void configure(const ma_data_converter& converter){inputDelay=ma_data_converter_get_input_latency(&converter);outputDelay=ma_data_converter_get_output_latency(&converter);resampled=converter.hasResampler==MA_TRUE;}
 ma_result reset(ma_data_converter& converter){
  const auto result=ma_data_converter_reset(&converter);if(result!=MA_SUCCESS)return result;
  cursor=0;remaining=0;inputConsumed=0;outputProduced=0;timeline.reset();configure(converter);return MA_SUCCESS;
 }
 template<class Submission,class Tail,class Flush>
 ma_result run(ma_device* device,Submission& submission,Tail& tail,Flush flush){
  const auto inBytes=ma_get_bytes_per_frame(device->playback.format,device->playback.channels);
  const auto outBytes=ma_get_bytes_per_frame(device->playback.internalFormat,device->playback.internalChannels);
  if(!inBytes||!outBytes||inBytes>input.size()||outBytes>output.size()||!device->playback.internalPeriodSizeInFrames)return submission.fail(E_INVALIDARG);
  const auto inputCap=static_cast<ma_uint32>(std::min<size_t>(2048,input.size()/inBytes));
  const auto outputCap=static_cast<ma_uint32>(std::min<size_t>({512,output.size()/outBytes,device->playback.internalPeriodSizeInFrames}));
  uint32_t attempts=0;
  while(ma_device_get_state(device)==ma_device_state_started){
   if(tail.status()==5||tail.expired())return submission.fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));
   if(++attempts>4096)return submission.fail(E_FAIL);
   const auto inBefore=inputConsumed.load(std::memory_order_relaxed),outBefore=outputProduced.load(std::memory_order_relaxed);
   remaining=static_cast<uint32_t>(tail.allowed(inBefore,remaining));
   ma_uint64 used=remaining,produced=outputCap;
   const auto result=ma_data_converter_process_pcm_frames(&device->playback.converter,input.data()+size_t(cursor)*inBytes,&used,output.data(),&produced);
   if(result!=MA_SUCCESS||used>remaining||produced>outputCap||!resampled&&used!=produced||UINT64_MAX-inBefore<used||UINT64_MAX-outBefore<produced)return submission.fail(E_FAIL);
   cursor+=static_cast<uint32_t>(used);remaining-=static_cast<uint32_t>(used);
   inputConsumed.store(inBefore+used,std::memory_order_release);
   timeline.push(outBefore,outBefore+produced,inBefore,inBefore+used);
   outputProduced.store(outBefore+produced,std::memory_order_release);
   if(produced){
    ma_uint32 written=0;const auto sent=device->pContext->callbacks.onDeviceWrite(device,output.data(),static_cast<ma_uint32>(produced),&written);
    if(sent!=MA_SUCCESS)return sent;
    if(written!=produced){if(ma_device_get_state(device)!=ma_device_state_started)return MA_SUCCESS;return submission.fail(E_FAIL);}
    attempts=0;
   }
   if(!remaining){
    // Drain converter-retained output with zero input first. A non-null pointer
    // and explicit zero count prevent the API's infinite-silence interpretation.
    if(produced)continue;
    if(ma_device_get_state(device)!=ma_device_state_started)break;
    const auto wanted=tail.requestBudget(inputCap);
    if(!wanted)return tail.drain(device,submission,outputProduced.load(std::memory_order_acquire),flush);
    cursor=0;remaining=wanted;
    ma_device__handle_data_callback(device,input.data(),nullptr,wanted);
   }else if(!used&&!produced)return submission.fail(E_FAIL);
  }
  return MA_SUCCESS;
 }
};
}
