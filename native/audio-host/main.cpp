#define NOMINMAX
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include "vendor/json.hpp"
#include "release.hpp"
#include "asio-backend.hpp"
#include "asio-dsd-stream.hpp"
#include "cue-frames.hpp"
#include "cue-timeline.hpp"
#include "source-sample-span.hpp"
#include "pcm-ring.hpp"
#include "analysis-tap.hpp"
#include "ffmpeg-decoder.hpp"
#include "dsd-description.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <deque>
#include <iostream>
#include <mutex>
#include <memory>
#include <sddl.h>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#include <windows.h>

using json = nlohmann::json;
#include "wasapi-devices.hpp"
#include "asio-query.hpp"
#include "presentation-clock.hpp"
#include "wasapi-submission.hpp"
#include "playback-tail.hpp"
#include "gain-processing.hpp"
#include "live-gain.hpp"
#include "pipeline-plan.hpp"

static void wasapiDiagnosticLog(void*, ma_uint32 level, const char* message) {
    // Device setup diagnostics only. Keep callback traffic and log size bounded;
    // source paths and metadata are never sent through this diagnostic lane.
    static std::atomic<unsigned> messages{0};
    if (level > MA_LOG_LEVEL_WARNING || !message || messages.fetch_add(1) >= 32) return;
    std::cerr << "[wasapi-backend] " << std::string(message).substr(0, 1024) << std::endl;
}

// The decoder runs on a producer thread. The WASAPI callback copies decoded
// frames from a bounded SPSC buffer, applies the bounded float gain envelope,
// and pads underruns. It performs no allocation, control lock or media I/O.
// An integer callback format is not proof of bit-perfect device output.
struct Player {
    AuralPcmDecoder decoder;
    ma_context context{};
    ma_device device{};
    std::vector<uint8_t> ring;
    ma_format format = ma_format_f32;
    uint32_t bytesPerFrame = 0;
    uint64_t capacityFrames = 0;
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
    uint64_t maxFrames = UINT64_MAX;
    uint64_t boundaryRelativeFrame = UINT64_MAX;
    std::atomic<uint64_t> readFrames{0};
    std::atomic<uint64_t> writeFrames{0};
    std::atomic<uint64_t> positionBaseFrames{0};
    // Session-local counters. Only the callback writes; the control thread reads.
    std::atomic<uint64_t> callbackCount{0};
    std::atomic<uint64_t> bufferUnderrunCallbacks{0};
    std::atomic<uint64_t> bufferUnderrunFrames{0};
    std::atomic<bool> eof{false};
    std::atomic<bool> decodeFailed{false};
    std::atomic<bool> stopping{false};
    std::atomic<bool> finished{false};
    std::atomic<bool> expectDeviceStopped{true};
    std::atomic<bool> deviceLost{false};
    std::atomic<bool> boundaryReached{false};
    // 0: pending, 1: crossed, 2: cancelled before the second span.
    std::atomic<int> boundaryState{0};
    std::thread producer;
    aural_analysis::Tap analysis;
    aural_conversion::Pump conversion;
    aural_clock::Presentation clock;
    aural_output::Submission submission;
    aural_tail::Completion tail;
    aural_gain::Plan gains[2];
    aural_gain::LiveGain liveGain;uint64_t volumeRevision=0;
    std::atomic<int> reportedGainSegment{0};
    std::atomic<uint64_t> gainClipped{0},gainInvalid{0};
};

static void deviceNotification(const ma_device_notification* note) {
    auto* player=static_cast<Player*>(note->pDevice->pUserData);if(!player||player->stopping.load())return;
    if(note->type==ma_device_notification_type_rerouted||note->type==ma_device_notification_type_interruption_began||
       (note->type==ma_device_notification_type_stopped&&!player->expectDeviceStopped.load()&&player->tail.status()!=3))player->deviceLost=true;
}
static ma_result stopDevice(Player& player,bool discard=false){
 player.expectDeviceStopped=true;player.submission.discard=discard;
 const auto result=ma_device_stop(&player.device);
 return result==MA_SUCCESS?player.submission.stopResult.load(std::memory_order_acquire):result;
}
static ma_result startDevice(Player& player){player.expectDeviceStopped=false;player.submission.discard=false;player.submission.stopResult=MA_SUCCESS;return ma_device_start(&player.device);}
static ma_result trackedWrite(ma_device* device,const void* frames,ma_uint32 count,ma_uint32* written){return aural_output::write(device,frames,count,written,static_cast<Player*>(device->pUserData)->submission);}
static ma_result trackedStop(ma_device* device){auto* player=static_cast<Player*>(device->pUserData);if(player->tail.ready.load())player->submission.discard=true;const auto result=aural_output::stop(device,player->submission);player->tail.stopped(result);return result;}
static ma_result trackedDataLoop(ma_device* device){auto* player=static_cast<Player*>(device->pUserData);return player->conversion.run(device,player->submission,player->tail,[&]{return aural_output::release(device,player->submission,true);});}
static void callback(ma_device* device, void* output, const void*, ma_uint32 frameCount) {
    auto* player = static_cast<Player*>(device->pUserData);
    const uint64_t before=player->readFrames.load(std::memory_order_relaxed);
    const uint64_t position=player->positionBaseFrames.load(std::memory_order_relaxed)+before;
    consumePcmFrames(*player,output,frameCount);
    const uint64_t count=player->readFrames.load(std::memory_order_relaxed)-before;
    player->clock.timeline.push(frameCount,position,count);
    player->tail.noteInput(frameCount,count,position+count,player->finished.load()&&!player->decodeFailed.load());
    if(player->format==ma_format_f32)player->liveGain.render(static_cast<uint8_t*>(output),count,player->channels,position,player->boundaryRelativeFrame,player->gainClipped,player->gainInvalid);
    player->analysis.capture(output,static_cast<uint32_t>(count),position);
}

static void decodeLoop(Player* player) {
    std::vector<uint8_t> temp(size_t(2048) * player->bytesPerFrame);
    uint64_t produced = 0;
    while (!player->stopping.load(std::memory_order_acquire)) {
        const uint64_t read = player->readFrames.load(std::memory_order_acquire);
        const uint64_t written = player->writeFrames.load(std::memory_order_relaxed);
        const uint64_t freeFrames = player->capacityFrames - (written - read);
        const uint64_t remaining = player->maxFrames - produced;
        const ma_uint64 wanted = std::min<uint64_t>({2048,freeFrames,remaining});
        if (wanted == 0) {
            if (remaining == 0) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(3));
            continue;
        }
        ma_uint64 got = 0;
        const ma_result rc = player->decoder.read(temp.data(), wanted, &got);
        if(rc!=MA_SUCCESS&&rc!=MA_AT_END){if(!player->stopping.load())player->decodeFailed=true;break;}
        if(got==0)break;
        // Publish unprocessed PCM; bounded gain runs on actual consumed frames in the callback.
        const uint64_t first = std::min<uint64_t>(got, player->capacityFrames - (written % player->capacityFrames));
        std::memcpy(player->ring.data() + (written % player->capacityFrames) * player->bytesPerFrame, temp.data(), first * player->bytesPerFrame);
        if (got > first) std::memcpy(player->ring.data(), temp.data() + first * player->bytesPerFrame, (got - first) * player->bytesPerFrame);
        produced += got;
        player->writeFrames.store(written + got, std::memory_order_release);
        if (got < wanted || rc == MA_AT_END) break;
    }
    player->eof.store(true, std::memory_order_release);
}

static constexpr uint32_t MAX_MESSAGE = aural_release::max_message_bytes;

static bool pipeIo(HANDLE pipe,bool writing,void* bytes,DWORD count,DWORD& transferred,uint64_t deadline=0) {
    if(deadline&&GetTickCount64()>=deadline)return false;
    OVERLAPPED operation{};
    operation.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    if (!operation.hEvent) return false;
    const BOOL immediate=writing?WriteFile(pipe,bytes,count,&transferred,&operation):ReadFile(pipe,bytes,count,&transferred,&operation);
    bool ok=immediate!=FALSE;
    if (!ok && GetLastError()==ERROR_IO_PENDING){
        if(deadline){
            const uint64_t now=GetTickCount64();
            const DWORD timeout=now>=deadline?0:DWORD(std::min<uint64_t>(deadline-now,0xfffffffe));
            if(WaitForSingleObject(operation.hEvent,timeout)!=WAIT_OBJECT_0){
                CancelIoEx(pipe,&operation);GetOverlappedResult(pipe,&operation,&transferred,TRUE);
                CloseHandle(operation.hEvent);return false;
            }
        }
        ok=GetOverlappedResult(pipe,&operation,&transferred,TRUE)!=FALSE;
    }
    CloseHandle(operation.hEvent);
    return ok;
}

struct Channel {
    HANDLE pipe = INVALID_HANDLE_VALUE;
    std::recursive_mutex writes;
    std::string session;
    std::atomic<uint64_t> sequence{0};
    std::atomic<uint64_t> generation{0};
    bool send(const json& value) {
        const std::string body = value.dump();
        if (body.empty() || body.size() > MAX_MESSAGE) return false;
        const uint32_t size = static_cast<uint32_t>(body.size());
        unsigned char header[4] = {static_cast<unsigned char>(size),static_cast<unsigned char>(size >> 8),
                                   static_cast<unsigned char>(size >> 16),static_cast<unsigned char>(size >> 24)};
        std::string frame(reinterpret_cast<const char*>(header),4);
        frame+=body;
        std::lock_guard<std::recursive_mutex> lock(writes);
        DWORD sent=0;
        return pipeIo(pipe,true,&frame[0],static_cast<DWORD>(frame.size()),sent) && sent==frame.size();
    }
    void event(const char* name,const json& payload=json::object(),const std::string& causedBy="") {
        std::lock_guard<std::recursive_mutex> lock(writes);
        std::string eventName=std::string("playback.")+name;
        json eventPayload=payload;
        if (eventName=="playback.playing" || eventName=="playback.paused" ||
            eventName=="playback.resumed" || eventName=="playback.ended" || eventName=="playback.stopped") {
            eventPayload["state"]=name==std::string("resumed")?"playing":name;
            eventName="playback.stateChanged";
        }
        send({{"protocol",{{"major",aural_release::protocol_major},{"minor",aural_release::protocol_minor}}},{"kind","event"},{"sessionId",session},
              {"sequence",std::to_string(++sequence)},{"generation",generation.load()},
              {"event",eventName},{"causedBy",causedBy},{"payload",eventPayload}});
    }
    void receipt(const std::string& requestId,const std::string& commandId,bool accepted,
                 const std::string& error="",uint64_t originalGeneration=UINT64_MAX) {
        send({{"protocol",{{"major",aural_release::protocol_major},{"minor",aural_release::protocol_minor}}},{"kind","receipt"},{"sessionId",session},
              {"requestId",requestId},{"commandId",commandId},
              {"accepted",accepted},{"generation",originalGeneration==UINT64_MAX?generation.load():originalGeneration},{"error",error}});
    }
};

static bool readExact(HANDLE pipe,void* target,DWORD count,uint64_t deadline=0) {
    auto* bytes=static_cast<unsigned char*>(target);
    while (count) {
        DWORD got=0;
        if (!pipeIo(pipe,false,bytes,count,got,deadline) || got==0) return false;
        bytes+=got;count-=got;
    }
    return true;
}

static bool readFrame(HANDLE pipe,json& value,uint64_t deadline=0) {
    unsigned char header[4];
    if (!readExact(pipe,header,4,deadline)) return false;
    const uint32_t size=uint32_t(header[0]) | (uint32_t(header[1])<<8) | (uint32_t(header[2])<<16) | (uint32_t(header[3])<<24);
    if (!size || size>MAX_MESSAGE) return false;
    std::string body(size,'\0');
    if (!readExact(pipe,&body[0],size,deadline)) return false;
    value=json::parse(body,nullptr,false);
    return value.is_object()&&(!deadline||GetTickCount64()<deadline);
}

static std::string stringField(const json& value,const char* key) {
    const auto field=value.find(key);
    return field!=value.end() && field->is_string()?field->get<std::string>():std::string();
}
static uint64_t unsignedField(const json& value,const char* key,uint64_t fallback=UINT64_MAX) {
    const auto field=value.find(key);
    if (field==value.end() || !field->is_number_integer()) return fallback;
    if (field->is_number_unsigned()) return field->get<uint64_t>();
    const int64_t signedValue=field->get<int64_t>();
    return signedValue>=0?uint64_t(signedValue):fallback;
}
static double numberField(const json& value,const char* key,double fallback=-1) {
    const auto field=value.find(key);
    return field!=value.end() && field->is_number()?field->get<double>():fallback;
}
static bool decimalField(const json& value,const char* key,uint64_t& result) {
    const auto field=value.find(key);
    if(field==value.end() || !field->is_string()) return false;
    const std::string digits=field->get<std::string>();
    if(digits.empty() || digits.size()>20) return false;
    uint64_t parsed=0;
    for(const char digit:digits) {
        if(digit<'0'||digit>'9'||parsed>(UINT64_MAX-uint64_t(digit-'0'))/10) return false;
        parsed=parsed*10+uint64_t(digit-'0');
    }
    result=parsed;return true;
}
static bool protocolOne(const json& value) {
    const auto protocol=value.find("protocol");
    return protocol!=value.end() && protocol->is_object() && unsignedField(*protocol,"major")==aural_release::protocol_major;
}

static std::wstring utf8ToWide(const std::string& text) {
    const int needed=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);
    if (needed<=0) return {};
    std::wstring result(needed,L'\0');
    if (!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),&result[0],needed)) return {};
    return result;
}

static const char* formatName(ma_format format) {
    return aural_pipeline::format(format);
}

static HANDLE createPrivatePipe(const wchar_t* name) {
    HANDLE token=nullptr;
    if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return INVALID_HANDLE_VALUE;
    DWORD needed=0;
    GetTokenInformation(token,TokenUser,nullptr,0,&needed);
    std::vector<unsigned char> storage(needed);
    if (!needed || !GetTokenInformation(token,TokenUser,storage.data(),needed,&needed)) {
        CloseHandle(token);return INVALID_HANDLE_VALUE;
    }
    CloseHandle(token);
    auto* user=reinterpret_cast<TOKEN_USER*>(storage.data());
    LPWSTR sid=nullptr;
    if (!ConvertSidToStringSidW(user->User.Sid,&sid)) return INVALID_HANDLE_VALUE;
    const std::wstring sddl=std::wstring(L"D:P(A;;GA;;;")+sid+L")(A;;GA;;;SY)";
    LocalFree(sid);
    PSECURITY_DESCRIPTOR descriptor=nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))
        return INVALID_HANDLE_VALUE;
    SECURITY_ATTRIBUTES attributes={sizeof(SECURITY_ATTRIBUTES),descriptor,FALSE};
    HANDLE pipe=CreateNamedPipeW(name,PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE|FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,65536,65536,0,&attributes);
    LocalFree(descriptor);
    return pipe;
}

static int fail(Channel& channel,const char* stage,int result) {
    std::cerr << stage << " failed: " << result << std::endl;
    channel.event("error",{{"message",std::string(stage)+" failed ("+std::to_string(result)+")"}});
    return 2;
}

int auralDeviceCapabilities(const wchar_t*,const wchar_t*,const wchar_t*);
int auralDeviceNotifications(const wchar_t*,const wchar_t*);
#include "asio-session.hpp"
#include "asio-dsd-session.hpp"
#include "asio-panel.hpp"
int wmain(int argc,wchar_t** argv) {
    if(argc==7&&std::wstring(argv[1])==L"--asio-panel")try{return aural_asio_panel::run(argv[2],argv[3],argv[4],argv[5],argv[6]);}catch(...){return 69;}
    if(argc==4&&std::wstring(argv[1])==L"--asio-catalog")try{return aural_asio_query::report(argv[2],argv[3]);}catch(...){return 69;}
    if(argc==6&&std::wstring(argv[1])==L"--asio-info")try{return aural_asio_query::report(argv[2],argv[3],argv[4],argv[5]);}catch(...){return 69;}
    if(argc==2&&std::wstring(argv[1])==L"--asio-drivers")try{
        const auto catalogue=aural_asio::enumerateDrivers();json drivers=json::array();
        for(const auto& entry:catalogue.drivers)drivers.push_back({{"registryName",entry.registryName},{"clsid",entry.clsid},{"description",entry.description}});
        std::cout<<json{{"version",1},{"hostBuildId",aural_release::host_build_id},{"architecture","x64"},
            {"registryStatus",catalogue.registryStatus},{"truncated",catalogue.truncated},{"skipped",catalogue.skipped},{"drivers",drivers}}.dump()<<std::endl;
        return catalogue.registryStatus==0||catalogue.registryStatus==ERROR_FILE_NOT_FOUND?0:69;
    }catch(...){return 69;}
    if(argc==4&&std::wstring(argv[1])==L"--device-watch")try{return auralDeviceNotifications(argv[2],argv[3]);}catch(...){return 69;}
    if(argc==5&&std::wstring(argv[1])==L"--device-info")try{return auralDeviceCapabilities(argv[2],argv[3],argv[4]);}catch(...){return 69;}
    if(argc==4&&std::wstring(argv[1])==L"--devices")try{return aural_devices::report(argv[2],argv[3]);}catch(...){return 69;}
    if (argc!=5) {std::cerr<<"usage: audio-host.exe <pipe> <session> <nonce> <parent-pid>\n";return 1;}
    aural_devices::ParentWatch parentWatch;if(!parentWatch.init(argv[4]))return 70;
    Channel channel;
    channel.pipe=createPrivatePipe(argv[1]);
    if (channel.pipe==INVALID_HANDLE_VALUE) {std::cerr<<"private pipe creation failed\n";return 2;}
    OVERLAPPED connection{};
    connection.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    if (!connection.hEvent) {CloseHandle(channel.pipe);return 2;}
    const BOOL connected=ConnectNamedPipe(channel.pipe,&connection);
    const DWORD connectError=connected?ERROR_SUCCESS:GetLastError();
    if (connectError==ERROR_IO_PENDING) {
        DWORD ignored=0;
        if (!GetOverlappedResult(channel.pipe,&connection,&ignored,TRUE)) {CloseHandle(connection.hEvent);CloseHandle(channel.pipe);return 2;}
    } else if (!connected && connectError!=ERROR_PIPE_CONNECTED) {CloseHandle(connection.hEvent);CloseHandle(channel.pipe);return 2;}
    CloseHandle(connection.hEvent);
    json hello;
    if (!readFrame(channel.pipe,hello) || stringField(hello,"kind")!="hello" ||
        !protocolOne(hello) || stringField(hello,"sessionId").empty() ||
        stringField(hello,"nonce").empty()) {CloseHandle(channel.pipe);return 3;}
    const std::wstring suppliedSession=utf8ToWide(stringField(hello,"sessionId"));
    const std::wstring suppliedNonce=utf8ToWide(stringField(hello,"nonce"));
    if (suppliedSession!=argv[2] || suppliedNonce!=argv[3] ||
        stringField(hello,"buildId")!=aural_release::main_build_id) {CloseHandle(channel.pipe);return 3;}
    channel.session=stringField(hello,"sessionId");
    channel.send({{"protocol",{{"major",aural_release::protocol_major},{"minor",aural_release::protocol_minor}}},{"kind","hello"},{"buildId",aural_release::host_build_id},
                  {"sessionId",channel.session},{"nonce",stringField(hello,"nonce")},{"maxMessageBytes",MAX_MESSAGE},
                  {"capabilities",json::array({"pcm-f32","wasapi-shared","wasapi-exclusive","cue-frame-bounds","source-sample-span-v1","output-conversion-policy","cue-two-span","buffer-telemetry","analysis-tap-v1","dsd-pcm-policy-v1","wasapi-endpoint-v1","initial-position-v1","presentation-clock-v4","tail-completion-v1","gain-processing-v3","opus-gain-v1","live-volume-v1","pcm-pipeline-plan-v2","pcm-preflight-v1","decoder-source-v1","playback-file-binding-v1","asio-pcm-session-v1","asio-dsd-session-v1"})}});
    json play;
    if (!readFrame(channel.pipe,play) || !protocolOne(play) || stringField(play,"kind")!="command" ||
        stringField(play,"method")!="playback.play" ||
        stringField(play,"sessionId")!=channel.session || unsignedField(play,"expectedGeneration")!=0 ||
        !play.contains("params") || !play["params"].is_object()) {CloseHandle(channel.pipe);return 3;}
    const auto requestId=stringField(play,"requestId");
    const auto commandId=stringField(play,"commandId");
    const auto params=play["params"];
    if(stringField(params,"backend")=="asio"){
        const auto transport=stringField(params,"transport");
        if(transport=="native-dsd"||transport=="dop")return aural_asio_dsd_session::run(channel,hello,play);
        return aural_asio_session::run(channel,hello,play);
    }
    if(params.contains("backend")&&stringField(params,"backend")!="wasapi"){
        channel.receipt(requestId,commandId,false,"unsupported output backend");CloseHandle(channel.pipe);return 3;
    }
    const std::string path=stringField(params,"path");
    const bool endpointValid=!params.contains("deviceId")||params["deviceId"].is_null()||params["deviceId"].is_string();
    const std::string requestedDevice=stringField(params,"deviceId");
    const bool initialPauseValid=!params.contains("initialPaused")||params["initialPaused"].is_boolean();
    const bool initialPaused=initialPauseValid&&params.value("initialPaused",false);
    uint64_t initialUs=0;const bool initialValid=!params.contains("initialPositionUs")||decimalField(params,"initialPositionUs",initialUs);
    const double startSeconds=numberField(params,"startSeconds");
    const double endSeconds=numberField(params,"endSeconds");
    const std::string mode=stringField(params,"mode");
    const bool conversionFieldValid=!params.contains("allowConversion") || params["allowConversion"].is_boolean();
    const bool analysisFieldValid=!params.contains("analysisEnabled") || params["analysisEnabled"].is_boolean();
    const bool allowConversion=mode=="shared" || (conversionFieldValid && params.value("allowConversion",false));
    const std::string dsdPolicy=params.contains("dsdPolicy")?stringField(params,"dsdPolicy"):"stop";
    const bool cueBounded=params.contains("startCueFrame") && !params["startCueFrame"].is_null();
    const bool cueEndBounded=params.contains("endCueFrame") && !params["endCueFrame"].is_null();
    const bool sampleBounded=params.contains("sampleRange");
    aural_sample_span::Range sampleRange{};
    if(sampleBounded){try{
        sampleRange=aural_sample_span::read(params.at("sampleRange"));
        if(cueBounded||cueEndBounded||params.contains("nextCueStartFrame")||params.contains("nextCueEndFrame")||!std::isfinite(startSeconds)||!std::isfinite(endSeconds)||std::abs(startSeconds-double(sampleRange.start)/sampleRange.rate)>1e-9||std::abs(endSeconds-double(sampleRange.next?sampleRange.boundary:sampleRange.end)/sampleRange.rate)>1e-9)throw std::runtime_error("conflicting sample and legacy ranges");
    }catch(const std::exception& e){channel.receipt(requestId,commandId,false,e.what());CloseHandle(channel.pipe);return 3;}}
    const bool nextRequested=sampleBounded?sampleRange.next:params.contains("nextCueStartFrame") || params.contains("nextCueEndFrame");
    const uint64_t startCueFrame=cueBounded?unsignedField(params,"startCueFrame"):0;
    const uint64_t endCueFrame=cueEndBounded?unsignedField(params,"endCueFrame"):UINT64_MAX;
    const uint64_t nextStartCueFrame=nextRequested?unsignedField(params,"nextCueStartFrame"):UINT64_MAX;
    const uint64_t nextEndCueFrame=nextRequested?unsignedField(params,"nextCueEndFrame"):UINT64_MAX;
    const bool validBounds=cueBounded?
        (startCueFrame!=UINT64_MAX && (!cueEndBounded || (endCueFrame!=UINT64_MAX && endCueFrame>startCueFrame))):
        (!cueEndBounded && std::isfinite(startSeconds) && startSeconds>=0 &&
         std::isfinite(endSeconds) && (endSeconds<0 || endSeconds>startSeconds));
    if (requestId.empty() || commandId.empty() || path.empty() || !validBounds || !endpointValid || !initialPauseValid || !initialValid || initialUs>9007199254740991ULL || requestedDevice.size()>255 || params.contains("deviceId")&&params["deviceId"].is_string()&&requestedDevice.empty() ||
        (mode!="shared" && mode!="exclusive") || (dsdPolicy!="stop"&&dsdPolicy!="pcm") || !conversionFieldValid || !analysisFieldValid || utf8ToWide(path).empty() ||
        (nextRequested && !sampleBounded && (!cueBounded || !cueEndBounded || nextStartCueFrame!=endCueFrame ||
            nextEndCueFrame==UINT64_MAX || nextEndCueFrame<=nextStartCueFrame))) {
        channel.receipt(requestId,commandId,false,"invalid play parameters");CloseHandle(channel.pipe);return 3;
    }
    json gainSettings=aural_gain::defaults(),gainTags=nullptr,gainNextTags=nullptr;
    aural_gain::Plan requestedGain;
    try{
        if(params.contains("processing")){
            const auto& gain=params.at("processing");
            if(!gain.is_object()||gain.size()!=3||!gain.contains("settings")||!gain.contains("tags")||!gain.contains("nextTags"))throw std::runtime_error("invalid processing request");
            gainSettings=gain.at("settings");gainTags=gain.at("tags");gainNextTags=gain.at("nextTags");
            if(!nextRequested&&!gainNextTags.is_null())throw std::runtime_error("unexpected next gain tags");
        }
        requestedGain=aural_gain::make(gainSettings,gainTags);
        aural_gain::make(gainSettings,gainNextTags);
        if(requestedGain.enabled&&!allowConversion)throw std::runtime_error("PCM gain requires shared or exclusive conversion mode");
    }catch(const std::exception& e){channel.receipt(requestId,commandId,false,e.what());CloseHandle(channel.pipe);return 3;}
    channel.generation=1;
    channel.receipt(requestId,commandId,true);
    auto ownedPlayer=std::make_unique<Player>();Player& player=*ownedPlayer;
    const std::wstring widePath=utf8ToWide(path);
    const bool preferInteger=mode=="exclusive"&&!requestedGain.enabled;
    ma_result rc=player.decoder.init(widePath,ma_format_f32,preferInteger,&player.stopping,dsdPolicy=="pcm"&&allowConversion);
    const ma_format integerCandidate=preferInteger?player.decoder.nativeIntegerFormat:ma_format_unknown;
    if(rc!=MA_SUCCESS){if(!player.decoder.failureReason.empty()){channel.event("error",{{"message",player.decoder.failureReason}});return 2;}return fail(channel,"decoder",rc);}
    if(player.decoder.dsd.bitRate&&nextRequested){channel.event("error",{{"message","DSD CUE 双轨连续播放尚未接入"}});return 2;}
    const json opusGain=player.decoder.opusGain.describe();
    player.gains[0]=aural_gain::make(gainSettings,gainTags,opusGain);
    player.gains[1]=aural_gain::make(gainSettings,nextRequested?gainNextTags:gainTags,opusGain);
    if(requestedGain.enabled&&player.decoder.outputFormat!=ma_format_f32){player.decoder.uninit();return fail(channel,"gain float source",MA_INVALID_DATA);}
    player.format=player.decoder.outputFormat;
    player.channels=player.decoder.outputChannels;
    player.sampleRate=player.decoder.outputSampleRate;
    if (!player.channels || !player.sampleRate || player.channels>16 || player.sampleRate>1536000) {
        player.decoder.uninit();return fail(channel,"source format",MA_INVALID_DATA);
    }
    uint64_t startFrame=0;
    uint64_t endFrame=UINT64_MAX;
    uint64_t boundaryFrame=UINT64_MAX;
    if(sampleBounded){
        try{sampleRange=aural_sample_span::read(params.at("sampleRange"),player.sampleRate);}
        catch(const std::exception& e){player.decoder.uninit();channel.event("error",{{"message",e.what()}});return 2;}
        startFrame=sampleRange.start;endFrame=sampleRange.end;boundaryFrame=sampleRange.boundary;
        if(sampleRange.next)player.boundaryRelativeFrame=boundaryFrame-startFrame;
    } else if (nextRequested) {
        CueTwoSpanPlan plan{};
        if (!cueTwoSpanPlan(startCueFrame,endCueFrame,nextStartCueFrame,nextEndCueFrame,
                            player.sampleRate,plan)) {
            player.decoder.uninit();return fail(channel,"CUE timeline",MA_INVALID_ARGS);
        }
        startFrame=plan.startPcmFrame;
        boundaryFrame=plan.boundaryPcmFrame;
        endFrame=plan.endPcmFrame;
        player.boundaryRelativeFrame=boundaryFrame-startFrame;
    } else if (cueBounded) {
        if (!cueToPcmFrame(startCueFrame,player.sampleRate,startFrame) ||
            (cueEndBounded && !cueToPcmFrame(endCueFrame,player.sampleRate,endFrame))) {
            player.decoder.uninit();return fail(channel,"CUE frame overflow",MA_INVALID_ARGS);
        }
    } else {
        const double start= startSeconds*player.sampleRate;
        const double end= endSeconds*player.sampleRate;
        if (!std::isfinite(start) || start>=double(UINT64_MAX) ||
            (endSeconds>=0 && (!std::isfinite(end) || end>=double(UINT64_MAX)))) {
            player.decoder.uninit();return fail(channel,"source frame overflow",MA_INVALID_ARGS);
        }
        startFrame=uint64_t(start);
        if (endSeconds>=0) endFrame=uint64_t(end);
    }
    if (endFrame!=UINT64_MAX && endFrame<=startFrame) {
        player.decoder.uninit();return fail(channel,"empty source span",MA_INVALID_ARGS);
    }
    const uint64_t seconds=initialUs/1000000,remainingUs=initialUs%1000000;
    if(seconds>UINT64_MAX/player.sampleRate){player.decoder.uninit();return fail(channel,"initial position overflow",MA_INVALID_ARGS);}
    const uint64_t initialOffset=seconds*player.sampleRate+remainingUs*player.sampleRate/1000000;
    if(initialOffset>UINT64_MAX-startFrame||(endFrame!=UINT64_MAX&&initialOffset>=endFrame-startFrame)||(boundaryFrame!=UINT64_MAX&&initialOffset>=boundaryFrame-startFrame)){player.decoder.uninit();return fail(channel,"initial position outside track",MA_INVALID_ARGS);}
    const uint64_t playFrame=startFrame+initialOffset;player.positionBaseFrames=initialOffset;
    player.liveGain.initialize(player.gains,player.sampleRate,initialOffset,player.boundaryRelativeFrame);
    if (playFrame && (rc=player.decoder.seek(playFrame))!=MA_SUCCESS) {
        player.decoder.uninit();return fail(channel,"seek",rc);
    }
    ma_uint64 sourceLength=0;
    const bool hasSourceLength=player.decoder.length(&sourceLength)==MA_SUCCESS;
    if(hasSourceLength&&playFrame>=sourceLength){player.decoder.uninit();return fail(channel,"initial position outside source",MA_INVALID_ARGS);}
    if (endFrame!=UINT64_MAX) player.maxFrames=endFrame-playFrame;
    const ma_backend backend=ma_backend_wasapi;
    rc=ma_context_init(&backend,1,nullptr,&player.context);
    if (rc!=MA_SUCCESS) {player.decoder.uninit();return fail(channel,"WASAPI context",rc);}
    ma_log_register_callback(ma_context_get_log(&player.context),ma_log_callback_init(wasapiDiagnosticLog,nullptr));
    player.context.callbacks.onDeviceWrite=trackedWrite;
    player.context.callbacks.onDeviceStop=trackedStop;
    player.context.callbacks.onDeviceDataLoop=trackedDataLoop;
    aural_devices::Catalog endpoints;rc=aural_devices::enumerate(player.context,endpoints);
    const aural_devices::Endpoint* selected=nullptr;
    if(rc==MA_SUCCESS)for(const auto& endpoint:endpoints.devices)if(requestedDevice.empty()?endpoint.isDefault:endpoint.id==requestedDevice){if(selected){selected=nullptr;break;}selected=&endpoint;}
    if(!selected){ma_context_uninit(&player.context);player.decoder.uninit();channel.event("error",{{"code","DEVICE_UNAVAILABLE"},{"message","所选 WASAPI 输出设备当前不可用，请选择其他设备或重新连接。"}});return 2;}
    const auto openDevice=[&](ma_format format) {
        auto config=ma_device_config_init(ma_device_type_playback);
        config.playback.pDeviceID=&selected->nativeId;
        config.wasapi.noAutoStreamRouting=MA_TRUE;
        config.notificationCallback=deviceNotification;
        config.playback.format=format;
        config.playback.channels=player.channels;
        config.playback.pChannelMap=player.decoder.channelMap();
        config.playback.shareMode=mode=="exclusive"?ma_share_mode_exclusive:ma_share_mode_shared;
        config.sampleRate=player.sampleRate;
        config.noFixedSizedCallback=MA_TRUE;
        config.resampling.algorithm=ma_resample_algorithm_linear;
        config.dataCallback=callback;
        config.pUserData=&player;
        return ma_device_init(&player.context,&config,&player.device);
    };
    rc=openDevice(player.format);
    bool integerPath=integerCandidate!=ma_format_unknown && rc==MA_SUCCESS &&
        player.format==integerCandidate && player.device.playback.internalFormat==integerCandidate &&
        player.device.playback.internalChannels==player.channels &&
        player.device.playback.internalSampleRate==player.sampleRate&&player.device.playback.converter.isPassthrough;
    std::string integerFallbackReason;
    if(integerCandidate!=ma_format_unknown && !integerPath) {
        if(rc!=MA_SUCCESS)integerFallbackReason="device rejected integer callback";
        else if(player.format!=integerCandidate)integerFallbackReason="decoder output differs";
        else if(player.device.playback.internalFormat!=integerCandidate)integerFallbackReason="device format differs";
        else if(player.device.playback.internalChannels!=player.channels)integerFallbackReason="device channels differ";
        else if(player.device.playback.internalSampleRate!=player.sampleRate)integerFallbackReason="device sample rate differs";
        else integerFallbackReason="device channel layout requires conversion";
        if(!allowConversion)std::cerr<<"[wasapi-raw-rejection] "<<json({
            {"reason",integerFallbackReason},{"result",int(rc)},
            {"sourceFormat",formatName(player.format)},{"sourceChannels",player.channels},{"sourceRate",player.sampleRate},
            {"deviceFormat",rc==MA_SUCCESS?json(formatName(player.device.playback.internalFormat)):json(nullptr)},
            {"deviceChannels",rc==MA_SUCCESS?json(player.device.playback.internalChannels):json(nullptr)},
            {"deviceRate",rc==MA_SUCCESS?json(player.device.playback.internalSampleRate):json(nullptr)},
            {"passthrough",rc==MA_SUCCESS?json(bool(player.device.playback.converter.isPassthrough)):json(nullptr)},
            {"channelConversion",rc==MA_SUCCESS?json(bool(player.device.playback.converter.hasChannelConverter)):json(nullptr)},
            {"resampler",rc==MA_SUCCESS?json(bool(player.device.playback.converter.hasResampler)):json(nullptr)}
        }).dump()<<std::endl;
        if(rc==MA_SUCCESS)ma_device_uninit(&player.device);
        if(!allowConversion){
            ma_context_uninit(&player.context);player.decoder.uninit();
            channel.event("error",{{"message","原始格式输出不可用：设备未接受音源整数格式、声道布局或采样率。请改选允许转换或共享模式。"}});
            return 2;
        }
        const json previousSource=player.decoder.sourceEvidence(),previousBinding=player.decoder.fileBinding();
        const auto previousCodec=player.decoder.codecName,previousBackend=player.decoder.backend;
        rc=player.decoder.reconfigure(ma_format_f32,false);
        if(rc!=MA_SUCCESS){ma_context_uninit(&player.context);return fail(channel,"float decoder fallback",rc);}
        auto expectedSource=previousSource,currentSource=player.decoder.sourceEvidence();expectedSource.erase("decoderConversion");currentSource.erase("decoderConversion");
        if(player.decoder.codecName!=previousCodec||player.decoder.backend!=previousBackend||player.decoder.fileBinding()!=previousBinding||currentSource!=expectedSource){
            player.decoder.uninit();ma_context_uninit(&player.context);return fail(channel,"fallback source identity changed",MA_INVALID_DATA);
        }
        if(player.decoder.outputChannels!=player.channels || player.decoder.outputSampleRate!=player.sampleRate){
            player.decoder.uninit();ma_context_uninit(&player.context);
            return fail(channel,"fallback source changed",MA_INVALID_DATA);
        }
        if(playFrame && (rc=player.decoder.seek(playFrame))!=MA_SUCCESS){
            player.decoder.uninit();ma_context_uninit(&player.context);return fail(channel,"fallback seek",rc);
        }
        player.format=ma_format_f32;
        rc=openDevice(player.format);
    }
    if (rc!=MA_SUCCESS) {ma_context_uninit(&player.context);player.decoder.uninit();return fail(channel,"WASAPI device",rc);}
    if(!ma_device_id_equal(&selected->nativeId,&player.device.playback.id)){ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();return fail(channel,"WASAPI endpoint mismatch",MA_INVALID_DATA);}
    if(!allowConversion && (!player.device.playback.converter.isPassthrough || player.device.playback.internalFormat!=player.format ||
        player.device.playback.internalChannels!=player.channels ||
        player.device.playback.internalSampleRate!=player.sampleRate)){
        ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();
        channel.event("error",{{"message","原始格式输出不可用：设备输出格式、声道布局或采样率与音源不一致。请改选允许转换或共享模式。"}});
        return 2;
    }
    player.bytesPerFrame=ma_get_bytes_per_frame(player.format,player.channels);
    constexpr uint64_t MAX_RING_BYTES=32ull*1024*1024;
    if(!player.bytesPerFrame || MAX_RING_BYTES/player.bytesPerFrame<4096){
        ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();
        return fail(channel,"PCM buffer size",MA_INVALID_DATA);
    }
    player.capacityFrames=std::min<uint64_t>(std::max<uint64_t>(4096,uint64_t(player.sampleRate)*2),
        MAX_RING_BYTES/player.bytesPerFrame);
    player.ring.resize(size_t(player.capacityFrames)*player.bytesPerFrame);
    player.submission.reset();
    player.conversion.configure(player.device.playback.converter);
    player.tail.configure(player.sampleRate,player.device.playback.internalSampleRate,player.conversion.resampled,player.conversion.inputDelay,player.device.wasapi.actualBufferSizeInFramesPlayback);
    player.clock.open(player.device.wasapi.pAudioClientPlayback,player.sampleRate,player.device.playback.internalSampleRate,&player.conversion,&player.submission.padding);
    player.clock.reset(initialOffset);
    if((rc=player.decoder.validateSource())!=MA_SUCCESS){player.clock.close();ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();return fail(channel,"playback source changed before plan",rc);}
    const auto gainDescription=[&]()->json{std::lock_guard<std::recursive_mutex> lock(channel.writes);return player.gains[player.reportedGainSegment.load(std::memory_order_acquire)].description;};
    const json requestedOutput={{"backend","wasapi"},{"mode",mode},{"deviceId",requestedDevice.empty()?json(nullptr):json(requestedDevice)},{"allowConversion",allowConversion},{"dsdPolicy",dsdPolicy}};
    const bool adapterConversion=!player.device.playback.converter.isPassthrough;
    const json actualOutput={{"backend","wasapi"},{"deviceId",selected->id},{"deviceName",selected->name},{"decoder",player.decoder.backend},{"decodedCodec",player.decoder.codecName},{"mode",mode},{"format",formatName(player.format)},
                             {"deviceFormat",formatName(player.device.playback.internalFormat)},
                             {"sampleRate",player.device.sampleRate},{"deviceSampleRate",player.device.playback.internalSampleRate},
                             {"channels",player.device.playback.channels},{"deviceChannels",player.device.playback.internalChannels},
                             {"integerCandidate",integerCandidate==ma_format_unknown?json(nullptr):json(formatName(integerCandidate))},
                             {"integerFallbackReason",integerFallbackReason.empty()?json(nullptr):json(integerFallbackReason)},
                             {"applicationIntegerPath",integerPath},{"adapterConversion",adapterConversion},
                             {"allowConversion",allowConversion},
                             {"dsdConversion",auralDsdDescription(player.decoder.dsd)},{"opusGain",opusGain},
                             {"hardwareVerified",false}};
    const json decodedSource={{"backend",player.decoder.backend},{"codec",player.decoder.codecName},{"container",player.decoder.containerEvidence()},{"format",formatName(player.format)},{"sampleRate",player.sampleRate},{"channels",player.channels},{"certification","pending"},{"media",player.decoder.sourceEvidence()},{"fileBinding",player.decoder.fileBinding()},{"dsdConversion",auralDsdDescription(player.decoder.dsd)},{"opusGain",opusGain}};
    const json conversionPlan=aural_pipeline::report(player.device.playback.converter),pipelineOutput=aural_pipeline::canonicalOutput(actualOutput);
    const json pipelineBuffers={{"preReadFrames",std::to_string(player.capacityFrames)},{"preReadBytes",player.capacityFrames*player.bytesPerFrame},{"deviceFrames",std::to_string(player.device.wasapi.actualBufferSizeInFramesPlayback)}};
    const auto pipelineDescription=[&]()->json{
        std::lock_guard<std::recursive_mutex> lock(channel.writes);
        const json span={{"startFrame",std::to_string(startFrame)},{"endFrame",endFrame==UINT64_MAX?json(nullptr):json(std::to_string(endFrame))},{"boundaryFrame",boundaryFrame==UINT64_MAX?json(nullptr):json(std::to_string(boundaryFrame))},{"segmentIndex",player.reportedGainSegment.load(std::memory_order_acquire)}};
        return aural_pipeline::make(decodedSource,pipelineOutput,conversionPlan,gainDescription(),span,pipelineBuffers);
    };
    // Report and validate the complete current PCM configuration before callback/producer start.
    const std::string planToken=channel.session+"-"+stringField(hello,"nonce")+"-pcm-1";
    try{
        channel.event("prepared",{{"planToken",planToken},{"initialPaused",initialPaused},{"state","preparing"},
            {"position",double(initialOffset)/player.sampleRate},{"clock",player.clock.snapshot()},
            {"requestedOutput",requestedOutput},{"actualOutput",actualOutput},{"decodedSource",decodedSource},
            {"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},
            {"sourceStartPcmFrame",std::to_string(startFrame)},{"sourceEndPcmFrame",endFrame==UINT64_MAX?json(nullptr):json(std::to_string(endFrame))},
            {"cueBoundaryPcmFrame",boundaryFrame==UINT64_MAX?json(nullptr):json(std::to_string(boundaryFrame))}},commandId);
    }catch(...){player.clock.close();ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();return fail(channel,"PCM plan construction",MA_INVALID_DATA);}
    json start;const uint64_t planDeadline=GetTickCount64()+10000;
    const bool received=readFrame(channel.pipe,start,planDeadline);
    const auto startRequest=stringField(start,"requestId"),startCommand=stringField(start,"commandId");
    const bool authenticated=received&&protocolOne(start)&&stringField(start,"kind")=="command"&&stringField(start,"sessionId")==channel.session&&unsignedField(start,"expectedGeneration")==1&&!startRequest.empty()&&!startCommand.empty();
    if(authenticated&&stringField(start,"method")=="playback.stop"){
        channel.receipt(startRequest,startCommand,true);channel.event("stopped",json::object(),startCommand);
        player.clock.close();ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();return 0;
    }
    const bool approved=authenticated&&stringField(start,"method")=="playback.start"&&start.contains("params")&&start["params"].is_object()&&start["params"].size()==1&&stringField(start["params"],"planToken")==planToken;
    if(!approved){
        if(authenticated)channel.receipt(startRequest,startCommand,false,"prepared PCM plan was not accepted");
        player.clock.close();ma_device_uninit(&player.device);ma_context_uninit(&player.context);player.decoder.uninit();return fail(channel,"PCM preflight missing or invalid",MA_INVALID_ARGS);
    }
    channel.receipt(startRequest,startCommand,true);
    player.analysis.start(player.channels,player.sampleRate,player.format==ma_format_s16?aural_analysis::Format::s16:
        player.format==ma_format_s32?aural_analysis::Format::s32:aural_analysis::Format::f32,player.boundaryRelativeFrame);
    player.analysis.configure(params.value("analysisEnabled",false));
    player.producer=std::thread(decodeLoop,&player);
    for (int i=0;i<100 && !player.eof.load() && player.writeFrames.load()<2048;++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    rc=initialPaused?MA_SUCCESS:startDevice(player);
    if (rc!=MA_SUCCESS) {
        player.stopping=true;player.producer.join();player.clock.close();ma_device_uninit(&player.device);
        ma_context_uninit(&player.context);player.decoder.uninit();
        return fail(channel,"WASAPI start",rc);
    }
    const std::string outputLabel=std::string(player.decoder.dsd.bitRate?"DSD → PCM · ":"")+"WASAPI "+(mode=="exclusive"?"exclusive":"shared")+
        " · "+formatName(player.format)+
        (adapterConversion?" → "+std::string(formatName(player.device.playback.internalFormat))+" "+
            std::to_string(player.sampleRate)+"→"+std::to_string(player.device.playback.internalSampleRate)+" Hz (converted)":
            integerPath?" integer path (unverified)":" prototype")+(requestedGain.enabled?" · PCM gain processing":"");
    channel.event(initialPaused?"paused":"playing",{{"position",double(initialOffset)/player.sampleRate},{"clock",player.clock.snapshot()},{"output",outputLabel},{"requestedOutput",requestedOutput},
                             {"decodedSource",decodedSource},
                             {"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},{"actualOutput",actualOutput},{"sourceStartPcmFrame",std::to_string(startFrame)},
                             {"sourceEndPcmFrame",endFrame==UINT64_MAX?json(nullptr):json(std::to_string(endFrame))},
                             {"cueBoundaryPcmFrame",boundaryFrame==UINT64_MAX?json(nullptr):json(std::to_string(boundaryFrame))}},commandId);
    struct QueuedCommand {int kind;std::string cause;uint64_t targetFrame;};
    std::deque<QueuedCommand> commands; // 1 pause, 2 resume, 3 stop, 4 seek
    std::mutex commandMutex;
    std::atomic<bool> pausedState{initialPaused};
    std::atomic<bool> seekPending{false};
    std::atomic<bool> rebuilding{false};
    std::thread input([&]() {
        json message;
        struct ReceiptRecord {bool accepted;std::string error;uint64_t generation;};
        std::unordered_map<std::string,ReceiptRecord> receipts{{commandId,{true,"",1}}};
        const auto respond=[&](const std::string& request,const std::string& id,bool accepted,const std::string& error="") {
            const ReceiptRecord result{accepted,error,channel.generation.load()};
            receipts.emplace(id,result);
            channel.receipt(request,id,result.accepted,result.error,result.generation);
        };
        while (readFrame(channel.pipe,message)) {
            if (!protocolOne(message) || stringField(message,"kind")!="command" ||
                stringField(message,"sessionId")!=channel.session) break;
            const auto id=stringField(message,"commandId");
            const auto request=stringField(message,"requestId");
            const auto name=stringField(message,"method");
            // Generation checks and transition publication share the same control lock.
            std::lock_guard<std::recursive_mutex> commandLock(channel.writes);
            if (id.empty() || request.empty()) break;
            const auto previous=receipts.find(id);
            if (previous!=receipts.end()) {
                channel.receipt(request,id,previous->second.accepted,previous->second.error,previous->second.generation);
                continue;
            }
            if (receipts.size()>=1024) {channel.receipt(request,id,false,"command limit reached");continue;}
            if (unsignedField(message,"expectedGeneration")!=channel.generation.load()) {
                respond(request,id,false,"stale generation");continue;
            }
            if(name=="analysis.configure"){
                const auto setting=message.find("params");
                if(setting==message.end()||!setting->is_object()||!setting->contains("enabled")||!(*setting)["enabled"].is_boolean()){
                    respond(request,id,false,"invalid analysis setting");continue;
                }
                player.analysis.configure((*setting)["enabled"].get<bool>());respond(request,id,true);continue;
            }
            if(name=="volume.configure"){
                std::lock_guard<std::recursive_mutex> volumeLock(channel.writes);
                const auto settings=message.find("params");uint64_t base=0;
                if(settings==message.end()||!settings->is_object()||settings->size()!=3||!decimalField(*settings,"baseRevision",base)||!settings->contains("volumeDb")||!aural_gain::finite(settings->at("volumeDb"),-60,0)||!settings->contains("muted")||!settings->at("muted").is_boolean()) {respond(request,id,false,"invalid live volume");continue;}
                if(!allowConversion||player.format!=ma_format_f32||integerPath||seekPending.load()||rebuilding.load()||player.tail.status()!=0){respond(request,id,false,"live PCM volume unavailable");continue;}
                if(base!=player.volumeRevision||base>=9007199254740991ULL){respond(request,id,false,"stale volume revision");continue;}
                json updated=gainSettings;updated["volumeDb"]=settings->at("volumeDb");updated["muted"]=settings->at("muted");
                auto first=aural_gain::make(updated,gainTags,opusGain),second=aural_gain::make(updated,nextRequested?gainNextTags:gainTags,opusGain);
                gainSettings=std::move(updated);player.gains[0]=std::move(first);player.gains[1]=std::move(second);++player.volumeRevision;
                player.liveGain.requested.store(aural_gain::volumeWord(gainSettings.at("volumeDb").get<double>(),gainSettings.at("muted").get<bool>()),std::memory_order_release);
                respond(request,id,true);
                channel.event("volumeChanged",{{"revision",std::to_string(player.volumeRevision)},{"volumeDb",gainSettings.at("volumeDb")},{"muted",gainSettings.at("muted")},{"application","callback-target"},{"rampMs",20},{"hardwareVerified",false},{"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()}},id);
                continue;
            }
            if (name=="playback.snapshot") {
                std::lock_guard<std::recursive_mutex> snapshotLock(channel.writes);
                if(unsignedField(message,"expectedGeneration")!=channel.generation.load()){respond(request,id,false,"stale generation");continue;}
                if(seekPending.load()||rebuilding.load()) {respond(request,id,false,"seek in progress");continue;}
                const auto clock=player.clock.snapshot();
                const auto tail=player.tail.snapshot();const auto snapshotPaused=pausedState.load();
                if(seekPending.load()||rebuilding.load()) {respond(request,id,false,"seek in progress");continue;}
                respond(request,id,true);
                channel.event("snapshot",{{"state",snapshotPaused?"paused":"playing"},
                    {"position",double(std::stoull(clock.at("sourceFrame").get<std::string>()))/player.sampleRate},{"clock",clock},{"tail",tail},
                    {"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},{"requestedOutput",requestedOutput},{"actualOutput",actualOutput}},id);
                continue;
            }
            if(name=="playback.cancelNext"){
                if(!nextRequested){respond(request,id,false,"no next CUE span");continue;}
                if(seekPending.load()||rebuilding.load()){respond(request,id,false,"seek in progress");continue;}
                int expected=0;
                if(player.boundaryState.compare_exchange_strong(expected,2,std::memory_order_acq_rel))
                    respond(request,id,true);
                else respond(request,id,false,expected==1?"boundary already crossed":"next CUE span already cancelled");
                continue;
            }
            uint64_t seekFrame=0;
            if(name=="playback.seek") {
                if(nextRequested && player.boundaryState.load()==2){respond(request,id,false,"next CUE span cancelled");continue;}
                uint64_t positionUs=0;
                const auto seekParams=message.find("params");
                const bool valid=seekParams!=message.end() && seekParams->is_object() &&
                    decimalField(*seekParams,"positionUs",positionUs);
                const uint64_t whole=positionUs/1000000;
                const uint64_t fraction=positionUs%1000000;
                if(!valid || whole>(UINT64_MAX-startFrame)/player.sampleRate) {
                    respond(request,id,false,"invalid seek position");continue;
                }
                const uint64_t fractionalFrames=(fraction*player.sampleRate)/1000000;
                if(fractionalFrames>UINT64_MAX-startFrame ||
                   whole>(UINT64_MAX-startFrame-fractionalFrames)/player.sampleRate) {
                    respond(request,id,false,"seek overflow");continue;
                }
                const uint64_t offset=whole*player.sampleRate+fractionalFrames;
                seekFrame=startFrame+offset;
                if((endFrame!=UINT64_MAX&&seekFrame>=endFrame)||(hasSourceLength&&seekFrame>=sourceLength)) {
                    respond(request,id,false,"seek outside source span");continue;
                }
                if(rebuilding.load()||seekPending.exchange(true)) {respond(request,id,false,"seek in progress");continue;}
            }
            const int next=name=="playback.pause"?1:name=="playback.resume"?2:name=="playback.stop"?3:
                name=="playback.seek"?4:0;
            if (!next) {respond(request,id,false,"unknown command");continue;}
            respond(request,id,true);
            {
                std::lock_guard<std::mutex> lock(commandMutex);
                if(next==3){commands.clear();commands.push_back({next,id,0});}
                else commands.push_back({next,id,seekFrame});
            }
            if (next==3) return;
        }
        std::lock_guard<std::mutex> lock(commandMutex);
        commands.clear();commands.push_back({3,"",0});
    });
    bool paused=initialPaused;
    bool boundarySignaled=false;
    std::string tailStatus;
    uint64_t analysisSerial=0;
    auto lastPosition=std::chrono::steady_clock::now()-std::chrono::milliseconds(250);
    while (!player.stopping.load()) {
        if(player.tail.status()==5){channel.event("error",{{"code","TAIL_OUTPUT_FAILED"},{"message","歌曲尾部输出或设备停止未能确认，播放已停止。"}});break;}
        if(player.deviceLost.load()){channel.event("error",{{"code","DEVICE_LOST"},{"message","输出设备停止、断开或改变路由，播放已停止。请重新选择设备。"}});break;}
        if(!player.submission.valid.load()){channel.event("error",{{"code","OUTPUT_SUBMISSION_FAILED"},{"message","设备音频提交失败，播放已停止。"}});break;}
        if(player.tail.status()!=3)player.clock.sample(player.positionBaseFrames.load()+player.readFrames.load(),paused,player.submission.committed.load(std::memory_order_acquire),player.submission.valid.load());
        const auto tail=player.tail.observe();
        if(!tail.is_null()&&tail.at("status").get<std::string>()!=tailStatus){tailStatus=tail.at("status").get<std::string>();channel.event("tail",{{"tail",tail}});}
        if(!boundarySignaled&&player.boundaryReached.load(std::memory_order_acquire)&&player.clock.sourceFrame()>=player.boundaryRelativeFrame){
            std::lock_guard<std::recursive_mutex> gainLock(channel.writes);player.reportedGainSegment=1;boundarySignaled=true;channel.event("cueBoundary",{{"sourcePcmFrame",std::to_string(boundaryFrame)},{"relativePcmFrame",std::to_string(player.boundaryRelativeFrame)},{"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},{"position",double(player.clock.sourceFrame())/player.sampleRate},{"clock",player.clock.snapshot()}});
        }
        QueuedCommand next{0,"",0};
        {
            std::lock_guard<std::mutex> lock(commandMutex);
            if(!commands.empty()){next=commands.front();commands.pop_front();}
        }
        if (next.kind==3) {if(stopDevice(player,true)!=MA_SUCCESS){channel.event("error",{{"message","stop failed"}},next.cause);break;}++channel.generation;channel.event("stopped",json::object(),next.cause);break;}
        const bool pausing=next.kind==1&&!paused;
        const char* pauseBasis="recent-position";
        if(pausing){
            rebuilding=true;
            if(stopDevice(player,true)!=MA_SUCCESS){channel.event("error",{{"message","pause stop failed"}},next.cause);break;}
            if(player.submission.frozenReady.load(std::memory_order_acquire)&&player.clock.sampleReading(player.submission.frozen,player.positionBaseFrames.load()+player.readFrames.load(),player.submission.frozenCommitted,player.submission.valid.load(),true))pauseBasis=player.clock.snapshot().at("authority")=="converter-estimate"?"converted-frozen":"device-frozen";
            if(!boundarySignaled&&player.boundaryReached.load(std::memory_order_acquire)&&player.clock.sourceFrame()>=player.boundaryRelativeFrame){
                std::lock_guard<std::recursive_mutex> gainLock(channel.writes);player.reportedGainSegment=1;boundarySignaled=true;channel.event("cueBoundary",{{"sourcePcmFrame",std::to_string(boundaryFrame)},{"relativePcmFrame",std::to_string(player.boundaryRelativeFrame)},{"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},{"position",double(player.clock.sourceFrame())/player.sampleRate},{"clock",player.clock.snapshot()}});
            }
            uint64_t target=startFrame+player.clock.sourceFrame();const uint64_t limit=std::min<uint64_t>(endFrame,hasSourceLength?sourceLength:UINT64_MAX);
            if(limit>startFrame&&target>=limit)target=limit-1;
            paused=true;pausedState=true;next.kind=4;next.targetFrame=target;
        }
        if (next.kind==2 && paused) {
            if (startDevice(player)==MA_SUCCESS) {std::lock_guard<std::recursive_mutex> resumeLock(channel.writes);paused=false;pausedState=false;channel.event("resumed",{{"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},{"position",double(player.clock.sourceFrame())/player.sampleRate},{"clock",player.clock.snapshot()}},next.cause);}
            else {channel.event("error",{{"message","resume failed"}});break;}
        }
        if(next.kind==4) {
            rebuilding=true;
            if(!paused&&stopDevice(player,true)!=MA_SUCCESS){channel.event("error",{{"message","seek stop failed"}},next.cause);break;}
            player.analysis.reset();
            player.stopping=true;
            if(player.producer.joinable())player.producer.join();
            player.stopping=false;player.decodeFailed=false;
            if(player.decoder.seek(next.targetFrame)!=MA_SUCCESS) {
                channel.event("error",{{"message","seek failed"}},next.cause);break;
            }
            player.readFrames=0;player.writeFrames=0;
            player.positionBaseFrames=next.targetFrame-startFrame;
                player.liveGain.reset(next.targetFrame-startFrame,player.boundaryRelativeFrame);
            player.tail.reset();tailStatus.clear();
            if(player.conversion.reset(player.device.playback.converter)!=MA_SUCCESS){channel.event("error",{{"message","output converter reset failed"}},next.cause);break;}
            player.submission.reset();
            player.clock.reset(next.targetFrame-startFrame,pausing?pauseBasis:"requested-position");
            player.maxFrames=endFrame==UINT64_MAX?UINT64_MAX:endFrame-next.targetFrame;
            if(nextRequested){
                const bool afterBoundary=next.targetFrame>=boundaryFrame;
                player.boundaryState=afterBoundary?1:0;
                player.boundaryReached=afterBoundary;
                boundarySignaled=afterBoundary;
            }
            player.eof=false;player.finished=false;player.stopping=false;
            player.producer=std::thread(decodeLoop,&player);
            for(int i=0;i<100&&!player.eof.load()&&player.writeFrames.load()<2048;++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            if(!paused&&startDevice(player)!=MA_SUCCESS) {
                channel.event("error",{{"message","seek resume failed"}},next.cause);break;
            }
            {
                std::lock_guard<std::recursive_mutex> lock(channel.writes);
                player.reportedGainSegment=nextRequested&&next.targetFrame>=boundaryFrame?1:0;
                if(!pausing)seekPending=false;
                rebuilding=false;
                ++channel.generation;
                channel.event(pausing?"paused":"seekCompleted",{{"processingPlan",gainDescription()},{"pipelinePlan",pipelineDescription()},{"position",double(next.targetFrame-startFrame)/player.sampleRate},{"clock",player.clock.snapshot()},
                    {"state",paused?"paused":"playing"},{"sourcePcmFrame",std::to_string(next.targetFrame)},
                    {"cueSegmentIndex",nextRequested?json(next.targetFrame>=boundaryFrame?1:0):json(nullptr)}},next.cause);
            }
        }
        if(player.decodeFailed.load()){channel.event("error",{{"message","媒体解码失败或格式在播放中变化"}});break;}
        if(!paused&&player.tail.status()==3){channel.event("ended",{{"tail",player.tail.observe()}});break;}
        const auto now=std::chrono::steady_clock::now();
        if(now-lastPosition>=std::chrono::milliseconds(250)){
        channel.event("position",{{"position",double(player.clock.sourceFrame())/player.sampleRate},{"clock",player.clock.snapshot()},
            {"callbackCount",std::to_string(player.callbackCount.load(std::memory_order_relaxed))},
            {"bufferUnderrunCallbacks",std::to_string(player.bufferUnderrunCallbacks.load(std::memory_order_relaxed))},
            {"bufferUnderrunFrames",std::to_string(player.bufferUnderrunFrames.load(std::memory_order_relaxed))},{"processingCounts",{{"clippedSamples",std::to_string(player.gainClipped.load())},{"invalidSamples",std::to_string(player.gainInvalid.load())}}}});
        lastPosition=now;
        }
        aural_analysis::Snapshot analysis;
        if(!paused&&player.analysis.snapshot(analysis,analysisSerial)){
            analysisSerial=analysis.serial;
            json peaks=json::array(),rms=json::array();
            for(uint32_t ch=0;ch<player.channels;++ch){peaks.push_back(analysis.peakDb[ch]);rms.push_back(analysis.rmsDb[ch]);}
            channel.event("analysis",{{"version",1},{"sampleRate",player.sampleRate},{"channels",player.channels},
                {"position",double(analysis.endFrame)/player.sampleRate},{"cueSegmentIndex",analysis.segmentIndex},
                {"tap","callback-pcm-before-device"},{"windowFrames",aural_analysis::windowFrames},
                {"peakDb",peaks},{"rmsDb",rms},{"spectrumDb",analysis.spectrumDb},{"waveform",analysis.waveform},
                {"droppedFrames",std::to_string(analysis.droppedFrames)},{"invalidSamples",std::to_string(analysis.invalidSamples)}});
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(40));
    }
    player.stopping=true;
    if (player.producer.joinable()) player.producer.join();
    stopDevice(player);
    player.analysis.stop();
    player.clock.close();
    ma_device_uninit(&player.device);
    ma_context_uninit(&player.context);
    player.decoder.uninit();
    CancelIoEx(channel.pipe,nullptr);
    if (input.joinable()) input.join();
    DisconnectNamedPipe(channel.pipe);
    CloseHandle(channel.pipe);
    return 0;
}
