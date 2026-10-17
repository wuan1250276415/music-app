#pragma once
#include "source-sample-span.hpp"
// Included after the private-pipe/decoder/Player definitions in main.cpp.
#include "asio-timeline.hpp"
#include <array>

namespace aural_asio_session {
static constexpr uint64_t safeInteger=9007199254740991ULL;
inline void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
inline void decoderResult(ma_result result,const char* message){require(result==MA_SUCCESS,message);}
inline uint64_t usToFrames(uint64_t value,uint32_t rate){
    require(value<=safeInteger&&value/1000000<=UINT64_MAX/rate,"ASIO position overflows its source timebase");
    const auto whole=value/1000000*rate,fraction=(value%1000000)*rate/1000000;
    require(fraction<=UINT64_MAX-whole,"ASIO position overflow");return whole+fraction;
}
inline uint64_t framesToUs(uint64_t value,uint32_t rate){
    require(value/rate<=safeInteger/1000000,"ASIO bookmark exceeds IPC timebase");
    const auto result=value/rate*1000000+(value%rate)*1000000/rate;require(result<=safeInteger,"ASIO bookmark exceeds IPC timebase");return result;
}
class Session {
    Channel& channel;
    std::unique_ptr<Player> player=std::make_unique<Player>();
    aural_asio::Engine engine;
    Timeline timeline;
    aural_asio::PreparedInfo prepared;
    Timeline::Reading reading;
    uint64_t sourceStart=0,sourceEnd=UINT64_MAX,sourceLength=UINT64_MAX,boundary=UINT64_MAX,initial=0;
    uint64_t renderSource=0,configurationRevision=0,analysisSerial=0;
    bool nextRequested=false,paused=false,started=false,boundarySignaled=false,disposed=false;
    bool allowConversion=false;
    json requestedOutput,actualOutput,decodedSource,gainSettings,gainTags,nextTags,opusGain;
    std::string outputLabel,planToken;
    std::atomic<bool> inputClosed{false},closing{false},queueOverflow{false};
    std::thread input;
    std::mutex commandsMutex;
    std::deque<json> commands;
    struct Receipt {std::string identity,error;bool accepted=false;uint64_t generation=0;};
    std::unordered_map<std::string,Receipt> receipts;
    bool draining=false;uint64_t tailSource=0,tailTarget=0;
    std::chrono::steady_clock::time_point drainAt,callbackAt,lastReport;
    uint64_t lastCallback=0;

    static uint32_t read(void* context,void* bytes,uint32_t frames) noexcept {
        auto& s=*static_cast<Session*>(context);auto& p=*s.player;
        const auto before=p.readFrames.load(std::memory_order_relaxed);
        s.renderSource=p.positionBaseFrames.load(std::memory_order_relaxed)+before;
        consumePcmFrames(p,bytes,frames);
        const auto count=p.readFrames.load(std::memory_order_relaxed)-before;
        if(p.format==ma_format_f32&&s.allowConversion)p.liveGain.render(static_cast<uint8_t*>(bytes),count,p.channels,s.renderSource,p.boundaryRelativeFrame,p.gainClipped,p.gainInvalid);
        p.analysis.capture(bytes,uint32_t(count),s.renderSource);return uint32_t(count);
    }
    static void published(void* context,const aural_asio::RenderObservation& value) noexcept {
        auto& s=*static_cast<Session*>(context);s.timeline.publish(value,s.renderSource);
    }
    json gain()const{return player->gains[player->reportedGainSegment.load(std::memory_order_acquire)].description;}
    json plan()const {
        const auto media=decodedSource.at("media");
        const auto encoding=media.at("encoding").get<std::string>();
        return {{"version",1},{"backend","asio"},{"transport","pcm"},{"configurationRevision",configurationRevision},
            {"source",decodedSource},{"output",actualOutput},{"processing",gain()},
            {"span",{{"startFrame",std::to_string(sourceStart)},{"endFrame",sourceEnd==UINT64_MAX?json(nullptr):json(std::to_string(sourceEnd))},
                {"boundaryFrame",boundary==UINT64_MAX?json(nullptr):json(std::to_string(boundary))},{"segmentIndex",player->reportedGainSegment.load()}}},
            {"buffers",{{"preReadFrames",std::to_string(player->capacityFrames)},{"preReadBytes",player->capacityFrames*player->bytesPerFrame},{"deviceFrames",prepared.bufferFrames},{"scratchBytes",prepared.callbackScratchBytes}}},
            {"stages",json::array({"bound-file-decoder","bounded-pcm-ring",player->format==ma_format_f32?"float-envelope":"integer-unity","asio-pcm-pack","asio-double-buffer"})},
            {"encodedQuality",encoding=="lossy"?"lossy":encoding=="dsd"?"dsd-converted":encoding=="unknown"?"unknown":"lossless"},
            {"clockPolicy","asio-callback-position-plus-output-latency"},{"tailPolicy","driver-clock-or-reported-latency-estimate"},
            {"hardwareVerified",false},{"bitPerfectVerified",false}};
    }
    json clock()const {
        const auto consumed=player->positionBaseFrames.load()+player->readFrames.load();
        return {{"version",1},{"backend","asio"},{"authority",paused||!started?"paused-bookmark":reading.mapped?"driver-reported":"callback-estimate"},
            {"sourceFrame",std::to_string(paused||!started?initial:reading.source)},{"callbackFrame",std::to_string(consumed)},
            {"sourceSampleRate",player->sampleRate},{"devicePosition",reading.mapped?json(std::to_string(reading.device)):json(nullptr)},
            {"systemTimeNs",reading.mapped?json(std::to_string(reading.time)):json(nullptr)},{"outputLatencyFrames",prepared.outputLatency},
            {"publishedMusicFrames",std::to_string(reading.publishedMusic)},{"hardwareVerified",false}};
    }
    json statePayload()const {
        const auto position=paused||!started?initial:reading.source;
        return {{"position",double(position)/player->sampleRate},{"clock",clock()},{"output",outputLabel},
            {"requestedOutput",requestedOutput},{"actualOutput",actualOutput},{"decodedSource",decodedSource},
            {"processingPlan",gain()},{"asioPlan",plan()},{"sourceStartPcmFrame",std::to_string(sourceStart)},
            {"sourceEndPcmFrame",sourceEnd==UINT64_MAX?json(nullptr):json(std::to_string(sourceEnd))},
            {"cueBoundaryPcmFrame",boundary==UINT64_MAX?json(nullptr):json(std::to_string(boundary))}};
    }
    json tail(const char* status,const char* evidence,uint64_t elapsed,bool clockProof)const {
        return {{"version",1},{"backend","asio"},{"status",status},{"evidence",evidence},
            {"sourceFrame",std::to_string(tailSource)},{"sourceSampleRate",player->sampleRate},{"targetDeviceFrame",tailTarget?json(std::to_string(tailTarget)):json(nullptr)},
            {"outputLatencyFrames",prepared.outputLatency},{"bufferFrames",prepared.bufferFrames},
            {"elapsedMs",elapsed},{"driverPosition",clockProof?json(std::to_string(reading.device)):json(nullptr)},
            {"driverStopped",std::string(status)=="completed"},{"hardwareVerified",false}};
    }
    bool closeDriver() {
        if(disposed)return true;
        player->stopping.store(true,std::memory_order_release);
        if(!engine.close())return false; // Preserve callback targets until process retirement.
        if(player->producer.joinable())player->producer.join();
        player->analysis.configure(false);player->decoder.uninit();disposed=true;return true;
    }
    void beginInput() {
        input=std::thread([&](){
            try{
                json command;
                while(!closing.load()&&readFrame(channel.pipe,command)){
                    if(closing.load())break;
                    std::lock_guard<std::mutex> lock(commandsMutex);
                    if(commands.size()>=16){queueOverflow=true;break;}
                    commands.push_back(std::move(command));
                }
            }catch(...){queueOverflow=true;}
            inputClosed=true;CancelIoEx(channel.pipe,nullptr);
        });
    }
    static bool uuid(const std::string& value) {
        if(value.size()!=36)return false;
        for(size_t i=0;i<36;++i){if(i==8||i==13||i==18||i==23){if(value[i]!='-')return false;}
            else if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')||(value[i]>='A'&&value[i]<='F')))return false;}
        return true;
    }
    bool processCommand(json& command) {
        require(protocolOne(command)&&stringField(command,"kind")=="command"&&stringField(command,"sessionId")==channel.session,"ASIO command session identity is invalid");
        const auto id=stringField(command,"commandId"),request=stringField(command,"requestId"),method=stringField(command,"method");
        require(uuid(id)&&uuid(request)&&command.contains("params")&&command["params"].is_object(),"ASIO command identity or parameters are invalid");
        const auto& params=command["params"];
        const auto identity=json{{"method",method},{"params",params},{"generation",command.value("expectedGeneration",json(nullptr))}}.dump();
        const auto old=receipts.find(id);
        if(old!=receipts.end()){
            if(old->second.identity!=identity)channel.receipt(request,id,false,"ASIO command ID was reused for different content");
            else channel.receipt(request,id,old->second.accepted,old->second.error,old->second.generation);return true;
        }
        if(receipts.size()>=1024){channel.receipt(request,id,false,"ASIO session command budget reached");return true;}
        const auto reply=[&](bool accepted,const std::string& error=""){
            receipts.emplace(id,Receipt{identity,error,accepted,channel.generation.load()});channel.receipt(request,id,accepted,error);
        };
        if(unsignedField(command,"expectedGeneration")!=channel.generation.load()){reply(false,"ASIO command generation is stale");return true;}
        if(method=="playback.stop"){
            if(!params.empty()){reply(false,"ASIO stop parameters must be empty");return true;}
            reply(true);require(closeDriver(),"ASIO driver teardown was not confirmed");++channel.generation;channel.event("stopped",json::object(),id);return false;
        }
        if(method=="analysis.configure"){
            if(params.size()!=1||!params.contains("enabled")||!params["enabled"].is_boolean()){reply(false,"ASIO analysis setting is invalid");return true;}
            player->analysis.configure(params["enabled"].get<bool>());reply(true);return true;
        }
        if(method=="playback.snapshot"){
            if(!params.empty()){reply(false,"ASIO snapshot parameters must be empty");return true;}
            reply(true);auto value=statePayload();value["state"]=paused?"paused":"playing";value["tail"]=draining?tail("draining","pending",0,false):json(nullptr);channel.event("snapshot",value,id);return true;
        }
        if(method=="volume.configure"){
            uint64_t base=0;
            if(params.size()!=3||!decimalField(params,"baseRevision",base)||!params.contains("volumeDb")||!aural_gain::finite(params["volumeDb"],-60,0)||!params.contains("muted")||!params["muted"].is_boolean()||!allowConversion||player->format!=ma_format_f32||draining){reply(false,"ASIO live volume requires an authorized float source and active span");return true;}
            if(base!=player->volumeRevision||base>=safeInteger){reply(false,"ASIO volume revision is stale");return true;}
            auto updated=gainSettings;updated["volumeDb"]=params["volumeDb"];updated["muted"]=params["muted"];
            auto first=aural_gain::make(updated,gainTags,opusGain),second=aural_gain::make(updated,nextRequested?nextTags:gainTags,opusGain);
            gainSettings=std::move(updated);player->gains[0]=std::move(first);player->gains[1]=std::move(second);++player->volumeRevision;
            player->liveGain.requested.store(aural_gain::volumeWord(gainSettings["volumeDb"].get<double>(),gainSettings["muted"].get<bool>()),std::memory_order_release);
            reply(true);channel.event("volumeChanged",{{"revision",std::to_string(player->volumeRevision)},{"volumeDb",gainSettings["volumeDb"]},{"muted",gainSettings["muted"]},
                {"application","callback-target"},{"rampMs",20},{"hardwareVerified",false},{"processingPlan",gain()},{"asioPlan",plan()}},id);return true;
        }
        if(method=="playback.cancelNext"){
            if(!params.empty()||!nextRequested){reply(false,"ASIO session has no cancellable next CUE span");return true;}
            int expected=0;const bool accepted=player->boundaryState.compare_exchange_strong(expected,2,std::memory_order_acq_rel);
            reply(accepted,accepted?"":expected==1?"ASIO CUE boundary already crossed":"ASIO next CUE span already cancelled");return true;
        }
        if(method=="playback.resume"&&paused&&!started){
            if(!params.empty()){reply(false,"ASIO resume parameters must be empty");return true;}
            reply(true);decoderResult(player->decoder.validateSource(),"ASIO bound source changed before resume");engine.start();started=true;paused=false;
            callbackAt=std::chrono::steady_clock::now();channel.event("resumed",statePayload(),id);return true;
        }
        if(method=="playback.pause"||method=="playback.seek"){
            uint64_t target=paused?initial:reading.source;
            auto limit=std::min(sourceEnd,sourceLength);if(player->boundaryState.load()==2)limit=std::min(limit,boundary);
            if(draining&&tailSource<=UINT64_MAX-sourceStart)limit=std::min(limit,sourceStart+tailSource);
            if(method=="playback.pause"&&!params.empty()){reply(false,"ASIO pause parameters must be empty");return true;}
            if(method=="playback.seek"){
                uint64_t us=0;if(params.size()!=1||!decimalField(params,"positionUs",us)||us>safeInteger){reply(false,"ASIO seek timebase is invalid");return true;}
                target=usToFrames(us,player->sampleRate);
                if(target>UINT64_MAX-sourceStart||limit!=UINT64_MAX&&target>=limit-sourceStart){reply(false,"ASIO seek is outside the active source span");return true;}
            }
            if(limit!=UINT64_MAX&&target>=limit-sourceStart)target=limit-sourceStart-1;
            reply(true);require(closeDriver(),"ASIO output release was not confirmed before rebuild");++channel.generation;
            channel.event("rebuildRequired",{{"reason",method=="playback.pause"?"pause":"seek"},{"positionFrame",std::to_string(target)},
                {"positionUs",std::to_string(framesToUs(target,player->sampleRate))},{"sourceSampleRate",player->sampleRate},
                {"desiredState",method=="playback.pause"||paused?"paused":"playing"},{"driverReleased",true},{"hardwareVerified",false}},id);return false;
        }
        reply(false,"ASIO command is unavailable in this session state");return true;
    }
    void observe() {
        const auto snapshot=engine.snapshot();
        reading=timeline.observe(snapshot,player->positionBaseFrames.load()+player->readFrames.load(),prepared.outputLatency);
        require(reading.healthy,"ASIO publication timeline overflowed or driver sample position regressed");
        const auto recoverable=aural_asio::resetRequested|aural_asio::resyncRequested|aural_asio::bufferSizeChanged;
        if(snapshot.events&(aural_asio::fatalEvents&~recoverable))throw std::runtime_error("ASIO driver clock, callback, packing or output-ready state became invalid");
        const auto now=std::chrono::steady_clock::now();
        if(snapshot.callbacks!=lastCallback){lastCallback=snapshot.callbacks;callbackAt=now;}
        const uint64_t stallMs=std::max<uint64_t>(3000,(uint64_t(prepared.bufferFrames)*3000+player->sampleRate-1)/player->sampleRate+500);
        require(!started||paused||uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(now-callbackAt).count())<=stallMs,"ASIO driver stopped requesting audio buffers");
        require(!player->decodeFailed.load(),"ASIO media decoding failed or its format changed");
        if(!boundarySignaled&&nextRequested&&player->boundaryState.load()==1&&reading.source>=player->boundaryRelativeFrame){
            player->reportedGainSegment=1;boundarySignaled=true;
            channel.event("cueBoundary",{{"sourcePcmFrame",std::to_string(boundary)},{"relativePcmFrame",std::to_string(player->boundaryRelativeFrame)},
                {"position",double(reading.source)/player->sampleRate},{"clock",clock()},{"processingPlan",gain()},{"asioPlan",plan()}});
        }
        if(snapshot.events&recoverable||snapshot.latencyRevision!=prepared.observedLatencyRevision){
            require(closeDriver(),"ASIO reconfiguration release was not confirmed");++channel.generation;
            channel.event("rebuildRequired",{{"reason","driver-reconfigure"},{"positionFrame",std::to_string(paused?initial:reading.source)},
                {"positionUs",std::to_string(framesToUs(paused?initial:reading.source,player->sampleRate))},{"sourceSampleRate",player->sampleRate},
                {"desiredState",paused?"paused":"playing"},{"driverReleased",true},{"hardwareVerified",false}});return;
        }
        if(started&&!paused&&player->finished.load()&&snapshot.countersValid&&snapshot.musicFrames==player->readFrames.load()&&reading.publishedMusic==snapshot.musicFrames){
            const bool cancelled=player->boundaryState.load()==2;
            require(cancelled||sourceEnd==UINT64_MAX||player->writeFrames.load()==player->maxFrames,"ASIO source ended before its planned finite span");
            if(!draining){
                require(snapshot.musicFrames>0,"ASIO source contains no playable PCM frames");draining=true;drainAt=now;
                tailSource=player->positionBaseFrames.load()+player->readFrames.load();tailTarget=reading.musicTimed?reading.lastMusicEnd:0;
                channel.event("tail",{{"tail",tail("draining","pending",0,false)}});
            }
            const uint64_t elapsed=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(now-drainAt).count());
            const bool proof=tailTarget&&reading.mapped&&reading.device>=tailTarget;
            const uint64_t estimate=(uint64_t(prepared.outputLatency)*1000+uint64_t(prepared.bufferFrames)*3000+player->sampleRate-1)/player->sampleRate+100;
            if(proof||elapsed>=estimate){
                require(closeDriver(),"ASIO tail stop and driver disposal were not confirmed");
                channel.event("ended",{{"tail",tail("completed",proof?"driver-clock":"driver-latency-period-estimate",elapsed,proof)}});return;
            }
            require(elapsed<=30000,"ASIO music tail did not finish within its budget");
        }
        if(now-lastReport>=std::chrono::milliseconds(250)){
            channel.event("position",{{"position",double(paused?initial:reading.source)/player->sampleRate},{"clock",clock()},
                {"callbackCount",std::to_string(snapshot.callbacks)},{"bufferUnderrunCallbacks",std::to_string(player->bufferUnderrunCallbacks.load())},
                {"bufferUnderrunFrames",std::to_string(player->bufferUnderrunFrames.load())},
                {"processingCounts",{{"clippedSamples",std::to_string(player->gainClipped.load())},{"invalidSamples",std::to_string(player->gainInvalid.load())}}},
                {"asioPackingCounts",{{"saturatedSamples",std::to_string(snapshot.saturatedSamples)},{"nonfiniteSamples",std::to_string(snapshot.nonfiniteSamples)}}}});lastReport=now;
        }
        aural_analysis::Snapshot analysis;
        if(started&&!paused&&player->analysis.snapshot(analysis,analysisSerial)){
            analysisSerial=analysis.serial;json peaks=json::array(),rms=json::array();
            for(uint32_t ch=0;ch<player->channels;++ch){peaks.push_back(analysis.peakDb[ch]);rms.push_back(analysis.rmsDb[ch]);}
            channel.event("analysis",{{"version",1},{"sampleRate",player->sampleRate},{"channels",player->channels},{"position",double(analysis.endFrame)/player->sampleRate},
                {"cueSegmentIndex",analysis.segmentIndex},{"tap","callback-pcm-before-device"},{"windowFrames",aural_analysis::windowFrames},
                {"peakDb",peaks},{"rmsDb",rms},{"spectrumDb",analysis.spectrumDb},{"waveform",analysis.waveform},
                {"droppedFrames",std::to_string(analysis.droppedFrames)},{"invalidSamples",std::to_string(analysis.invalidSamples)}});
        }
    }
public:
    explicit Session(Channel& value):channel(value){}
    ~Session() noexcept {
        closing=true;
        try{if(!closeDriver()){TerminateProcess(GetCurrentProcess(),70);std::terminate();}}catch(...){TerminateProcess(GetCurrentProcess(),70);std::terminate();}
        CancelIoEx(channel.pipe,nullptr);if(input.joinable())input.join();
        if(channel.pipe!=INVALID_HANDLE_VALUE){DisconnectNamedPipe(channel.pipe);CloseHandle(channel.pipe);channel.pipe=INVALID_HANDLE_VALUE;}
    }
    int run(const json& hello,const json& play) {
        const auto& params=play.at("params");const auto request=stringField(play,"requestId"),command=stringField(play,"commandId");
        require(uuid(request)&&uuid(command)&&params.contains("asio")&&params["asio"].is_object(),"ASIO play identity/configuration is invalid");
        const auto& asio=params["asio"];
        require(asio.size()==6&&asio.contains("outputChannels")&&asio["outputChannels"].is_array()&&asio["outputChannels"].size()>=1&&asio["outputChannels"].size()<=16&&asio.contains("allowConversion")&&asio["allowConversion"].is_boolean(),"ASIO output mapping/configuration is invalid");
        configurationRevision=unsignedField(asio,"configurationRevision");require(configurationRevision<=safeInteger,"ASIO configuration revision is invalid");
        aural_asio::Configuration configuration;allowConversion=asio["allowConversion"].get<bool>();configuration.allowConversion=allowConversion;
        const auto frames=unsignedField(asio,"bufferFrames");require(frames<=32768,"ASIO buffer exceeds its budget");configuration.bufferFrames=uint32_t(frames);
        for(const auto& channelIndex:asio["outputChannels"]){require(channelIndex.is_number_integer(),"ASIO output channel index is invalid");const auto index=channelIndex.get<int64_t>();require(index>=0&&index<4096&&std::find(configuration.outputChannels.begin(),configuration.outputChannels.end(),int32_t(index))==configuration.outputChannels.end(),"ASIO output channel index exceeds its budget or is repeated");configuration.outputChannels.push_back(int32_t(index));}
        const aural_asio::DriverIdentity driver{stringField(asio,"registryName"),stringField(asio,"clsid"),{}};
        require(!driver.registryName.empty()&&driver.registryName.size()<=2048&&driver.clsid.size()==38&&stringField(params,"mode")=="exclusive"&&params.contains("allowConversion")&&params["allowConversion"].is_boolean()&&params["allowConversion"].get<bool>()==allowConversion&&(!params.contains("deviceId")||params["deviceId"].is_null()),"ASIO driver, output mode or conversion authority is invalid");
        const auto path=stringField(params,"path"),dsdPolicy=stringField(params,"dsdPolicy");
        require(!path.empty()&&path.size()<=131068&&path.find('\0')==std::string::npos&&!utf8ToWide(path).empty()&&(dsdPolicy=="stop"||dsdPolicy=="pcm"),"ASIO source or DSD policy is invalid");
        require(!params.contains("initialPaused")||params["initialPaused"].is_boolean(),"ASIO initial pause state is invalid");paused=params.value("initialPaused",false);
        require(!params.contains("analysisEnabled")||params["analysisEnabled"].is_boolean(),"ASIO analysis policy is invalid");
        uint64_t initialUs=0;require(!params.contains("initialPositionUs")||decimalField(params,"initialPositionUs",initialUs),"ASIO initial position is invalid");
        gainSettings=aural_gain::defaults();gainTags=nextTags=nullptr;
        if(params.contains("processing")){
            const auto& gain=params["processing"];require(gain.is_object()&&gain.size()==3&&gain.contains("settings")&&gain.contains("tags")&&gain.contains("nextTags"),"ASIO gain request is invalid");
            gainSettings=gain["settings"];gainTags=gain["tags"];nextTags=gain["nextTags"];
        }
        const auto requestedGain=aural_gain::make(gainSettings,gainTags);require(!requestedGain.enabled||allowConversion,"ASIO software gain requires explicit conversion authority");
        decoderResult(player->decoder.init(utf8ToWide(path),ma_format_f32,!requestedGain.enabled,&player->stopping,dsdPolicy=="pcm"&&allowConversion),"ASIO decoder initialization failed");
        player->format=player->decoder.outputFormat;player->channels=player->decoder.outputChannels;player->sampleRate=player->decoder.outputSampleRate;
        require(player->sampleRate>=8000&&player->sampleRate<=1536000&&player->channels>=1&&player->channels<=16,"ASIO decoded source format exceeds its budget");
        require(player->channels==configuration.outputChannels.size(),"ASIO explicit output mapping does not match the decoded source channels");
        require(player->format==ma_format_s16||player->format==ma_format_s32||player->format==ma_format_f32,"ASIO session decoder PCM format is unsupported");
        opusGain=player->decoder.opusGain.describe();player->gains[0]=aural_gain::make(gainSettings,gainTags,opusGain);
        const bool cue=params.contains("startCueFrame")&&!params["startCueFrame"].is_null(),endCue=params.contains("endCueFrame")&&!params["endCueFrame"].is_null();
        const bool sampleBounded=params.contains("sampleRange");
        const auto sampleRange=sampleBounded?aural_sample_span::read(params.at("sampleRange"),player->sampleRate):aural_sample_span::Range{};
        nextRequested=sampleBounded?sampleRange.next:params.contains("nextCueStartFrame")||params.contains("nextCueEndFrame");
        require(!nextRequested||(sampleBounded||cue&&endCue)&&!player->decoder.dsd.bitRate,"ASIO next CUE span or DSD-CUE policy is invalid");require(nextRequested||nextTags.is_null(),"ASIO next gain tags require a next CUE span");
        if(sampleBounded){
            require(!cue&&!endCue&&!params.contains("nextCueStartFrame")&&!params.contains("nextCueEndFrame"),"conflicting ASIO sample and CUE ranges");
            const auto start=numberField(params,"startSeconds"),end=numberField(params,"endSeconds");
            require(std::isfinite(start)&&std::isfinite(end)&&std::abs(start-double(sampleRange.start)/sampleRange.rate)<=1e-9&&std::abs(end-double(sampleRange.next?sampleRange.boundary:sampleRange.end)/sampleRange.rate)<=1e-9,"ASIO seconds differ from exact sample span");
            sourceStart=sampleRange.start;sourceEnd=sampleRange.end;boundary=sampleRange.boundary;
        }else if(cue){
            const auto start=unsignedField(params,"startCueFrame"),end=endCue?unsignedField(params,"endCueFrame"):UINT64_MAX;
            require(start!=UINT64_MAX&&(!endCue||end!=UINT64_MAX&&end>start)&&cueToPcmFrame(start,player->sampleRate,sourceStart),"ASIO CUE start range is invalid");
            if(nextRequested){CueTwoSpanPlan span{};require(cueTwoSpanPlan(start,end,unsignedField(params,"nextCueStartFrame"),unsignedField(params,"nextCueEndFrame"),player->sampleRate,span),"ASIO CUE adjacency/range is invalid");sourceStart=span.startPcmFrame;sourceEnd=span.endPcmFrame;boundary=span.boundaryPcmFrame;}
            else if(endCue)require(cueToPcmFrame(end,player->sampleRate,sourceEnd),"ASIO CUE end range overflows");
        }else{
            const auto start=numberField(params,"startSeconds"),end=numberField(params,"endSeconds");
            require(!endCue&&std::isfinite(start)&&start>=0&&std::isfinite(end)&&(end<0||end>start),"ASIO source span is invalid");
            require(start*player->sampleRate<double(UINT64_MAX)&&(end<0||end*player->sampleRate<double(UINT64_MAX)),"ASIO source frame range overflows");sourceStart=uint64_t(start*player->sampleRate);if(end>=0)sourceEnd=uint64_t(end*player->sampleRate);
        }
        require(sourceEnd==UINT64_MAX||sourceEnd>sourceStart,"ASIO source span is empty");
        initial=usToFrames(initialUs,player->sampleRate);
        if(params.contains("initialPositionFrame")){require(initialUs==0&&decimalField(params,"initialPositionFrame",initial),"ASIO exact frame bookmark conflicts with its microsecond position");}
        require(initial<=UINT64_MAX-sourceStart&&(sourceEnd==UINT64_MAX||initial<sourceEnd-sourceStart)&&(boundary==UINT64_MAX||initial<boundary-sourceStart),"ASIO initial position is outside its track");
        ma_uint64 length=0;if(player->decoder.length(&length)==MA_SUCCESS){sourceLength=length;require(sourceStart+initial<length&&(sourceEnd==UINT64_MAX||sourceEnd<=length),"ASIO source range is outside its decoded length");}
        player->positionBaseFrames=initial;player->boundaryRelativeFrame=boundary==UINT64_MAX?UINT64_MAX:boundary-sourceStart;
        if(sourceEnd!=UINT64_MAX)player->maxFrames=sourceEnd-sourceStart-initial;
        player->gains[1]=aural_gain::make(gainSettings,nextRequested?nextTags:gainTags,opusGain);player->liveGain.initialize(player->gains,player->sampleRate,initial,player->boundaryRelativeFrame);
        if(sourceStart+initial)decoderResult(player->decoder.seek(sourceStart+initial),"ASIO initial source seek failed");
        player->bytesPerFrame=ma_get_bytes_per_frame(player->format,player->channels);require(player->bytesPerFrame>0,"ASIO source frame geometry is invalid");
        player->capacityFrames=std::min<uint64_t>(std::max<uint64_t>(4096,uint64_t(player->sampleRate)*2),32ull*1024*1024/player->bytesPerFrame);player->ring.resize(size_t(player->capacityFrames)*player->bytesPerFrame);
        const auto media=player->decoder.sourceEvidence();uint32_t valid=media["validBits"].is_null()?0:media["validBits"].get<uint32_t>();
        configuration.source={player->format==ma_format_s16?aural_asio::PcmFormat::s16:player->format==ma_format_s32?aural_asio::PcmFormat::s32:aural_asio::PcmFormat::f32,
            player->sampleRate,player->channels,player->format==ma_format_f32?32:valid?valid:player->bytesPerFrame/player->channels*8};
        engine.open(driver);prepared=engine.prepare(configuration,{this,read,published});
        require(prepared.latencyKnown&&prepared.outputLatency<=uint64_t(player->sampleRate)*5,"ASIO output latency is unavailable or exceeds the five-second transport budget");
        decoderResult(player->decoder.validateSource(),"ASIO source identity changed before preflight");timeline.reset(initial);
        json layouts=json::array();for(const auto& ch:prepared.channels)layouts.push_back({{"index",ch.index},{"sampleType",ch.sampleType},{"group",ch.group},{"name",ch.name},
            {"containerBytes",ch.containerBytes},{"validBits",ch.validBits},{"floating",ch.floating},{"bigEndian",ch.bigEndian},{"rightAligned",ch.rightAligned}});
        requestedOutput={{"backend","asio"},{"mode","exclusive"},{"driver",{{"registryName",driver.registryName},{"clsid",driver.clsid}}},
            {"configurationRevision",configurationRevision},{"outputChannels",configuration.outputChannels},{"bufferFrames",configuration.bufferFrames},{"allowConversion",allowConversion},{"dsdPolicy",dsdPolicy}};
        actualOutput={{"backend","asio"},{"identity",{{"registryName",prepared.identity.registryName},{"clsid",prepared.identity.clsid},{"description",prepared.identity.description}}},
            {"driverName",prepared.driverName},{"driverVersion",prepared.driverVersion},{"format",formatName(player->format)},{"validBits",configuration.source.validBits},
            {"sampleRate",prepared.sampleRate},{"channels",layouts},{"bufferFrames",prepared.bufferFrames},{"outputLatencyFrames",prepared.outputLatency},
            {"numericConversion",prepared.numericConversion},{"exactPackingCandidate",prepared.exactPackingCandidate},{"allowConversion",allowConversion},{"hardwareVerified",false}};
        decodedSource={{"backend",player->decoder.backend},{"codec",player->decoder.codecName},{"container",player->decoder.containerEvidence()},{"format",formatName(player->format)},{"sampleRate",player->sampleRate},{"channels",player->channels},
            {"certification","pending"},{"media",media},{"fileBinding",player->decoder.fileBinding()},{"dsdConversion",auralDsdDescription(player->decoder.dsd)},{"opusGain",opusGain}};
        outputLabel="ASIO · "+(prepared.driverName.empty()?prepared.identity.registryName:prepared.driverName)+" · "+formatName(player->format)+" · "+std::to_string(player->sampleRate)+" Hz (unverified)";
        planToken=channel.session+"-"+stringField(hello,"nonce")+"-asio-pcm-1";channel.generation=1;channel.receipt(request,command,true);
        auto payload=statePayload();payload["state"]="preparing";payload["initialPaused"]=paused;payload["planToken"]=planToken;channel.event("prepared",payload,command);
        json start;require(readFrame(channel.pipe,start,GetTickCount64()+10000),"ASIO preflight approval was not received within ten seconds");
        require(protocolOne(start)&&stringField(start,"kind")=="command"&&stringField(start,"sessionId")==channel.session&&unsignedField(start,"expectedGeneration")==1&&uuid(stringField(start,"requestId"))&&uuid(stringField(start,"commandId")),"ASIO preflight command identity is invalid");
        if(stringField(start,"method")=="playback.stop"){channel.receipt(stringField(start,"requestId"),stringField(start,"commandId"),true);require(closeDriver(),"ASIO prepared driver disposal was not confirmed");channel.event("stopped",json::object(),stringField(start,"commandId"));return 0;}
        require(stringField(start,"method")=="playback.start"&&start.contains("params")&&start["params"].is_object()&&start["params"].size()==1&&stringField(start["params"],"planToken")==planToken,"ASIO prepared plan token was not accepted");
        require(stringField(start,"commandId")!=command,"ASIO start operation reused the initial play command ID");
        const auto identity=[](const json& message){return json{{"method",stringField(message,"method")},{"params",message.at("params")},{"generation",message.at("expectedGeneration")}}.dump();};
        receipts.emplace(command,Receipt{identity(play),"",true,1});receipts.emplace(stringField(start,"commandId"),Receipt{identity(start),"",true,1});
        channel.receipt(stringField(start,"requestId"),stringField(start,"commandId"),true);decoderResult(player->decoder.validateSource(),"ASIO source identity changed before start");
        player->analysis.start(player->channels,player->sampleRate,player->format==ma_format_s16?aural_analysis::Format::s16:player->format==ma_format_s32?aural_analysis::Format::s32:aural_analysis::Format::f32,player->boundaryRelativeFrame);
        player->analysis.configure(params.value("analysisEnabled",false));player->producer=std::thread(decodeLoop,player.get());
        for(unsigned wait=0;wait<100&&!player->eof.load()&&player->writeFrames.load()<std::min<uint64_t>(prepared.bufferFrames,player->maxFrames);++wait){engine.pumpMessages();Sleep(10);}
        require(!player->decodeFailed.load()&&(!player->eof.load()||player->writeFrames.load()>0),"ASIO decoder produced no valid PCM source");
        require(!player->eof.load()||player->maxFrames==UINT64_MAX||player->writeFrames.load()==player->maxFrames,"ASIO decoder ended before its finite source span");
        if(!paused){engine.start();started=true;}
        callbackAt=lastReport=std::chrono::steady_clock::now();channel.event(paused?"paused":"playing",statePayload(),command);beginInput();
        while(!disposed){
            engine.pumpMessages();if(queueOverflow.load())throw std::runtime_error("ASIO input command queue exceeded its budget or failed");
            if(inputClosed.load()){require(closeDriver(),"ASIO disconnected-driver cleanup was not confirmed");break;}
            observe();if(disposed)break;
            json commandMessage;{std::lock_guard<std::mutex> lock(commandsMutex);if(!commands.empty()){commandMessage=std::move(commands.front());commands.pop_front();}}
            if(!commandMessage.is_null()&&!processCommand(commandMessage))break;
            Sleep(5);
        }
        return 0;
    }
};
inline int run(Channel& channel,const json& hello,const json& play) {
    auto session=std::make_unique<Session>(channel);
    try{return session->run(hello,play);}
    catch(const std::exception& error){channel.event("error",{{"code","ASIO_SESSION_FAILED"},{"message",error.what()}});return 69;}
    catch(...){channel.event("error",{{"code","ASIO_SESSION_FAILED"},{"message","ASIO native session failed"}});return 69;}
}
}
