#pragma once
// Project adapter for the pinned miniaudio WASAPI blocking writer. Include after
// MINIAUDIO_IMPLEMENTATION. The vendored implementation remains byte-for-byte pinned.
namespace aural_output {
struct Submission {
 std::atomic<uint64_t> committed{0},padding{0};std::atomic<bool> valid{true};
 std::atomic<int32_t> failure{0};std::atomic<ma_result> stopResult{MA_SUCCESS};
 std::atomic<bool> discard{false},frozenReady{false};AuralClockReading frozen;uint64_t frozenCommitted=0;
 void reset(){committed=0;padding=0;valid=true;failure=0;frozenReady=false;}
 void commit(uint32_t count){const auto before=committed.load(std::memory_order_relaxed);
  if(UINT64_MAX-before<count){valid=false;failure=E_FAIL;return;}
  committed.store(before+count,std::memory_order_release);
 }
 ma_result fail(HRESULT hr){failure=hr;valid=false;return FAILED(hr)?ma_result_from_HRESULT(hr):MA_ERROR;}
};
inline ma_result release(ma_device* device,Submission& state,bool pad){
 if(!device->wasapi.pMappedBufferPlayback)return MA_SUCCESS;
 const auto cap=device->wasapi.mappedBufferPlaybackCap,len=device->wasapi.mappedBufferPlaybackLen;
 if(!cap||len>cap)return state.fail(E_FAIL);
 if(pad&&len<cap)ma_silence_pcm_frames(ma_offset_pcm_frames_ptr(device->wasapi.pMappedBufferPlayback,len,device->playback.internalFormat,device->playback.internalChannels),cap-len,device->playback.internalFormat,device->playback.internalChannels);
 const HRESULT hr=ma_IAudioRenderClient_ReleaseBuffer(static_cast<ma_IAudioRenderClient*>(device->wasapi.pRenderClient),cap,0);
 if(hr!=S_OK)return state.fail(hr);
 if(pad)state.padding.fetch_add(cap-len,std::memory_order_release);
 device->wasapi.pMappedBufferPlayback=nullptr;device->wasapi.mappedBufferPlaybackCap=0;device->wasapi.mappedBufferPlaybackLen=0;
 state.commit(cap);return state.valid.load()?MA_SUCCESS:MA_ERROR;
}
inline ma_result write(ma_device* device,const void* frames,ma_uint32 count,ma_uint32* written,Submission& state){
 ma_result result=MA_SUCCESS;ma_uint32 copied=0;
 while(ma_device_get_state(device)==ma_device_state_started&&copied<count){
  if(device->wasapi.pMappedBufferPlayback){
   const auto cap=device->wasapi.mappedBufferPlaybackCap,len=device->wasapi.mappedBufferPlaybackLen;
   if(!cap||len>=cap){result=state.fail(E_FAIL);break;}
   const auto take=std::min<ma_uint32>(count-copied,cap-len);
   ma_copy_pcm_frames(ma_offset_pcm_frames_ptr(device->wasapi.pMappedBufferPlayback,len,device->playback.internalFormat,device->playback.internalChannels),ma_offset_pcm_frames_const_ptr(frames,copied,device->playback.internalFormat,device->playback.internalChannels),take,device->playback.internalFormat,device->playback.internalChannels);
   copied+=take;device->wasapi.mappedBufferPlaybackLen+=take;
   if(device->wasapi.mappedBufferPlaybackLen==cap){
    result=release(device,state,false);if(result!=MA_SUCCESS)break;
    if(device->playback.shareMode==ma_share_mode_exclusive&&WaitForSingleObject(static_cast<HANDLE>(device->wasapi.hEventPlayback),MA_WASAPI_WAIT_TIMEOUT_MILLISECONDS)!=WAIT_OBJECT_0){result=state.fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));break;}
   }
  }else{
   const auto cap=device->playback.shareMode==ma_share_mode_exclusive?device->wasapi.actualBufferSizeInFramesPlayback:device->wasapi.periodSizeInFramesPlayback;
   if(!cap){result=state.fail(E_FAIL);break;}
   const HRESULT hr=ma_IAudioRenderClient_GetBuffer(static_cast<ma_IAudioRenderClient*>(device->wasapi.pRenderClient),cap,reinterpret_cast<BYTE**>(&device->wasapi.pMappedBufferPlayback));
   if(hr==S_OK&&device->wasapi.pMappedBufferPlayback){device->wasapi.mappedBufferPlaybackCap=cap;device->wasapi.mappedBufferPlaybackLen=0;}
   else if(hr==MA_AUDCLNT_E_BUFFER_TOO_LARGE||hr==MA_AUDCLNT_E_BUFFER_ERROR){
    if(WaitForSingleObject(static_cast<HANDLE>(device->wasapi.hEventPlayback),MA_WASAPI_WAIT_TIMEOUT_MILLISECONDS)!=WAIT_OBJECT_0){result=state.fail(HRESULT_FROM_WIN32(ERROR_TIMEOUT));break;}
   }else{result=state.fail(hr==S_OK?E_POINTER:hr);break;}
  }
 }
 if(written)*written=copied;return result;
}
inline ma_result stop(ma_device* device,Submission& state){
 ma_result result=MA_SUCCESS;
 if(!state.discard.load(std::memory_order_acquire)){
  // Preserve the pinned backend's natural-tail drain, but check its partial packet.
  result=release(device,state,true);
  const auto stopped=ma_device_stop__wasapi(device);
  if(result==MA_SUCCESS)result=stopped;
 }else{
  ma_mutex_lock(&device->wasapi.rerouteLock);
  const HRESULT stopped=ma_IAudioClient_Stop(static_cast<ma_IAudioClient*>(device->wasapi.pAudioClientPlayback));
  if(FAILED(stopped))result=state.fail(stopped);
  else{
   ma_atomic_bool32_set(&device->wasapi.isStartedPlayback,MA_FALSE);
   state.frozenCommitted=state.committed.load(std::memory_order_acquire);
   state.frozen=auralClockReadOnce(device->wasapi.pAudioClientPlayback);state.frozenReady.store(true,std::memory_order_release);
   // Exclusive event packets cannot be released with zero frames. Stop first,
   // release the complete silent packet, then Reset discards it without Start.
   if(device->wasapi.pMappedBufferPlayback){
    ma_silence_pcm_frames(device->wasapi.pMappedBufferPlayback,device->wasapi.mappedBufferPlaybackCap,device->playback.internalFormat,device->playback.internalChannels);
    result=release(device,state,false);
   }
   if(result==MA_SUCCESS){
    HRESULT hr;int retries=5;
    while((hr=ma_IAudioClient_Reset(static_cast<ma_IAudioClient*>(device->wasapi.pAudioClientPlayback)))==MA_AUDCLNT_E_BUFFER_OPERATION_PENDING&&retries-->0)ma_sleep(10);
    if(FAILED(hr))result=state.fail(hr);
   }
   // Failed submission/reset is fatal. Let the pinned worker cleanup release an
   // outstanding packet on its owning thread, while retaining the first failure.
   if(result!=MA_SUCCESS)(void)ma_device_stop__wasapi_nolock(device);
  }
  if(device->wasapi.hAvrtHandle){((MA_PFN_AvRevertMmThreadCharacteristics)device->pContext->wasapi.AvRevertMmThreadcharacteristics)(static_cast<HANDLE>(device->wasapi.hAvrtHandle));device->wasapi.hAvrtHandle=nullptr;}
  ma_mutex_unlock(&device->wasapi.rerouteLock);
 }
 state.stopResult.store(result,std::memory_order_release);return result;
}
}
