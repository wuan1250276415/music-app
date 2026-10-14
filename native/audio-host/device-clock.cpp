#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include "device-clock.hpp"
namespace {
struct Clock {IAudioClock* clock=nullptr;uint64_t frequency=0;HRESULT result=E_NOINTERFACE;bool apartment=false;~Clock(){if(clock)clock->Release();if(apartment)CoUninitialize();}};
}
// GetService, GetPosition and Release all run on the host control thread.
void* auralClockOpen(void* client){
 auto* handle=new Clock();const HRESULT init=CoInitializeEx(nullptr,COINIT_MULTITHREADED);handle->apartment=SUCCEEDED(init);
 if(FAILED(init)&&init!=RPC_E_CHANGED_MODE){handle->result=init;return handle;}
 if(client)handle->result=static_cast<IAudioClient*>(client)->GetService(__uuidof(IAudioClock),reinterpret_cast<void**>(&handle->clock));
 if(SUCCEEDED(handle->result)&&handle->clock)handle->result=handle->clock->GetFrequency(&handle->frequency);
 return handle;
}
AuralClockReading auralClockRead(void* pointer){
 AuralClockReading reading;auto* handle=static_cast<Clock*>(pointer);if(!handle)return reading;reading.result=handle->result;reading.frequency=handle->frequency;
 if(!handle->clock||FAILED(handle->result)||!handle->frequency)return reading;
 const HRESULT hr=handle->clock->GetPosition(&reading.position,&reading.qpc100ns);reading.result=hr;reading.available=SUCCEEDED(hr);reading.precise=hr==S_OK;return reading;
}
void auralClockClose(void* pointer){delete static_cast<Clock*>(pointer);}
AuralClockReading auralClockReadOnce(void* client){
 Clock handle;const HRESULT init=CoInitializeEx(nullptr,COINIT_MULTITHREADED);handle.apartment=SUCCEEDED(init);
 if(FAILED(init)&&init!=RPC_E_CHANGED_MODE){handle.result=init;return auralClockRead(&handle);}
 if(client)handle.result=static_cast<IAudioClient*>(client)->GetService(__uuidof(IAudioClock),reinterpret_cast<void**>(&handle.clock));
 if(SUCCEEDED(handle.result)&&handle.clock)handle.result=handle.clock->GetFrequency(&handle.frequency);
 return auralClockRead(&handle);
}
AuralPaddingReading auralPaddingRead(void* client){
 AuralPaddingReading reading;if(!client){reading.result=E_POINTER;return reading;}
 reading.result=static_cast<IAudioClient*>(client)->GetCurrentPadding(&reading.frames);reading.available=reading.result==S_OK;return reading;
}
