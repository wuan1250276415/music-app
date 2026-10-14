#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <initguid.h>
#include <ks.h>
#include <ksmedia.h>
#include <string>
#include <thread>
#include <tlhelp32.h>
#include <cstdio>
#include "vendor/json.hpp"
#include "release.hpp"
#include "parent-watch.hpp"

namespace {
using json=nlohmann::json;
template<class T> struct Com {T* p=nullptr;~Com(){if(p)p->Release();}};
struct Apartment {HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);~Apartment(){if(SUCCEEDED(hr))CoUninitialize();}};
struct Memory {WAVEFORMATEX* p=nullptr;~Memory(){CoTaskMemFree(p);}};
std::string hex(HRESULT hr){char buffer[11]{};snprintf(buffer,sizeof(buffer),"0x%08X",static_cast<unsigned>(hr));return buffer;}
json describe(const WAVEFORMATEX* w){
 if(!w||!w->nSamplesPerSec||w->nSamplesPerSec>1536000||!w->nChannels||w->nChannels>32)return nullptr;
 WORD valid=w->wBitsPerSample;DWORD mask=0;std::string format="unknown",representation="waveformatex";
 if(w->wFormatTag==WAVE_FORMAT_PCM)format=w->wBitsPerSample==8?"u8":"pcm";
 else if(w->wFormatTag==WAVE_FORMAT_IEEE_FLOAT)format="float";
 else if(w->wFormatTag==WAVE_FORMAT_EXTENSIBLE){
  if(w->cbSize<22)return nullptr;const auto& ext=*reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(w);valid=ext.Samples.wValidBitsPerSample;mask=ext.dwChannelMask;representation="extensible";
  if(IsEqualGUID(ext.SubFormat,KSDATAFORMAT_SUBTYPE_PCM))format=w->wBitsPerSample==8?"u8":"pcm";
  else if(IsEqualGUID(ext.SubFormat,KSDATAFORMAT_SUBTYPE_IEEE_FLOAT))format="float";
 }
 if(valid>w->wBitsPerSample||w->wBitsPerSample>64)return nullptr;
 return {{"format",format},{"containerBits",w->wBitsPerSample},{"validBits",valid},{"sampleRate",w->nSamplesPerSec},{"channels",w->nChannels},{"channelMask",mask},{"representation",representation}};
}
bool send(const json& result){
 const auto body=result.dump();if(body.size()>256*1024)return false;const uint32_t length=static_cast<uint32_t>(body.size());std::string frame(4,'\0');for(int i=0;i<4;++i)frame[i]=static_cast<char>(length>>(8*i));frame+=body;
 size_t offset=0;while(offset<frame.size()){DWORD wrote=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),frame.data()+offset,static_cast<DWORD>(frame.size()-offset),&wrote,nullptr)||!wrote)return false;offset+=wrote;}return true;
}
}

// Read-only driver queries. No Initialize/Start and no capability cache.
int auralDeviceCapabilities(const wchar_t* nonce,const wchar_t* parent,const wchar_t* endpoint){
 aural_devices::ParentWatch watch;if(!watch.init(parent))return 70;
 const std::wstring token(nonce),id(endpoint);if(token.size()!=36||id.empty()||id.size()>63)return 64;
 auto utf8=[](const std::wstring& text){const int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);std::string s(n>0?n:0,'\0');if(n>0)WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),&s[0],n,nullptr,nullptr);return s;};
 const auto endpointId=utf8(id),tokenId=utf8(token);if(endpointId.empty()||endpointId.size()>255||tokenId.size()!=36)return 64;
 Apartment apartment;if(FAILED(apartment.hr))return 65;
 Com<IMMDeviceEnumerator> enumerator;HRESULT hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,__uuidof(IMMDeviceEnumerator),reinterpret_cast<void**>(&enumerator.p));if(FAILED(hr))return 65;
 Com<IMMDevice> device;hr=enumerator.p->GetDevice(endpoint,&device.p);if(FAILED(hr))return 66;
 DWORD state=0;if(FAILED(device.p->GetState(&state))||state!=DEVICE_STATE_ACTIVE)return 66;
 Com<IAudioClient> client;hr=device.p->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,reinterpret_cast<void**>(&client.p));if(FAILED(hr))return 66;
 Memory mix;const HRESULT mixHr=client.p->GetMixFormat(&mix.p);const json mixFormat=SUCCEEDED(mixHr)?describe(mix.p):json(nullptr);
 REFERENCE_TIME normal=0,minimum=0;const HRESULT periodHr=client.p->GetDevicePeriod(&normal,&minimum);
 const bool periodsValid=SUCCEEDED(periodHr)&&normal>0&&minimum>0&&minimum<=normal&&normal<=100000000;
 json probes=json::array();bool incomplete=(!mixFormat.is_object()||!periodsValid);
 const DWORD rates[]={8000,11025,16000,22050,32000,44100,48000,88200,96000,176400,192000,352800,384000,705600,768000};
 const WORD channels[]={1,2,4,6,8};const DWORD masks[]={SPEAKER_FRONT_CENTER,SPEAKER_FRONT_LEFT|SPEAKER_FRONT_RIGHT,KSAUDIO_SPEAKER_QUAD,KSAUDIO_SPEAKER_5POINT1_SURROUND,KSAUDIO_SPEAKER_7POINT1_SURROUND};
 struct Sample{WORD container,valid;bool floating;};const Sample samples[]={{8,8,false},{16,16,false},{24,24,false},{32,24,false},{32,32,false},{32,32,true}};
 for(DWORD rate:rates)for(size_t c=0;c<5;++c)for(const auto& sample:samples)for(int legacy=0;legacy<2;++legacy){
  if(legacy&&(channels[c]>2||sample.valid!=sample.container))continue;
  WAVEFORMATEXTENSIBLE wave{};wave.Format.wFormatTag=legacy?(sample.floating?WAVE_FORMAT_IEEE_FLOAT:WAVE_FORMAT_PCM):WAVE_FORMAT_EXTENSIBLE;wave.Format.nChannels=channels[c];wave.Format.nSamplesPerSec=rate;wave.Format.wBitsPerSample=sample.container;wave.Format.nBlockAlign=channels[c]*sample.container/8;wave.Format.nAvgBytesPerSec=rate*wave.Format.nBlockAlign;wave.Format.cbSize=legacy?0:22;wave.Samples.wValidBitsPerSample=sample.valid;wave.dwChannelMask=masks[c];wave.SubFormat=sample.floating?KSDATAFORMAT_SUBTYPE_IEEE_FLOAT:KSDATAFORMAT_SUBTYPE_PCM;
  const HRESULT result=client.p->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE,&wave.Format,nullptr);json row=describe(&wave.Format);row["status"]=result==S_OK?"reported":result==AUDCLNT_E_UNSUPPORTED_FORMAT?"unsupported":"error";row["hresult"]=hex(result);probes.push_back(row);
  if(result!=S_OK&&result!=AUDCLNT_E_UNSUPPORTED_FORMAT)incomplete=true;
  if(result==AUDCLNT_E_DEVICE_INVALIDATED||result==AUDCLNT_E_SERVICE_NOT_RUNNING)return 66;
 }
 // Reject a removed/reconfigured endpoint rather than deliver an apparently fresh report.
 if(FAILED(device.p->GetState(&state))||state!=DEVICE_STATE_ACTIVE)return 66;
 json periods=periodsValid?json({{"default100ns",std::to_string(normal)},{"minimum100ns",std::to_string(minimum)}}):json(nullptr);
 const json info={{"deviceId",endpointId},{"evidence","driver-reported"},{"driverVersion",nullptr},{"firmwareVersion",nullptr},{"mixFormat",mixFormat},{"mixHresult",hex(mixHr)},{"periods",periods},{"periodHresult",hex(periodHr)},{"exclusiveProbes",probes},{"matrixVersion","wasapi-pcm-candidates-v1"},{"incomplete",incomplete},{"hardwareVerified",false}};
 return send({{"protocol",{{"major",aural_release::protocol_major},{"minor",aural_release::protocol_minor}}},{"buildId",aural_release::host_build_id},{"nonce",tokenId},{"backend","wasapi"},{"capabilities",info}})?0:68;
}
