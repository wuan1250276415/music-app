#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <atomic>
#include <chrono>
#include <string>
#include "vendor/json.hpp"
#include "release.hpp"
#include "parent-watch.hpp"

namespace {
class Notifications final:public IMMNotificationClient {
 std::atomic<ULONG> references{1};
public:
 std::atomic<unsigned> dirty{0};
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** result) override {
  if(!result)return E_POINTER;*result=nullptr;
  if(iid==__uuidof(IUnknown)||iid==__uuidof(IMMNotificationClient)){*result=static_cast<IMMNotificationClient*>(this);AddRef();return S_OK;}return E_NOINTERFACE;
 }
 ULONG STDMETHODCALLTYPE AddRef() override{return references.fetch_add(1)+1;}
 ULONG STDMETHODCALLTYPE Release() override{const ULONG count=references.fetch_sub(1)-1;if(!count)delete this;return count;}
 HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR,DWORD) override{dirty.fetch_or(1);return S_OK;}
 HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override{dirty.fetch_or(2);return S_OK;}
 HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override{dirty.fetch_or(4);return S_OK;}
 HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow,ERole role,LPCWSTR) override{if(flow==eRender&&role==eConsole)dirty.fetch_or(8);return S_OK;}
 HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR,const PROPERTYKEY) override{dirty.fetch_or(16);return S_OK;}
};
struct Registration {
 IMMDeviceEnumerator* enumerator=nullptr;Notifications* sink=nullptr;bool registered=false,apartment=false;
 ~Registration(){if(registered)enumerator->UnregisterEndpointNotificationCallback(sink);if(enumerator)enumerator->Release();if(sink)sink->Release();if(apartment)CoUninitialize();}
};
bool emit(const std::string& nonce,const char* kind,uint64_t sequence,unsigned flags){
 using json=nlohmann::json;json reasons=json::array();const char* names[]={"state","added","removed","default-output","properties"};for(unsigned bit=0;bit<5;++bit)if(flags&(1U<<bit))reasons.push_back(names[bit]);
 const auto body=json({{"protocol",{{"major",aural_release::protocol_major},{"minor",aural_release::protocol_minor}}},{"buildId",aural_release::host_build_id},{"nonce",nonce},{"backend","wasapi"},{"kind",kind},{"sequence",std::to_string(sequence)},{"reasons",reasons}}).dump();
 if(body.size()>4096)return false;std::string frame(4,'\0');for(int i=0;i<4;++i)frame[i]=static_cast<char>(body.size()>>(8*i));frame+=body;size_t offset=0;
 while(offset<frame.size()){DWORD written=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),frame.data()+offset,static_cast<DWORD>(frame.size()-offset),&written,nullptr)||!written)return false;offset+=written;}return true;
}
}

int auralDeviceNotifications(const wchar_t* nonce,const wchar_t* parent){
 aural_devices::ParentWatch watch;if(!watch.init(parent))return 70;const std::wstring token(nonce);if(token.size()!=36)return 64;std::string identity;for(wchar_t c:token){if(c>127)return 64;identity.push_back(static_cast<char>(c));}
 Registration registration;const HRESULT init=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(init))return 65;registration.apartment=true;
 if(FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),reinterpret_cast<void**>(&registration.enumerator))))return 65;
 registration.sink=new Notifications();if(FAILED(registration.enumerator->RegisterEndpointNotificationCallback(registration.sink)))return 66;registration.registered=true;
 uint64_t sequence=1;if(!emit(identity,"ready",sequence,0))return 68;
 auto lastChange=std::chrono::steady_clock::now(),lastHeartbeat=lastChange;
 for(;;){
  Sleep(50);const auto now=std::chrono::steady_clock::now();
  if(now-lastChange>=std::chrono::milliseconds(250)){
   const unsigned flags=registration.sink->dirty.exchange(0);if(flags){if(sequence==UINT64_MAX||!emit(identity,"changed",++sequence,flags))return 68;lastChange=now;}
  }
  if(now-lastHeartbeat>=std::chrono::seconds(2)){if(sequence==UINT64_MAX||!emit(identity,"heartbeat",++sequence,0))return 68;lastHeartbeat=now;}
 }
}
