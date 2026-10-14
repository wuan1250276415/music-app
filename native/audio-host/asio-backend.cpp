#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <avrt.h>
#include "../asio-probe/vendor/iasiodrv.h"
#include "asio-dsd.hpp"
#include <variant>
#include <algorithm>
#include <array>
#include <atomic>
#include <stdexcept>
#include <thread>
#if !defined(_M_X64)
#error ASIO backend currently supports only the Windows x64 host
#endif

namespace aural_asio {
static_assert(sizeof(void*)==8&&sizeof(long)==4,"ASIO backend requires Windows x64 ABI");
static_assert(std::atomic<uint64_t>::is_always_lock_free&&std::atomic<void*>::is_always_lock_free,
              "ASIO callbacks require lock-free atomics");
static_assert(std::atomic<uint32_t>::is_always_lock_free&&std::atomic<bool>::is_always_lock_free,
              "ASIO callback flags require lock-free atomics");
constexpr uint32_t maxFrames=32768,maxChannels=16;
static std::string utf8(const std::wstring& input) {
    if(input.empty())return {};
    const int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,input.data(),int(input.size()),nullptr,0,nullptr,nullptr);
    if(n<=0)throw std::runtime_error("ASIO registry text is invalid");
    std::string result(size_t(n),'\0');
    if(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,input.data(),int(input.size()),result.data(),n,nullptr,nullptr)!=n)
        throw std::runtime_error("ASIO registry text conversion failed");
    return result;
}
static std::wstring wide(const std::string& input) {
    if(input.empty()||input.size()>8192||input.find('\0')!=std::string::npos)throw std::runtime_error("ASIO identity is invalid");
    const int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input.data(),int(input.size()),nullptr,0);
    if(n<=0)throw std::runtime_error("ASIO identity is invalid UTF-8");
    std::wstring result(size_t(n),L'\0');
    if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input.data(),int(input.size()),result.data(),n)!=n)
        throw std::runtime_error("ASIO identity conversion failed");
    return result;
}
static std::string driverText(const char* value,size_t capacity) {
    const size_t length=strnlen_s(value,capacity);if(!length)return {};
    const int n=MultiByteToWideChar(CP_ACP,0,value,int(length),nullptr,0);if(n<=0)return "Unavailable";
    std::wstring text(size_t(n),L'\0');
    if(MultiByteToWideChar(CP_ACP,0,value,int(length),text.data(),n)!=n)return "Unavailable";
    for(auto& character:text)if(character<32||character==127)character=L' ';
    return utf8(text);
}
struct RegistryKey {HKEY value=nullptr;~RegistryKey(){if(value)RegCloseKey(value);}};
static std::wstring registryString(HKEY key,const wchar_t* name) {
    DWORD bytes=0;
    if(RegGetValueW(key,nullptr,name,RRF_RT_REG_SZ,nullptr,nullptr,&bytes)!=ERROR_SUCCESS||
       bytes<sizeof(wchar_t)||bytes>8192||bytes%sizeof(wchar_t))return {};
    std::wstring value(bytes/sizeof(wchar_t),L'\0');
    const DWORD capacity=bytes;
    if(RegGetValueW(key,nullptr,name,RRF_RT_REG_SZ,nullptr,value.data(),&bytes)!=ERROR_SUCCESS||bytes>capacity)return {};
    const size_t length=wcsnlen_s(value.data(),value.size());
    if(length==value.size())return {};value.resize(length);return value;
}
static bool guidText(const std::wstring& value) noexcept {
    if(value.size()!=38||value.front()!=L'{'||value.back()!=L'}')return false;
    for(size_t i=1;i<37;++i){
        if(i==9||i==14||i==19||i==24){if(value[i]!=L'-')return false;}
        else if(!((value[i]>=L'0'&&value[i]<=L'9')||(value[i]>=L'a'&&value[i]<=L'f')||(value[i]>=L'A'&&value[i]<=L'F')))return false;
    }
    return true; // Do not let CLSIDFromString resolve/create a ProgID.
}
static std::string description(HKEY key) {
    auto value=registryString(key,L"Description");
    if(value.size()>256){value.resize(256);if(value.back()>=0xd800&&value.back()<=0xdbff)value.pop_back();}
    for(auto& character:value)if(character<32||character==127)character=L' ';
    try{return utf8(value);}catch(const std::runtime_error&){return {};}
}
Catalogue enumerateDrivers() {
    RegistryKey root;Catalogue result;
    result.registryStatus=RegOpenKeyExW(HKEY_LOCAL_MACHINE,L"SOFTWARE\\ASIO",0,
        KEY_QUERY_VALUE|KEY_ENUMERATE_SUB_KEYS|KEY_WOW64_64KEY,&root.value);
    if(result.registryStatus!=ERROR_SUCCESS)return result;
    bool ended=false;
    for(DWORD index=0;index<1024&&result.drivers.size()<256;++index){
        wchar_t name[512]{};DWORD length=512;
        const LONG code=RegEnumKeyExW(root.value,index,name,&length,nullptr,nullptr,nullptr,nullptr);
        if(code==ERROR_NO_MORE_ITEMS){ended=true;break;}
        if(code!=ERROR_SUCCESS){++result.skipped;continue;}
        RegistryKey key;
        if(RegOpenKeyExW(root.value,name,0,KEY_QUERY_VALUE,&key.value)!=ERROR_SUCCESS){++result.skipped;continue;}
        const auto text=registryString(key.value,L"CLSID");CLSID clsid{};wchar_t canonical[40]{};
        if(!guidText(text)||FAILED(CLSIDFromString(text.c_str(),&clsid))||!StringFromGUID2(clsid,canonical,40)){
            ++result.skipped;continue;
        }
        if(std::any_of(name,name+length,[](wchar_t character){return character<32||character==127;})){++result.skipped;continue;}
        try{result.drivers.push_back({utf8(std::wstring(name,length)),utf8(canonical),description(key.value)});}
        catch(const std::runtime_error&){++result.skipped;}
    }
    result.truncated=!ended;
    std::sort(result.drivers.begin(),result.drivers.end(),[](const auto& a,const auto& b){return a.registryName<b.registryName;});
    return result;
}

struct State {
    DWORD thread=GetCurrentThreadId();bool com=false,initialized=false,created=false,createAttempted=false;
    bool prepareAttempted=false,startUsed=false,startAttempted=false,stopConfirmed=false,poisoned=false;
    IASIO* driver=nullptr;HWND window=nullptr;
    std::variant<Configuration,DsdConfiguration> config;RenderTarget target;DsdRenderTarget dsdTarget;PreparedInfo info;
    RenderObservation renderStamp;
    std::array<ASIOBufferInfo,maxChannels> buffers{};
    std::array<Layout,maxChannels> layouts{};
    std::array<int32_t,maxChannels> sampleTypes{};
    std::vector<uint8_t> scratch,planeScratch;
    std::array<size_t,maxChannels> planeOffsets{};
    std::atomic<bool> prepared{false},running{false};
    std::atomic_flag renderBusy=ATOMIC_FLAG_INIT;
    std::atomic<bool> renderActive{false},workerQuit{false},workerMmcss{false};
    std::atomic<int32_t> pendingHalf{-1};
    HANDLE workSignal=nullptr,workerReady=nullptr;std::thread worker;
    std::atomic<uint32_t> events{0};
    std::atomic<uint64_t> callbacksSeen{0},queued{0},music{0},underrun{0},saturated{0},nonfinite{0},readySignals{0},deferred{0};
    std::atomic<uint64_t> discardedBuffers{0},discardedMusic{0},publishedDsdBits{0};
    std::atomic<uint64_t> counterSeq{0},clockSeq{0},clockPosition{0},clockTime{0};
    std::atomic<uint64_t> latencyRevision{0};
    std::atomic<bool> clockValid{false};
};
static bool bitstream(const State& s) noexcept {return std::holds_alternative<DsdConfiguration>(s.config);}
static bool nativeDsd(const State& s) noexcept {return bitstream(s)&&std::get<DsdConfiguration>(s.config).transport==DsdTransport::nativeDsd;}
static uint32_t sourceChannels(const State& s) noexcept {return bitstream(s)?std::get<DsdConfiguration>(s.config).channels:std::get<Configuration>(s.config).source.channels;}
static const std::vector<int32_t>& selectedChannels(const State& s) noexcept {return bitstream(s)?std::get<DsdConfiguration>(s.config).outputChannels:std::get<Configuration>(s.config).outputChannels;}
static uint32_t requestedFrames(const State& s) noexcept {return bitstream(s)?std::get<DsdConfiguration>(s.config).bufferFrames:std::get<Configuration>(s.config).bufferFrames;}
static uint32_t driverRate(const State& s) noexcept {return bitstream(s)?std::get<DsdConfiguration>(s.config).bitRate/(nativeDsd(s)?1:16):std::get<Configuration>(s.config).source.sampleRate;}
static size_t planeBytes(const State& s,uint32_t channel) noexcept {return nativeDsd(s)?s.info.bufferFrames/8:size_t(s.info.bufferFrames)*s.layouts[channel].bytes;}
static void dsdPlane(State& s,uint8_t* output,uint32_t channel,uint32_t count=0,uint64_t validBits=0) noexcept {
    const auto& config=std::get<DsdConfiguration>(s.config);const auto quiet=aural_dsd::silenceAt(config.firstSourceTick);
    if(nativeDsd(s))nativeDsdPlane(output,s.scratch.data(),s.info.bufferFrames/8,count,validBits,channel,config.channels,s.sampleTypes[channel],quiet);
    else dopPlane(output,s.scratch.data(),s.info.bufferFrames,count,validBits,channel,config.channels,s.layouts[channel],quiet);
}
// ASIO has no callback userdata. These gates live until process exit and cover
// ALL callbacks, including messages during create/dispose. Pointer retirement
// precedes draining; an uncertain close permanently forbids another driver.
static std::atomic<State*> owner{nullptr},callbackState{nullptr};
static std::atomic<uint64_t> callbackEntrants{0};
static std::atomic<bool> processPoisoned{false};
static std::atomic<bool> processUsed{false};
struct CallbackGuard {
    State* state;
    CallbackGuard() noexcept {callbackEntrants.fetch_add(1,std::memory_order_seq_cst);state=callbackState.load(std::memory_order_seq_cst);}
    ~CallbackGuard(){callbackEntrants.fetch_sub(1,std::memory_order_seq_cst);}
};
static void controlThread(const State& s) {
    if(s.thread!=GetCurrentThreadId())throw std::runtime_error("ASIO operation left its owning STA thread");
    if(s.poisoned)throw std::runtime_error("ASIO process must be retired");
}
static bool drainCallbacks() noexcept;
static bool drainRender(const State&) noexcept;
static void check(ASIOError code,const char* action) {
    if(code!=ASE_OK)throw std::runtime_error(std::string(action)+" (ASIO "+std::to_string(code)+")");
}
static uint64_t asio64(unsigned long high,unsigned long low) noexcept {return uint64_t(high)<<32|uint64_t(low);}
static bool allowedBuffer(long frames,long minimum,long maximum,long preferred,long granularity) noexcept {
    if(minimum<=0||maximum<minimum||preferred<minimum||preferred>maximum||granularity< -1||
       frames<minimum||frames>maximum||frames<=0||frames>long(maxFrames))return false;
    if(minimum==maximum)return frames==minimum&&preferred==minimum&&granularity==0;
    if(granularity== -1){const uint32_t multiple=uint32_t(frames/minimum);
        return frames%minimum==0&&(multiple&(multiple-1))==0;}
    if(granularity==0)return frames==preferred; // No advertised selectable step.
    return (frames-minimum)%granularity==0;
}
static void clearHalf(State& s,long half) noexcept {
    for(uint32_t channel=0;channel<sourceChannels(s);++channel){
        auto* output=static_cast<uint8_t*>(s.buffers[channel].buffers[half]);
        if(bitstream(s))dsdPlane(s,output,channel);else std::memset(output,0,planeBytes(s,channel));
    }
}
static void writeHalf(State& s,long half,bool notification) noexcept {
    std::memset(s.planeScratch.data(),0,s.planeScratch.size());
    const uint32_t frames=s.info.bufferFrames,channels=sourceChannels(s);
    uint32_t count=0;uint64_t sourceBits=0;PackCounters counters;
    if(bitstream(s))for(uint32_t channel=0;channel<channels;++channel)dsdPlane(s,s.planeScratch.data()+s.planeOffsets[channel],channel);
    if(!(s.events.load(std::memory_order_acquire)&fatalEvents)){
        if(bitstream(s)){
            const uint32_t wanted=s.info.dsdByteFramesPerBuffer;
            const auto read=s.dsdTarget.read(s.dsdTarget.context,s.scratch.data(),wanted);
            const bool valid=read.byteFrames<=wanted&&read.validBitsPerChannel<=uint64_t(read.byteFrames)*8&&
                (!read.byteFrames?read.validBitsPerChannel==0:read.validBitsPerChannel>uint64_t(read.byteFrames-1)*8)&&
                (read.terminal||read.validBitsPerChannel==uint64_t(read.byteFrames)*8)&&
                (nativeDsd(s)||read.terminal||read.byteFrames%2==0);
            if(!valid)s.events.fetch_or(renderContractViolation,std::memory_order_release);
            else{
                sourceBits=read.validBitsPerChannel;
                count=nativeDsd(s)?uint32_t(sourceBits):uint32_t((sourceBits+15)/16);
                for(uint32_t channel=0;channel<channels;++channel)dsdPlane(s,s.planeScratch.data()+s.planeOffsets[channel],channel,read.byteFrames,sourceBits);
            }
        }else{
            const auto& config=std::get<Configuration>(s.config);
            count=s.target.read(s.target.context,s.scratch.data(),frames);
            if(count>frames){s.events.fetch_or(renderContractViolation,std::memory_order_release);count=0;}
            const uint32_t bytes=sourceBytes(config.source.format);
            for(uint32_t channel=0;channel<channels;++channel){
                auto* output=s.planeScratch.data()+s.planeOffsets[channel];
                for(uint32_t frame=0;frame<count;++frame)
                    packSample(s.scratch.data()+(size_t(frame)*channels+channel)*bytes,
                        output+size_t(frame)*s.layouts[channel].bytes,config.source,s.layouts[channel],!config.allowConversion,counters);
            }
            if(counters.invalidPadding)s.events.fetch_or(nonzeroIntegerPadding,std::memory_order_release);
        }
    }
    const uint32_t consumed=count;
    // Convert privately first. A late/reentrant buffer switch must not publish
    // a partially converted block while the driver advances to the next half.
    const uint32_t events=s.events.load(std::memory_order_acquire);
    const bool publish=!(events&invalidCallback)&&(!notification||s.running.load(std::memory_order_acquire));
    if(events&fatalEvents){
        if(bitstream(s))for(uint32_t channel=0;channel<channels;++channel)dsdPlane(s,s.planeScratch.data()+s.planeOffsets[channel],channel);
        else std::memset(s.planeScratch.data(),0,s.planeScratch.size());count=0;sourceBits=0;
    }
    if(publish)for(uint32_t channel=0;channel<channels;++channel)
        std::memcpy(s.buffers[channel].buffers[half],s.planeScratch.data()+s.planeOffsets[channel],planeBytes(s,channel));
    s.counterSeq.fetch_add(1,std::memory_order_acq_rel);
    if(publish){s.queued.fetch_add(frames,std::memory_order_relaxed);s.music.fetch_add(count,std::memory_order_relaxed);
        s.underrun.fetch_add(frames-count,std::memory_order_relaxed);s.publishedDsdBits.fetch_add(sourceBits,std::memory_order_relaxed);}
    if(!publish||consumed>count){s.discardedBuffers.fetch_add(1,std::memory_order_relaxed);s.discardedMusic.fetch_add(!publish?consumed:consumed-count,std::memory_order_relaxed);}
    s.saturated.fetch_add(counters.saturated,std::memory_order_relaxed);s.nonfinite.fetch_add(counters.nonfinite,std::memory_order_relaxed);
    if(publish&&notification&&s.info.outputReadySupported&&s.running.load(std::memory_order_acquire)){
        if(s.driver->outputReady()==ASE_OK)s.readySignals.fetch_add(1,std::memory_order_relaxed);
        else s.events.fetch_or(outputReadyFailed,std::memory_order_release);
    }
    s.counterSeq.fetch_add(1,std::memory_order_release);
    if(publish&&!(s.events.load(std::memory_order_acquire)&fatalEvents)){
        auto observation=s.renderStamp;observation.half=int32_t(half);observation.frames=frames;observation.musicFrames=count;observation.sourceBits=sourceBits;
        if(bitstream(s)){if(s.dsdTarget.published)s.dsdTarget.published(s.dsdTarget.context,observation);}
        else if(s.target.published)s.target.published(s.target.context,observation);
    }
}
static void releaseRender(State& s) noexcept {s.renderActive.store(false,std::memory_order_release);s.renderBusy.clear(std::memory_order_release);}
static void deferredWorker(State* s) noexcept {
    DWORD task=0;HANDLE mmcss=AvSetMmThreadCharacteristicsW(L"Pro Audio",&task);
    s->workerMmcss.store(mmcss!=nullptr,std::memory_order_release);
    if(mmcss)AvSetMmThreadPriority(mmcss,AVRT_PRIORITY_HIGH);
    SetEvent(s->workerReady);
    for(;;){
        const auto code=WaitForSingleObject(s->workSignal,INFINITE);
        if(code!=WAIT_OBJECT_0){s->events.fetch_or(invalidCallback,std::memory_order_release);break;}
        const auto half=s->pendingHalf.exchange(-1,std::memory_order_acq_rel);
        if(half==0||half==1){
            if(s->running.load(std::memory_order_acquire))writeHalf(*s,half,true);else clearHalf(*s,half);
            releaseRender(*s);
        }
        if(s->workerQuit.load(std::memory_order_acquire))break;
    }
    if(mmcss)AvRevertMmThreadCharacteristics(mmcss);
}
static void switchBuffer(ASIOTime* time,long half,ASIOBool direct) noexcept {
    CallbackGuard gate;State* s=gate.state;if(!s)return;
    if(half!=0&&half!=1){s->events.fetch_or(invalidCallback,std::memory_order_release);return;}
    if(!s->prepared.load(std::memory_order_acquire))return;
    // No second writer can touch the shared scratch or the same driver planes.
    if(s->renderBusy.test_and_set(std::memory_order_acquire)){
        if(s->running.load(std::memory_order_acquire))s->events.fetch_or(invalidCallback,std::memory_order_release);return;
    }
    s->renderActive.store(true,std::memory_order_release);
    s->callbacksSeen.fetch_add(1,std::memory_order_relaxed);
    s->renderStamp={};
    if(s->running.load(std::memory_order_acquire)){
        if(time){
            const auto& info=time->timeInfo;
            if(info.flags&kClockSourceChanged)s->events.fetch_or(clockChanged,std::memory_order_release);
            if((info.flags&kSampleRateChanged)||((info.flags&kSampleRateValid)&&
                (!std::isfinite(info.sampleRate)||info.sampleRate!=s->info.sampleRate)))
                s->events.fetch_or(sampleRateChanged,std::memory_order_release);
            s->clockSeq.fetch_add(1,std::memory_order_acq_rel);
            s->clockValid.store((info.flags&(kSystemTimeValid|kSamplePositionValid))==(kSystemTimeValid|kSamplePositionValid),std::memory_order_relaxed);
            s->clockPosition.store(asio64(info.samplePosition.hi,info.samplePosition.lo),std::memory_order_relaxed);
            s->clockTime.store(asio64(info.systemTime.hi,info.systemTime.lo),std::memory_order_relaxed);
            s->renderStamp.clockValid=s->clockValid.load(std::memory_order_relaxed);
            s->renderStamp.samplePosition=s->clockPosition.load(std::memory_order_relaxed);
            s->renderStamp.systemTimeNs=s->clockTime.load(std::memory_order_relaxed);
            s->clockSeq.fetch_add(1,std::memory_order_release);
        }else{
            s->clockSeq.fetch_add(1,std::memory_order_acq_rel);
            s->clockValid.store(false,std::memory_order_relaxed);
            s->clockSeq.fetch_add(1,std::memory_order_release);
        }
    }
        if(direct==ASIOFalse){
            // Respect the driver's low-level scheduling hint. One pre-created
            // worker and one in-flight half; a second switch before completion
            // latches a fault instead of allocating, waiting or queueing audio.
            s->pendingHalf.store(int32_t(half),std::memory_order_release);
            s->deferred.fetch_add(1,std::memory_order_relaxed);
            if(SetEvent(s->workSignal))return; // Worker owns the render guard.
            s->pendingHalf.store(-1,std::memory_order_release);
            s->events.fetch_or(invalidCallback,std::memory_order_release);clearHalf(*s,half);
        }else if(direct==ASIOTrue){
            if(s->running.load(std::memory_order_acquire))writeHalf(*s,half,true);else clearHalf(*s,half);
        }
        else{s->events.fetch_or(invalidCallback,std::memory_order_release);clearHalf(*s,half);}
    releaseRender(*s);
}
static void bufferSwitch(long half,ASIOBool direct) {switchBuffer(nullptr,half,direct);}
static ASIOTime* bufferSwitchTimeInfo(ASIOTime* time,long half,ASIOBool direct) {switchBuffer(time,half,direct);return nullptr;}
static void sampleRateDidChange(ASIOSampleRate rate) {
    CallbackGuard gate;auto* s=gate.state;if(s&&s->prepared.load(std::memory_order_acquire)&&
        (!std::isfinite(rate)||rate!=s->info.sampleRate))s->events.fetch_or(sampleRateChanged,std::memory_order_release);
}
static long asioMessage(long selector,long value,void*,double*) {
    CallbackGuard gate;auto* s=gate.state;if(!s)return 0;
    if(selector==kAsioSelectorSupported)return value==kAsioEngineVersion||value==kAsioSupportsTimeInfo||
        value==kAsioLatenciesChanged||value==kAsioOverload;
    switch(selector){
    case kAsioEngineVersion:return 2;
    case kAsioSupportsTimeInfo:return 1;
    // Retain the request and stop consuming PCM, but do not promise a live
    // reopen until the transport supervisor is connected to this backend.
    case kAsioResetRequest:s->events.fetch_or(resetRequested,std::memory_order_release);return 0;
    case kAsioResyncRequest:s->events.fetch_or(resyncRequested,std::memory_order_release);return 0;
    case kAsioBufferSizeChange:s->events.fetch_or(bufferSizeChanged,std::memory_order_release);return 0;
    case kAsioLatenciesChanged:s->latencyRevision.fetch_add(1,std::memory_order_release);s->events.fetch_or(latenciesChanged,std::memory_order_release);return 1;
    case kAsioOverload:s->events.fetch_or(driverOverload,std::memory_order_release);return 1;
    default:return 0;
    }
}
// Some drivers retain the table pointer itself. Keep it alive for the entire
// process, as well as the callback thunks and their retirement gate.
static ASIOCallbacks callbacks{bufferSwitch,sampleRateDidChange,asioMessage,bufferSwitchTimeInfo};

Engine::Engine()=default;
Engine::~Engine() noexcept {
    if(!close()){
        // An in-process driver can still hold our callbacks or access DMA
        // buffers after an unsuccessful stop/dispose. Never unwind the render
        // context or unload it on faith; this is an isolated-worker-only API.
        TerminateProcess(GetCurrentProcess(),70);std::terminate();
    }
}
void Engine::open(const DriverIdentity& requested) {
    if(state_)throw std::runtime_error("ASIO engine is already open");
    if(processPoisoned.load(std::memory_order_acquire))throw std::runtime_error("ASIO native process must be retired");
    if(processUsed.load(std::memory_order_acquire))throw std::runtime_error("ASIO reopen requires a fresh native process");
    const auto catalogue=enumerateDrivers();
    const auto match=std::find_if(catalogue.drivers.begin(),catalogue.drivers.end(),[&](const auto& value){
        return value.registryName==requested.registryName&&value.clsid==requested.clsid;
    });
    if(match==catalogue.drivers.end())throw std::runtime_error("Selected 64-bit ASIO registration changed or is unavailable");
    auto candidate=std::make_unique<State>();candidate->info.identity=*match;State* empty=nullptr;
    bool unused=false;
    if(!processUsed.compare_exchange_strong(unused,true,std::memory_order_seq_cst))throw std::runtime_error("ASIO reopen requires a fresh native process");
    if(!owner.compare_exchange_strong(empty,candidate.get(),std::memory_order_seq_cst))throw std::runtime_error("Only one ASIO driver may own this process");
    state_=std::move(candidate);auto& s=*state_;callbackState.store(&s,std::memory_order_seq_cst);
    const HRESULT result=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if(FAILED(result))throw std::runtime_error("ASIO STA initialization failed");s.com=true;
    s.window=CreateWindowExW(0,L"STATIC",L"Aural ASIO output",WS_POPUP,0,0,1,1,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
    if(!s.window)throw std::runtime_error("ASIO owner window could not be created");
    CLSID clsid{};const auto clsidText=wide(s.info.identity.clsid);
    if(FAILED(CLSIDFromString(clsidText.c_str(),&clsid))||FAILED(CoCreateInstance(clsid,nullptr,CLSCTX_INPROC_SERVER,clsid,reinterpret_cast<void**>(&s.driver)))||!s.driver)
        throw std::runtime_error("ASIO COM driver could not be loaded");
    if(!s.driver->init(s.window))throw std::runtime_error("ASIO driver initialization failed");s.initialized=true;
    char name[256]{};s.driver->getDriverName(name);s.info.driverName=driverText(name,sizeof(name));s.info.driverVersion=s.driver->getDriverVersion();
}
DriverIdentity Engine::identity() const {
    if(!state_||!state_->initialized)throw std::runtime_error("ASIO driver is not initialized");auto& s=*state_;controlThread(s);return s.info.identity;
}
int32_t Engine::driverVersion() const {
    if(!state_||!state_->initialized)throw std::runtime_error("ASIO driver is not initialized");auto& s=*state_;controlThread(s);return s.info.driverVersion;
}
static void validateConfiguration(const Configuration& config,RenderTarget target) {
    const auto& source=config.source;const auto bytes=sourceBytes(source.format);
    if(!bytes||source.sampleRate<8000||source.sampleRate>1536000||!source.channels||source.channels>maxChannels||
       config.outputChannels.size()!=source.channels||!target.read)throw std::runtime_error("ASIO PCM source or render target is invalid");
    if(floating(source.format)?source.validBits!=bytes*8:(!source.validBits||source.validBits>bytes*8))
        throw std::runtime_error("ASIO PCM valid-bit description is invalid");
    for(size_t i=0;i<config.outputChannels.size();++i)
        if(config.outputChannels[i]<0||std::find(config.outputChannels.begin(),config.outputChannels.begin()+i,config.outputChannels[i])!=config.outputChannels.begin()+i)
            throw std::runtime_error("ASIO output channels must be unique explicit indices");
}
static void readBufferShape(State& s) {
    long minimum=0,maximum=0,preferred=0,granularity=0;
    check(s.driver->getBufferSize(&minimum,&maximum,&preferred,&granularity),"ASIO buffer capability query failed");
    s.info.minimumFrames=minimum;s.info.maximumFrames=maximum;s.info.preferredFrames=preferred;s.info.granularity=granularity;
}
static void readChannelCounts(State& s) {
    long inputs=0,outputs=0;
    check(s.driver->getChannels(&inputs,&outputs),"ASIO channel count query failed");
    if(inputs<0||inputs>4096||outputs<=0||outputs>4096)throw std::runtime_error("ASIO channel counts exceed the capability budget");
    for(const auto channel:selectedChannels(s))if(channel>=outputs)throw std::runtime_error("Selected ASIO output channel no longer exists");
    s.info.inputChannels=inputs;s.info.outputChannels=outputs;
}
DriverCapabilities Engine::inspect() {
    if(!state_||!state_->initialized)throw std::runtime_error("ASIO driver is not initialized");
    auto& s=*state_;controlThread(s);
    if(s.prepareAttempted||s.startUsed||s.createAttempted)throw std::runtime_error("ASIO inspection requires an unprepared session");
    DriverCapabilities result;result.identity=s.info.identity;result.driverName=s.info.driverName;result.driverVersion=s.info.driverVersion;
    readChannelCounts(s);readBufferShape(s);
    result.inputChannels=s.info.inputChannels;result.outputChannels=s.info.outputChannels;
    result.minimumFrames=s.info.minimumFrames;result.maximumFrames=s.info.maximumFrames;
    result.preferredFrames=s.info.preferredFrames;result.granularity=s.info.granularity;
    result.channelsTruncated=result.outputChannels>256;
    for(int32_t index=0;index<std::min<int32_t>(result.outputChannels,256);++index){
        ASIOChannelInfo channel{};channel.channel=index;channel.isInput=ASIOFalse;
        check(s.driver->getChannelInfo(&channel),"ASIO output channel query failed");
        if(channel.channel!=index||channel.isInput!=ASIOFalse)throw std::runtime_error("ASIO channel identity changed during inspection");
        const auto shape=layout(channel.type);
        result.channels.push_back({index,channel.type,channel.channelGroup,driverText(channel.name,sizeof(channel.name)),
            shape.bytes,shape.bits,shape.floating,shape.bigEndian,shape.rightAligned});
    }
    ASIOIoFormat mode{};mode.FormatType=kASIOFormatInvalid;
    const auto status=s.driver->future(kAsioGetIoFormat,&mode);
    if(status==ASE_SUCCESS)result.ioMode=mode.FormatType==kASIOPCMFormat?"pcm":mode.FormatType==kASIODSDFormat?"dsd":"unknown";
    else if(status!=ASE_NotPresent&&status!=ASE_InvalidParameter)result.ioMode="query-failed";
    double rate=0;const auto rateStatus=s.driver->getSampleRate(&rate);
    result.sampleRateKnown=rateStatus==ASE_OK&&std::isfinite(rate)&&rate>=8000&&rate<=(result.ioMode=="dsd"?11289600:1536000);
    result.currentSampleRate=result.sampleRateKnown?rate:0;
    for(const auto requested:{kASIOPCMFormat,kASIODSDFormat}){
        ASIOIoFormat request{};request.FormatType=requested;
        const auto error=s.driver->future(kAsioCanDoIoFormat,&request);
        result.ioFormats.push_back({requested,request.FormatType,error});
    }
    // Rate responses belong to the current mode. Never switch modes or infer
    // DAC DoP recognition from a PCM canSampleRate response.
    constexpr uint32_t pcmRates[]={8000,11025,16000,22050,32000,44100,48000,64000,88200,96000,176400,192000,352800,384000,705600,768000,1411200,1536000};
    constexpr uint32_t dsdRates[]={2822400,5644800,11289600};
    if(result.ioMode=="dsd")for(const auto r:dsdRates)result.sampleRates.push_back({r,s.driver->canSampleRate(r)});
    else for(const auto r:pcmRates)result.sampleRates.push_back({r,s.driver->canSampleRate(r)});
    ASIOIoFormat after{};after.FormatType=kASIOFormatInvalid;double afterRate=0;
    if(s.driver->future(kAsioGetIoFormat,&after)!=status||status==ASE_SUCCESS&&after.FormatType!=mode.FormatType||
        s.driver->getSampleRate(&afterRate)!=rateStatus||result.sampleRateKnown&&(!std::isfinite(afterRate)||afterRate!=rate))
        throw std::runtime_error("ASIO mode or sample rate changed during capability observation");
    readChannelCounts(s);readBufferShape(s);
    if(result.inputChannels!=s.info.inputChannels||result.outputChannels!=s.info.outputChannels||
        result.minimumFrames!=s.info.minimumFrames||result.maximumFrames!=s.info.maximumFrames||result.preferredFrames!=s.info.preferredFrames||result.granularity!=s.info.granularity)
        throw std::runtime_error("ASIO channels or buffer shape changed during capability observation");
    for(const auto& first:result.channels){ASIOChannelInfo channel{};channel.channel=first.index;channel.isInput=ASIOFalse;
        check(s.driver->getChannelInfo(&channel),"ASIO channel observation could not be reconfirmed");
        if(channel.channel!=first.index||channel.isInput!=ASIOFalse||channel.type!=first.sampleType||channel.channelGroup!=first.group)
            throw std::runtime_error("ASIO channel layout changed during capability observation");}
    refreshLatencies();result.latencyKnown=s.info.latencyKnown;
    result.inputLatency=s.info.inputLatency;result.outputLatency=s.info.outputLatency;
    return result;
}
static void readSelectedChannels(State& s) {
    s.info.channels.clear();s.info.numericConversion=false;s.info.exactPackingCandidate=true;
    for(uint32_t ordinal=0;ordinal<sourceChannels(s);++ordinal){
        ASIOChannelInfo channel{};channel.isInput=ASIOFalse;channel.channel=selectedChannels(s)[ordinal];
        check(s.driver->getChannelInfo(&channel),"ASIO output channel query failed");
        if(channel.channel!=selectedChannels(s)[ordinal]||channel.isInput!=ASIOFalse)throw std::runtime_error("ASIO output channel identity changed");
        if(s.created&&channel.isActive!=ASIOTrue)throw std::runtime_error("ASIO selected output channel did not become active");
        auto shape=layout(channel.type);s.sampleTypes[ordinal]=channel.type;
        if(nativeDsd(s)){
            if(!nativeDsdSample(channel.type))throw std::runtime_error("Native DSD requires a reported 1-bit MSB1/LSB1 sample type; NER8 is not raw 1-bit DSD");
            shape={1,1,false,false,false};
        }else if(bitstream(s)){
            if(!dopLayout(shape))throw std::runtime_error("DoP requires an exact integer 24-bit carrier layout, never float or reduced precision");
        }else{
            const auto& config=std::get<Configuration>(s.config);
            if(!shape.bytes)throw std::runtime_error("ASIO PCM backend cannot use DSD or unknown channel types");
            const bool exact=exactPacking(config.source,shape);
            if(!config.allowConversion&&!exact)throw std::runtime_error("ASIO output requires an unauthorized numeric conversion");
            s.info.numericConversion|=!exact;s.info.exactPackingCandidate&=exact;
        }
        s.layouts[ordinal]=shape;
        s.info.channels.push_back({channel.channel,channel.type,channel.channelGroup,driverText(channel.name,sizeof(channel.name)),
            shape.bytes,shape.bits,shape.floating,shape.bigEndian,shape.rightAligned});
    }
}
static void validateBufferMemory(const State& s) {
    std::array<std::pair<uintptr_t,uintptr_t>,maxChannels*2> regions{};size_t used=0;
    for(uint32_t channel=0;channel<sourceChannels(s);++channel)for(unsigned half=0;half<2;++half){
        const uintptr_t begin=reinterpret_cast<uintptr_t>(s.buffers[channel].buffers[half]);
        const size_t bytes=planeBytes(s,channel);
        if(!begin||bytes>std::numeric_limits<uintptr_t>::max()-begin)throw std::runtime_error("ASIO output buffer address is invalid");
        const uintptr_t end=begin+bytes;
        for(size_t previous=0;previous<used;++previous)
            if(begin<regions[previous].second&&regions[previous].first<end)throw std::runtime_error("ASIO output planes or halves overlap");
        regions[used++]={begin,end};
        for(uintptr_t cursor=begin;cursor<end;){
            MEMORY_BASIC_INFORMATION memory{};
            if(!VirtualQuery(reinterpret_cast<const void*>(cursor),&memory,sizeof(memory))||memory.State!=MEM_COMMIT||
               memory.Protect&(PAGE_GUARD|PAGE_NOACCESS))throw std::runtime_error("ASIO output buffer memory is unavailable");
            const DWORD protection=memory.Protect&0xff;
            if(protection!=PAGE_READWRITE&&protection!=PAGE_WRITECOPY&&protection!=PAGE_EXECUTE_READWRITE&&protection!=PAGE_EXECUTE_WRITECOPY)
                throw std::runtime_error("ASIO output buffer memory is not writable");
            const uintptr_t base=reinterpret_cast<uintptr_t>(memory.BaseAddress);
            if(memory.RegionSize>std::numeric_limits<uintptr_t>::max()-base||base+memory.RegionSize<=cursor)
                throw std::runtime_error("ASIO output memory region is invalid");
            cursor=std::min(end,base+memory.RegionSize);
        }
    }
}
const PreparedInfo& Engine::prepare(const Configuration& config,RenderTarget target) {
    if(!state_||!state_->initialized)throw std::runtime_error("ASIO engine has no initialized driver");
    auto& s=*state_;controlThread(s);if(s.prepareAttempted||s.createAttempted||s.startUsed)throw std::runtime_error("ASIO preparation requires a fresh session");s.prepareAttempted=true;
    validateConfiguration(config,target);s.config=config;s.target=target;return prepareOutput();
}
const PreparedInfo& Engine::prepareDsd(const DsdConfiguration& config,DsdRenderTarget target) {
    if(!state_||!state_->initialized)throw std::runtime_error("ASIO engine has no initialized driver");
    auto& s=*state_;controlThread(s);if(s.prepareAttempted||s.createAttempted||s.startUsed)throw std::runtime_error("ASIO DSD preparation requires a fresh session");s.prepareAttempted=true;
    if(!dsdBitRate(config.bitRate)||!config.channels||config.channels>maxChannels||config.outputChannels.size()!=config.channels||!target.read||
        (config.transport!=DsdTransport::nativeDsd&&config.transport!=DsdTransport::dop)||
        (config.transport==DsdTransport::dop&&!config.dopUserConfigured)||(config.transport==DsdTransport::nativeDsd&&config.dopUserConfigured))
        throw std::runtime_error("ASIO DSD bitstream configuration or explicit DoP authorization is invalid");
    for(size_t i=0;i<config.outputChannels.size();++i)
        if(config.outputChannels[i]<0||config.outputChannels[i]>4095||std::find(config.outputChannels.begin(),config.outputChannels.begin()+i,config.outputChannels[i])!=config.outputChannels.begin()+i)
            throw std::runtime_error("ASIO DSD output channels must be unique explicit indices");
    s.config=config;s.dsdTarget=target;s.info.dsdBitstream=true;s.info.dsdBitRate=config.bitRate;s.info.dopUserConfigured=config.dopUserConfigured;
    return prepareOutput();
}
const PreparedInfo& Engine::prepareOutput() {
    auto& s=*state_;const uint32_t channels=sourceChannels(s),rateRequested=driverRate(s);
    const auto desiredMode=nativeDsd(s)?kASIODSDFormat:kASIOPCMFormat;
    if(nativeDsd(s)){
        ASIOIoFormat request{};request.FormatType=kASIODSDFormat;
        if(s.driver->future(kAsioCanDoIoFormat,&request)!=ASE_SUCCESS||request.FormatType!=kASIODSDFormat)
            throw std::runtime_error("ASIO driver did not explicitly report Native DSD I/O support");
    }
    ASIOIoFormat mode{};mode.FormatType=kASIOFormatInvalid;
    const ASIOError modeStatus=s.driver->future(kAsioGetIoFormat,&mode);
    if(modeStatus==ASE_SUCCESS){
        if(mode.FormatType!=desiredMode){
            mode={};mode.FormatType=desiredMode;
            if(s.driver->future(kAsioSetIoFormat,&mode)!=ASE_SUCCESS||mode.FormatType!=desiredMode)
                throw std::runtime_error("ASIO driver refused the requested I/O mode");
            mode={};mode.FormatType=kASIOFormatInvalid;
            if(s.driver->future(kAsioGetIoFormat,&mode)!=ASE_SUCCESS||mode.FormatType!=desiredMode)
                throw std::runtime_error("ASIO requested I/O mode could not be verified");
        }
        s.info.pcmModeReported=!nativeDsd(s);s.info.nativeDsdModeReported=nativeDsd(s);
    }else if(nativeDsd(s)||modeStatus!=ASE_NotPresent&&modeStatus!=ASE_InvalidParameter)
        throw std::runtime_error("ASIO I/O format query failed");
    check(s.driver->canSampleRate(rateRequested),"ASIO source sample rate is unsupported");
    ASIOSampleRate rate=0;const auto currentRateStatus=s.driver->getSampleRate(&rate);
    if(currentRateStatus!=ASE_OK&&currentRateStatus!=ASE_NoClock)check(currentRateStatus,"ASIO current sample rate query failed");
    if(currentRateStatus==ASE_OK&&!std::isfinite(rate))throw std::runtime_error("ASIO current sample rate report is invalid");
    if(currentRateStatus==ASE_NoClock||rate!=rateRequested)check(s.driver->setSampleRate(rateRequested),"ASIO source sample rate selection failed");
    rate=0;check(s.driver->getSampleRate(&rate),"ASIO selected sample rate query failed");
    if(!std::isfinite(rate)||rate!=rateRequested)throw std::runtime_error("ASIO rate differs from the source; implicit resampling is forbidden");
    s.info.sampleRate=rateRequested;
    readChannelCounts(s);
    readBufferShape(s);
    const uint32_t frames=requestedFrames(s)?requestedFrames(s):uint32_t(s.info.preferredFrames);
    if(!allowedBuffer(long(frames),s.info.minimumFrames,s.info.maximumFrames,s.info.preferredFrames,s.info.granularity))
        throw std::runtime_error("ASIO buffer size does not match the advertised range/granularity");
    if(bitstream(s)&&((nativeDsd(s)&&frames%8)||(!nativeDsd(s)&&frames%2)))
        throw std::runtime_error("Native DSD buffers must contain whole bytes; DoP buffers must preserve alternating marker phase");
    s.info.bufferFrames=frames;s.info.dsdByteFramesPerBuffer=bitstream(s)?(nativeDsd(s)?frames/8:frames*2):0;readSelectedChannels(s);
    const size_t scratchBytes=bitstream(s)?size_t(s.info.dsdByteFramesPerBuffer)*channels:size_t(frames)*channels*sourceBytes(std::get<Configuration>(s.config).source.format);
    if(scratchBytes>4*1024*1024)throw std::runtime_error("ASIO callback scratch exceeds its fixed budget");
    s.scratch.assign(scratchBytes,0);
    for(uint32_t channel=0;channel<channels;++channel){s.buffers[channel].isInput=ASIOFalse;s.buffers[channel].channelNum=selectedChannels(s)[channel];}
    s.createAttempted=true;
    check(s.driver->createBuffers(s.buffers.data(),long(channels),long(frames),&callbacks),"ASIO double buffer creation failed");s.created=true;
    // The driver may negotiate a different layout during createBuffers. Verify
    // the actual prepared device again before publishing a plan or consuming PCM.
    readChannelCounts(s);readSelectedChannels(s);readBufferShape(s);rate=0;
    check(s.driver->getSampleRate(&rate),"ASIO prepared sample rate query failed");
    if(rate!=s.info.sampleRate||!allowedBuffer(long(frames),s.info.minimumFrames,s.info.maximumFrames,s.info.preferredFrames,s.info.granularity))
        throw std::runtime_error("ASIO prepared rate or buffer geometry changed");
    if(s.info.pcmModeReported||s.info.nativeDsdModeReported){mode={};mode.FormatType=kASIOFormatInvalid;
        if(s.driver->future(kAsioGetIoFormat,&mode)!=ASE_SUCCESS||mode.FormatType!=desiredMode)
            throw std::runtime_error("ASIO I/O mode changed after buffer creation");}
    for(uint32_t channel=0;channel<channels;++channel)
        if(!s.buffers[channel].buffers[0]||!s.buffers[channel].buffers[1]||s.buffers[channel].isInput!=ASIOFalse||s.buffers[channel].channelNum!=selectedChannels(s)[channel])
            throw std::runtime_error("ASIO returned invalid double buffers");
    validateBufferMemory(s);
    clearHalf(s,0);clearHalf(s,1);
    const auto readyStatus=s.driver->outputReady();
    if(readyStatus!=ASE_OK&&readyStatus!=ASE_NotPresent)check(readyStatus,"ASIO output-ready capability query failed");
    s.info.outputReadySupported=readyStatus==ASE_OK;
    size_t outputBytes=0;
    for(uint32_t channel=0;channel<channels;++channel){s.planeOffsets[channel]=outputBytes;outputBytes+=planeBytes(s,channel);}
    if(outputBytes>4*1024*1024)throw std::runtime_error("ASIO output scratch exceeds its fixed budget");
    s.planeScratch.assign(outputBytes,0);s.info.callbackScratchBytes=uint32_t(scratchBytes+outputBytes);
    refreshLatencies();
    s.workSignal=CreateEventW(nullptr,FALSE,FALSE,nullptr);s.workerReady=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    if(!s.workSignal||!s.workerReady)throw std::runtime_error("ASIO deferred worker events could not be created");
    s.worker=std::thread(deferredWorker,&s);
    if(WaitForSingleObject(s.workerReady,2000)!=WAIT_OBJECT_0)throw std::runtime_error("ASIO deferred worker did not initialize");
    s.info.deferredWorkerMmcss=s.workerMmcss.load(std::memory_order_acquire);
    s.prepared.store(true,std::memory_order_release);
    if(s.events.load(std::memory_order_acquire)&fatalEvents)throw std::runtime_error("ASIO driver requested reconfiguration during preparation");
    return s.info;
}
void Engine::start() {
    if(!state_)throw std::runtime_error("ASIO engine is not open");auto& s=*state_;controlThread(s);
    if(!s.prepared.load(std::memory_order_acquire)||s.startUsed||s.events.load(std::memory_order_acquire)&fatalEvents)
        throw std::runtime_error("ASIO session is not eligible to start");
    s.startUsed=true;
    if(s.renderBusy.test_and_set(std::memory_order_acquire))throw std::runtime_error("ASIO driver rendered before start");
    s.renderActive.store(true,std::memory_order_release);
    // Drivers may invoke their first two switches before hardware starts (SDK
    // 2.3 p.8). Prime with silence so neither startup behavior can overwrite
    // already-consumed source music before an observed callback publication.
    clearHalf(s,1);releaseRender(s);
    s.running.store(true,std::memory_order_release);
    s.startAttempted=true;
    const ASIOError code=s.driver->start();
    if(code!=ASE_OK){s.running.store(false,std::memory_order_release);check(code,"ASIO start failed; session must close");}
}
void Engine::stop() {
    if(!state_)return;auto& s=*state_;controlThread(s);s.running.store(false,std::memory_order_release);
    s.startUsed=true; // Stop also revokes a prepared session that never started.
    if(!drainCallbacks()||!drainRender(s)){
        s.poisoned=true;processPoisoned.store(true,std::memory_order_release);callbackState.store(nullptr,std::memory_order_seq_cst);
        throw std::runtime_error("ASIO render work did not retire before stop; native process must retire");
    }
    if(s.startAttempted&&!s.stopConfirmed){
        const auto code=s.driver->stop();
        if(code!=ASE_OK){s.poisoned=true;processPoisoned.store(true,std::memory_order_release);
            callbackState.store(nullptr,std::memory_order_seq_cst);check(code,"ASIO stop failed; native process must retire");}
        s.stopConfirmed=true;
    }
    if(!drainCallbacks()||!drainRender(s)){
        s.poisoned=true;processPoisoned.store(true,std::memory_order_release);callbackState.store(nullptr,std::memory_order_seq_cst);
        throw std::runtime_error("ASIO stop callbacks did not retire; native process must retire");
    }
}
void Engine::controlPanel() {
    if(!state_||!state_->initialized)throw std::runtime_error("ASIO driver is not initialized");auto& s=*state_;controlThread(s);
    if(s.prepareAttempted||s.startUsed||s.createAttempted||s.running.load(std::memory_order_acquire))throw std::runtime_error("Open ASIO control panel before preparing buffers in a fresh stopped session");
    check(s.driver->controlPanel(),"ASIO control panel is unavailable");
}
void Engine::pumpMessages() {
    if(!state_)return;auto& s=*state_;controlThread(s);MSG message{};
    for(unsigned count=0;count<64&&PeekMessageW(&message,nullptr,0,0,PM_REMOVE);++count){
        if(message.message==WM_QUIT){s.events.fetch_or(ownerQuit,std::memory_order_release);break;}
        TranslateMessage(&message);DispatchMessageW(&message);
    }
}
bool Engine::refreshLatencies() {
    if(!state_||!state_->initialized)return false;auto& s=*state_;controlThread(s);
    const uint64_t observed=s.latencyRevision.load(std::memory_order_acquire);
    long input=0,output=0;const auto code=s.driver->getLatencies(&input,&output);
    s.info.latencyKnown=code==ASE_OK&&input>=0&&output>=0;
    s.info.inputLatency=s.info.latencyKnown?uint32_t(input):0;s.info.outputLatency=s.info.latencyKnown?uint32_t(output):0;
    s.info.observedLatencyRevision=observed; // A notification during the query remains pending.
    return s.info.latencyKnown;
}
Snapshot Engine::snapshot() const noexcept {
    Snapshot result;if(!state_)return result;const auto& s=*state_;
    result.callbacks=s.callbacksSeen.load(std::memory_order_relaxed);
    for(unsigned attempt=0;attempt<4;++attempt){
        const auto before=s.counterSeq.load(std::memory_order_acquire);if(before&1)continue;
        const auto queued=s.queued.load(std::memory_order_relaxed),music=s.music.load(std::memory_order_relaxed),underrun=s.underrun.load(std::memory_order_relaxed);
        const auto saturated=s.saturated.load(std::memory_order_relaxed),nonfinite=s.nonfinite.load(std::memory_order_relaxed),ready=s.readySignals.load(std::memory_order_relaxed);
        const auto discarded=s.discardedBuffers.load(std::memory_order_relaxed),discardedMusic=s.discardedMusic.load(std::memory_order_relaxed);
        const auto dsdBits=s.publishedDsdBits.load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);
        if(before==s.counterSeq.load(std::memory_order_relaxed)){
            result.queuedFrames=queued;result.musicFrames=music;result.underrunFrames=underrun;
            result.saturatedSamples=saturated;result.nonfiniteSamples=nonfinite;result.readySignals=ready;
            result.discardedBuffers=discarded;result.discardedMusicFrames=discardedMusic;result.publishedDsdBits=dsdBits;result.countersValid=true;break;
        }
    }
    result.events=s.events.load(std::memory_order_acquire);
    result.deferredCallbacks=s.deferred.load(std::memory_order_relaxed);
    result.latencyRevision=s.latencyRevision.load(std::memory_order_acquire);
    result.running=s.running.load(std::memory_order_acquire);
    for(unsigned attempt=0;attempt<4;++attempt){
        const auto before=s.clockSeq.load(std::memory_order_acquire);if(before&1)continue;
        const bool valid=s.clockValid.load(std::memory_order_relaxed);
        const auto position=s.clockPosition.load(std::memory_order_relaxed),time=s.clockTime.load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);
        const auto after=s.clockSeq.load(std::memory_order_relaxed);
        if(before==after){result.samplePosition=position;result.systemTimeNs=time;result.clockRevision=after/2;
            result.clockValid=valid&&result.running&&!(result.events&fatalEvents);break;}
    }
    return result;
}
static bool drainCallbacks() noexcept {
    const ULONGLONG deadline=GetTickCount64()+2000;
    while(callbackEntrants.load(std::memory_order_seq_cst)){
        if(GetTickCount64()>=deadline)return false;Sleep(1);
    }
    return true;
}
static bool drainRender(const State& s) noexcept {
    const ULONGLONG deadline=GetTickCount64()+2000;
    while(s.renderActive.load(std::memory_order_acquire)){
        if(GetTickCount64()>=deadline)return false;Sleep(1);
    }
    return true;
}
bool Engine::close() noexcept {
    if(!state_)return true;auto& s=*state_;
    const auto poison=[&]() noexcept {s.poisoned=true;processPoisoned.store(true,std::memory_order_release);return false;};
    if(s.poisoned||s.thread!=GetCurrentThreadId())return poison();
    s.running.store(false,std::memory_order_release);callbackState.store(nullptr,std::memory_order_seq_cst);
    try{
        if(!drainCallbacks()||!drainRender(s))return poison();
        if(s.worker.joinable()){
            s.workerQuit.store(true,std::memory_order_release);
            if(!SetEvent(s.workSignal)||WaitForSingleObject(s.worker.native_handle(),2000)!=WAIT_OBJECT_0)return poison();s.worker.join();
        }
        if(s.workSignal){CloseHandle(s.workSignal);s.workSignal=nullptr;}
        if(s.workerReady){CloseHandle(s.workerReady);s.workerReady=nullptr;}
        if(s.driver&&s.startAttempted&&!s.stopConfirmed){
            if(s.driver->stop()!=ASE_OK)return poison();s.stopConfirmed=true;
        }
        if(!drainCallbacks())return poison();
        s.prepared.store(false,std::memory_order_release);
        if(s.driver&&s.createAttempted){
            const auto code=s.driver->disposeBuffers();
            if(code!=ASE_OK&&(s.created||code!=ASE_InvalidMode))return poison();
        }
        if(!drainCallbacks())return poison();
        // Release relinquishes our reference. Its returned count is diagnostic
        // only, not evidence that every reference in a driver was destroyed.
        if(s.driver){s.driver->Release();s.driver=nullptr;}
        if(!drainCallbacks())return poison();
        if(s.window){if(!DestroyWindow(s.window))return poison();s.window=nullptr;}
        if(s.com){CoUninitialize();s.com=false;}
        owner.store(nullptr,std::memory_order_seq_cst);state_.reset();return true;
    }catch(...){return poison();}
}
}
