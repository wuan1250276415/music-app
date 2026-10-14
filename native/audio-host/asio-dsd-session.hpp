#pragma once
// Included after Channel and the PCM session helpers in main.cpp.
#include "asio-dsd-stream.hpp"
#include "asio-dsd.hpp"
#include <map>
#include <deque>

namespace aural_asio_dsd_session {
using aural_asio_session::require;
using aural_asio_session::safeInteger;
using aural_asio_session::Timeline;
inline bool fields(const json& v,std::initializer_list<const char*> names){
    if(!v.is_object()||v.size()!=names.size())return false;
    for(auto name:names)if(!v.contains(name))return false;return true;
}
inline bool protocol(const json& value){return protocolOne(value)&&unsignedField(value.at("protocol"),"minor")==aural_release::protocol_minor;}
inline bool tick(const json& v,const char* key,uint64_t& out){
    const auto text=stringField(v,key);return !text.empty()&&(text.size()==1||text.front()!='0')&&decimalField(v,key,out);
}
inline bool text(const json& v,const char* key,size_t limit){
    const auto s=stringField(v,key);return !s.empty()&&s.size()<=limit&&std::none_of(s.begin(),s.end(),[](unsigned char c){return c<32||c==127;});
}
inline bool sameDriver(const json& v,const aural_asio::DriverIdentity& driver){
    return fields(v,{"registryName","clsid"})&&text(v,"registryName",512)&&text(v,"clsid",38)&&
        _wcsicmp(utf8ToWide(stringField(v,"registryName")).c_str(),utf8ToWide(driver.registryName).c_str())==0&&
        _wcsicmp(utf8ToWide(stringField(v,"clsid")).c_str(),utf8ToWide(driver.clsid).c_str())==0;
}
class Session final {
    Channel& channel;
    std::atomic<bool> cancelled{false},closing{false},inputClosed{false},overflow{false};
    // Reverse destruction order is essential: callbacks, ring, then borrowed file.
    AuralPlaybackFile file;
    aural_asio::DsdStream source;
    aural_asio::Engine engine;
    Timeline timeline;
    aural_asio::PreparedInfo prepared;
    Timeline::Reading reading;
    aural_asio::DsdTransport transport=aural_asio::DsdTransport::nativeDsd;
    AuralDsdInfo header;
    uint64_t startTick=0,endTick=0,initialTick=0,configurationRevision=0,renderSource=0;
    uint64_t lastCallbacks=0,lastWritten=0,tailTarget=0;
    uint32_t quantum=1,deviceRate=0;
    bool paused=false,started=false,disposed=false,prefilling=false,draining=false;
    json output,sourceInfo,authorization,requested;
    std::string planToken,outputLabel;
    std::thread input;
    std::mutex commandsMutex;
    std::deque<json> commands;
    struct Receipt {std::string identity,error;bool accepted;uint64_t generation;};
    std::map<std::string,Receipt> receipts;
    using Clock=std::chrono::steady_clock;
    Clock::time_point callbackAt,producerAt,lastReport,drainAt,counterInvalidAt;
    static bool uuid(const std::string& value){
        if(value.size()!=36)return false;
        for(size_t i=0;i<value.size();++i){if(i==8||i==13||i==18||i==23){if(value[i]!='-')return false;}
            else if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')||(value[i]>='A'&&value[i]<='F')))return false;}
        return true;
    }
    uint64_t consumed()const noexcept{return source.consumedSourceBits();}
    uint64_t remaining()const noexcept{return endTick-startTick-initialTick;}
    uint64_t callbackTick()const noexcept{return initialTick+consumed();}
    uint64_t positionTick()const noexcept {
        if(paused||!started)return initialTick;
        const auto units=reading.source;
        const auto bits=units>UINT64_MAX/quantum?UINT64_MAX:units*quantum;
        return initialTick+std::min<uint64_t>(std::min(bits,consumed()),remaining());
    }
    static aural_asio::DsdReadResult renderRead(void* context,uint8_t* bytes,uint32_t frames)noexcept {
        auto* self=static_cast<Session*>(context);self->renderSource=self->consumed()/self->quantum;
        return self->source.consume(bytes,frames);
    }
    static void publish(void* context,const aural_asio::RenderObservation& value)noexcept {
        auto* self=static_cast<Session*>(context);self->timeline.publish(value,self->renderSource);
    }
    json clock()const {
        return {{"version",1},{"transport",transport==aural_asio::DsdTransport::dop?"dop":"native-dsd"},
            {"authority",paused||!started?"paused-bookmark":reading.mapped?"driver-reported":"callback-estimate"},
            {"sourceTick",std::to_string(positionTick())},{"callbackTick",std::to_string(callbackTick())},{"bitRate",header.bitRate},
            {"deviceFrameUnit",quantum==1?"dsd-bit":"pcm-carrier"},{"deviceSampleRate",deviceRate},
            {"devicePosition",reading.mapped?json(std::to_string(reading.device)):json(nullptr)},
            {"systemTimeNs",reading.mapped?json(std::to_string(reading.time)):json(nullptr)},
            {"outputLatencyFrames",prepared.outputLatency},{"publishedMusicFrames",std::to_string(reading.publishedMusic)},
            {"hardwareVerified",false}};
    }
    json plan()const {
        return {{"version",1},{"backend","asio"},{"transport",quantum==1?"native-dsd":"dop"},
            {"configurationRevision",configurationRevision},{"source",sourceInfo},{"output",output},{"dopAuthorization",authorization},
            {"range",{{"startTick",std::to_string(startTick)},{"endTick",std::to_string(endTick)},{"initialTick",std::to_string(initialTick)}}},
            {"buffers",{{"preReadByteFrames",std::to_string(source.capacityByteFrames())},{"preReadBytes",source.capacityByteFrames()*header.channels},
                {"byteFramesPerBuffer",prepared.dsdByteFramesPerBuffer},{"scratchBytes",prepared.callbackScratchBytes}}},
            {"stages",json::array({"bound-raw-dsd-reader","normalized-msb-interleaved-ring",quantum==1?"native-bit-order-packing":"dop-integer-marker-packing","asio-double-buffer"})},
            {"clockPolicy","bit-ticks-via-driver-frames-and-output-latency"},{"tailPolicy","driver-clock-or-reported-latency-estimate"},
            {"hardwareVerified",false},{"bitPerfectVerified",false}};
    }
    json state(const char* status)const {
        return {{"state",status},{"position",double(positionTick())/header.bitRate},{"clock",clock()},
            {"output",outputLabel},{"requestedOutput",requested},{"source",sourceInfo},{"actualOutput",output},{"dsdPlan",plan()}};
    }
    json tail(const char* status,const char* evidence,uint64_t elapsed,bool proof)const {
        return {{"version",1},{"transport",quantum==1?"native-dsd":"dop"},{"status",status},{"evidence",evidence},
            {"sourceTick",std::to_string(endTick-startTick)},{"bitRate",header.bitRate},{"deviceFrameUnit",quantum==1?"dsd-bit":"pcm-carrier"},
            {"targetDeviceFrame",tailTarget?json(std::to_string(tailTarget)):json(nullptr)},
            {"outputLatencyFrames",prepared.outputLatency},{"bufferFrames",prepared.bufferFrames},{"elapsedMs",elapsed},
            {"driverPosition",proof?json(std::to_string(reading.device)):json(nullptr)},
            {"driverReleased",disposed},{"sourceReleased",disposed},{"hardwareVerified",false}};
    }
    bool release()noexcept {
        if(disposed)return true;
        // Never release a source/ring while a driver callback can still access it.
        if(!engine.close())return false;
        if(!source.close())return false;
        file.close();disposed=true;return true;
    }
    void beginInput(){
        inputClosed=false;
        input=std::thread([this]{
            try{json message;while(!closing.load(std::memory_order_acquire)&&readFrame(channel.pipe,message)){
                if(closing.load(std::memory_order_acquire))break;
                std::lock_guard<std::mutex> lock(commandsMutex);if(commands.size()>=16){overflow=true;break;}
                commands.push_back(std::move(message));
            }}catch(...){overflow=true;}
            inputClosed.store(true,std::memory_order_release);
        });
    }
    bool finishInput()noexcept {
        closing.store(true,std::memory_order_release);
        if(!input.joinable())return true;
        const auto deadline=GetTickCount64()+2000;
        while(!inputClosed.load(std::memory_order_acquire)){
            CancelIoEx(channel.pipe,nullptr);if(GetTickCount64()>=deadline)return false;Sleep(1);
        }
        input.join();return true;
    }
    json nextCommand(){
        std::lock_guard<std::mutex> lock(commandsMutex);if(commands.empty())return nullptr;
        auto result=std::move(commands.front());commands.pop_front();return result;
    }
    static std::string identity(const json& message){return json{{"method",stringField(message,"method")},{"params",message.at("params")},{"generation",message.at("expectedGeneration")}}.dump();}
    void validateStart(){
        require(file.begin(true)==MA_SUCCESS&&!source.failed(),"DSD source changed before start");
        const auto snapshot=engine.snapshot();
        require(!(snapshot.events&aural_asio::fatalEvents)&&snapshot.latencyRevision==prepared.observedLatencyRevision,
            "DSD prepared driver changed before start; a fresh plan is required");
    }
    void rebuild(const char* reason,uint64_t position,const char* desired,const std::string& causedBy=""){
        const auto binding=file.binding();
        require(release(),"DSD output/source release was not confirmed before rebuild");++channel.generation;
        channel.event("dsdRebuildRequired",{{"reason",reason},{"positionTick",std::to_string(position)},
            {"positionUs",std::to_string(aural_asio_session::framesToUs(position,header.bitRate))},{"bitRate",header.bitRate},
            {"startTick",std::to_string(startTick)},{"endTick",std::to_string(endTick)},{"fileBinding",binding},
            {"configurationRevision",configurationRevision},{"desiredState",desired},{"driverReleased",true},{"sourceReleased",true},{"hardwareVerified",false}},causedBy);
    }
    bool command(const json& message){
        require(protocol(message)&&stringField(message,"kind")=="command"&&stringField(message,"sessionId")==channel.session,
            "DSD command session is invalid");
        const auto id=stringField(message,"commandId"),request=stringField(message,"requestId"),method=stringField(message,"method");
        require(uuid(id)&&uuid(request)&&message.contains("params")&&message["params"].is_object(),"DSD command identity is invalid");
        const auto content=identity(message);const auto old=receipts.find(id);
        if(old!=receipts.end()){
            if(old->second.identity!=content)channel.receipt(request,id,false,"DSD command ID changed content");
            else channel.receipt(request,id,old->second.accepted,old->second.error,old->second.generation);return true;
        }
        if(receipts.size()>=1024){channel.receipt(request,id,false,"DSD command budget reached");return true;}
        const auto reply=[&](bool accepted,const std::string& error=""){
            receipts.emplace(id,Receipt{content,error,accepted,channel.generation.load()});channel.receipt(request,id,accepted,error);
        };
        const auto& params=message["params"];
        if(unsignedField(message,"expectedGeneration")!=channel.generation.load()){reply(false,"DSD command generation is stale");return true;}
        if(method=="playback.stop"){
            if(!params.empty()){reply(false,"DSD stop parameters must be empty");return true;}
            reply(true);require(release(),"DSD stop release was not confirmed");++channel.generation;
            channel.event("dsdStateChanged",{{"state","stopped"},{"driverReleased",true},{"sourceReleased",true}},id);return false;
        }
        if(method=="playback.snapshot"){
            if(!params.empty()){reply(false,"DSD snapshot parameters must be empty");return true;}
            reply(true);auto payload=state(prefilling?"preparing":paused?"paused":"playing");payload["tail"]=draining?tail("draining","pending",0,false):json(nullptr);
            channel.event("dsdSnapshot",payload,id);return true;
        }
        if(prefilling){reply(false,"DSD source is still prefilling");return true;}
        if(method=="playback.resume"&&paused&&!started){
            if(!params.empty()){reply(false,"DSD resume parameters must be empty");return true;}
            validateStart();reply(true);
            engine.start();started=true;paused=false;callbackAt=producerAt=Clock::now();channel.event("dsdStateChanged",state("playing"),id);return true;
        }
        if(method=="analysis.configure"){
            if(!fields(params,{"enabled"})||!params["enabled"].is_boolean()||params["enabled"].get<bool>()){reply(false,"DSD analysis requires a separate PCM copy, not a bitstream tap");return true;}
            reply(true);return true;
        }
        if(method=="playback.pause"||method=="playback.seek"){
            uint64_t target=positionTick();
            if(method=="playback.pause"&&!params.empty()){reply(false,"DSD pause parameters must be empty");return true;}
            if(method=="playback.seek"){
                uint64_t position=0;
                if(fields(params,{"positionTick"})&&tick(params,"positionTick",position))target=position;
                else if(fields(params,{"positionUs"})&&tick(params,"positionUs",position)&&position<=safeInteger)target=aural_asio_session::usToFrames(position,header.bitRate);
                else{reply(false,"DSD seek timebase is invalid");return true;}
                if(target>=endTick-startTick){reply(false,"DSD seek is outside its frozen source range");return true;}
            }
            target=std::min(target,endTick-startTick-1);reply(true);
            rebuild(method=="playback.pause"?"pause":"seek",target,method=="playback.pause"||paused?"paused":"playing",id);return false;
        }
        reply(false,"DSD command would require a fresh plan or is unavailable");return true;
    }
    void observe(){
        require(file.begin()==MA_SUCCESS,"DSD bound file changed during playback");require(!source.failed(),"DSD producer failed or its source changed");
        const auto snapshot=engine.snapshot();const auto bits=consumed();
        const auto units=bits/quantum+(bits%quantum?1:0);
        reading=timeline.observe(snapshot,units,prepared.outputLatency);require(reading.healthy,"DSD driver publication timeline is invalid");
        const auto recoverable=aural_asio::resetRequested|aural_asio::resyncRequested|aural_asio::bufferSizeChanged|aural_asio::sampleRateChanged|aural_asio::clockChanged;
        require(!(snapshot.events&(aural_asio::fatalEvents&~recoverable)),"DSD callback, packing or output-ready failed");
        if(snapshot.events&recoverable||snapshot.latencyRevision!=prepared.observedLatencyRevision){
            rebuild("driver-reconfigure",std::min(positionTick(),endTick-startTick-1),"paused");return;
        }
        const auto now=Clock::now();
        if(snapshot.countersValid)counterInvalidAt={};
        else{if(counterInvalidAt==Clock::time_point{})counterInvalidAt=now;
            require(now-counterInvalidAt<=std::chrono::seconds(2),"DSD publication counters remained unreadable");}
        if(snapshot.callbacks!=lastCallbacks){lastCallbacks=snapshot.callbacks;callbackAt=now;}
        require(!started||uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(now-callbackAt).count())<=3000,"DSD callbacks stalled");
        const auto written=source.writtenByteFrames();if(written!=lastWritten){lastWritten=written;producerAt=now;}
        require(!started||source.eof()||source.availableByteFrames()>=prepared.dsdByteFramesPerBuffer||
            uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(now-producerAt).count())<=3000,"DSD producer stalled without normal EOF");
        if(started&&source.eof()&&bits==remaining()&&snapshot.countersValid&&snapshot.publishedDsdBits==bits&&snapshot.musicFrames==units&&reading.publishedMusic==units){
            if(!draining){require(bits>0,"DSD source published no valid bits");draining=true;drainAt=now;tailTarget=reading.musicTimed?reading.lastMusicEnd:0;channel.event("dsdTail",{{"tail",tail("draining","pending",0,false)}});}
            const auto elapsed=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(now-drainAt).count());
            const bool proof=tailTarget&&reading.mapped&&reading.device>=tailTarget;
            const auto estimate=(uint64_t(prepared.outputLatency)*1000+uint64_t(prepared.bufferFrames)*3000+deviceRate-1)/deviceRate+100;
            require(elapsed<=30000,"DSD tail exceeded its drain budget");
            if(proof||elapsed>=estimate){require(file.begin(true)==MA_SUCCESS,"DSD file changed before completion");
                channel.event("dsdPosition",{{"position",double(positionTick())/header.bitRate},{"clock",clock()},
                    {"publishedSourceBits",std::to_string(snapshot.publishedDsdBits)},{"callbackCount",std::to_string(snapshot.callbacks)},
                    {"underrunFrames",std::to_string(snapshot.underrunFrames)}});
                require(release(),"DSD tail release was not confirmed");
                channel.event("dsdStateChanged",{{"state","ended"},{"tail",tail("completed",proof?"driver-clock":"driver-latency-period-estimate",elapsed,proof)}});return;}
        }
        if(snapshot.countersValid&&now-lastReport>=std::chrono::milliseconds(250)){
            channel.event("dsdPosition",{{"position",double(positionTick())/header.bitRate},{"clock",clock()},
                {"publishedSourceBits",std::to_string(snapshot.publishedDsdBits)},{"callbackCount",std::to_string(snapshot.callbacks)},
                {"underrunFrames",std::to_string(snapshot.underrunFrames)}});lastReport=now;
        }
    }
    void authorize(const aural_asio::DriverIdentity& driver,const json& mapping){
        if(quantum==1){require(authorization.is_null(),"Native DSD must not carry a DoP authorization");return;}
        require(fields(authorization,{"kind","profileId","revision","driver","driverVersion","dacName","supportedBitRates","outputChannels","evidenceText","documentConfirmed","volumeConfirmed","hardwareVerified"})&&
            stringField(authorization,"kind")=="userConfigured"&&uuid(stringField(authorization,"profileId"))&&unsignedField(authorization,"revision")<=safeInteger&&
            sameDriver(authorization["driver"],driver)&&authorization["driverVersion"].is_number_integer()&&authorization["driverVersion"].get<int64_t>()==engine.driverVersion()&&
            text(authorization,"dacName",1024)&&text(authorization,"evidenceText",4096)&&authorization["outputChannels"]==mapping&&
            authorization["documentConfirmed"]==json(true)&&authorization["volumeConfirmed"]==json(true)&&authorization["hardwareVerified"]==json(false)&&
            authorization["supportedBitRates"].is_array()&&!authorization["supportedBitRates"].empty()&&authorization["supportedBitRates"].size()<=3,"DoP driver/DAC profile is invalid or stale");
        std::vector<uint32_t> rates;for(const auto& value:authorization["supportedBitRates"]){
            require(value.is_number_unsigned()||value.is_number_integer(),"DoP profile rate is invalid");const auto rate=value.get<int64_t>();
            require(rate>=0&&rate<=UINT32_MAX&&aural_asio::dsdBitRate(uint32_t(rate))&&std::find(rates.begin(),rates.end(),uint32_t(rate))==rates.end(),"DoP profile rate is unsupported or repeated");rates.push_back(uint32_t(rate));
        }
        require(std::find(rates.begin(),rates.end(),header.bitRate)!=rates.end(),"DoP profile does not authorize this DSD rate");
    }
public:
    explicit Session(Channel& value):channel(value){}
    ~Session()noexcept {
        if(!release()||!finishInput()){TerminateProcess(GetCurrentProcess(),70);std::terminate();}
        if(channel.pipe!=INVALID_HANDLE_VALUE){DisconnectNamedPipe(channel.pipe);CloseHandle(channel.pipe);channel.pipe=INVALID_HANDLE_VALUE;}
    }
    int fail(const std::string& message){
        if(!release()){TerminateProcess(GetCurrentProcess(),70);std::terminate();}
        channel.event("error",{{"message",std::string("DSD session failed: ")+message},{"driverReleased",true},{"sourceReleased",true}});return 2;
    }
    int run(const json& hello,const json& play){
        const auto& params=play.at("params");const auto request=stringField(play,"requestId"),id=stringField(play,"commandId");
        require(protocol(hello)&&protocol(play)&&uuid(request)&&uuid(id)&&fields(params,{"backend","transport","path","asio","source","initialPaused","dopAuthorization","expectedFile"})&&
            stringField(params,"backend")=="asio"&&text(params,"path",131068)&&params["initialPaused"].is_boolean(),"DSD play parameters are invalid");
        const auto name=stringField(params,"transport");require(name=="native-dsd"||name=="dop","DSD transport is invalid");
        transport=name=="dop"?aural_asio::DsdTransport::dop:aural_asio::DsdTransport::nativeDsd;quantum=name=="dop"?16:1;
        paused=params["initialPaused"].get<bool>();authorization=params["dopAuthorization"];requested=params["asio"];
        require(fields(requested,{"configurationRevision","driver","outputChannels","bufferFrames"})&&
            fields(requested["driver"],{"registryName","clsid"})&&requested["outputChannels"].is_array()&&
            !requested["outputChannels"].empty()&&requested["outputChannels"].size()<=16,"DSD output configuration is invalid");
        configurationRevision=unsignedField(requested,"configurationRevision");require(configurationRevision<=safeInteger,"DSD output revision is invalid");
        aural_asio::DsdConfiguration configuration;configuration.transport=transport;
        const auto buffer=unsignedField(requested,"bufferFrames");require(buffer<=32768,"DSD buffer exceeds its budget");configuration.bufferFrames=uint32_t(buffer);
        for(const auto& value:requested["outputChannels"]){require(value.is_number_integer(),"DSD output mapping is invalid");const auto index=value.get<int64_t>();
            require(index>=0&&index<4096&&std::find(configuration.outputChannels.begin(),configuration.outputChannels.end(),int32_t(index))==configuration.outputChannels.end(),"DSD output mapping is repeated or out of range");configuration.outputChannels.push_back(int32_t(index));}
        const aural_asio::DriverIdentity driver{stringField(requested["driver"],"registryName"),stringField(requested["driver"],"clsid"),""};
        require(text(requested["driver"],"registryName",512)&&text(requested["driver"],"clsid",38),"DSD driver identity is invalid");
        const auto& range=params["source"];const bool bitRange=fields(range,{"bitRate","channels","startTick","endTick","initialTick"});
        require(bitRange||fields(range,{"bitRate","channels","timebase","start","end","initialUs"}),"DSD source range fields are invalid");
        require(file.open(utf8ToWide(stringField(params,"path")),&cancelled)==MA_SUCCESS,"DSD read-only source cannot be opened");
        const auto binding=file.binding();require(params["expectedFile"].is_null()||params["expectedFile"]==binding,"DSD source binding changed before prepare");
        std::string reason;require(auralInspectDsd(file.handle,header,reason,true)==AuralDsdProbe::valid&&aural_asio::dsdBitRate(header.bitRate),"DSD raw source is unsupported or invalid");
        const auto expectedRate=unsignedField(range,"bitRate"),expectedChannels=unsignedField(range,"channels");
        require((expectedRate==0||expectedRate==header.bitRate)&&expectedChannels==header.channels&&configuration.outputChannels.size()==header.channels,"DSD source format differs from its request");
        if(bitRange){
            require(tick(range,"startTick",startTick)&&tick(range,"initialTick",initialTick),"DSD source range is invalid");
            if(range["endTick"].is_null())endTick=header.validBitSamples;else require(tick(range,"endTick",endTick),"DSD source end is invalid");
        }else{
            const auto unit=stringField(range,"timebase");require(unit=="microseconds"||unit=="cue-75","DSD source timebase is invalid");
            const auto convert=[&](uint64_t value){
                require(value<=safeInteger,"DSD source time exceeds IPC range");
                if(unit=="microseconds")return aural_asio_session::usToFrames(value,header.bitRate);
                require(value<=UINT64_MAX/header.bitRate,"DSD CUE time overflows its source timebase");return value*header.bitRate/75;
            };
            uint64_t first=0,last=0,initialUs=0;require(tick(range,"start",first)&&tick(range,"initialUs",initialUs),"DSD source time range is invalid");
            startTick=convert(first);initialTick=aural_asio_session::usToFrames(initialUs,header.bitRate);
            if(range["end"].is_null())endTick=header.validBitSamples;
            else{require(tick(range,"end",last)&&last>first,"DSD source time end is invalid");endTick=convert(last);}
        }
        require(startTick<endTick&&endTick<=header.validBitSamples&&initialTick<endTick-startTick,"DSD source range exceeds its container");
        (void)aural_asio_session::framesToUs(endTick-startTick,header.bitRate);
        source.open(file.handle,header.bitRate,header.channels,startTick+initialTick,endTick,transport);
        const auto& reopened=source.info();
        require(reopened.validBitSamples==header.validBitSamples&&reopened.dataOffset==header.dataOffset&&reopened.dataBytes==header.dataBytes&&
            reopened.container==header.container&&reopened.blockBytes==header.blockBytes&&reopened.layoutCode==header.layoutCode&&reopened.channelTags==header.channelTags&&
            reopened.planar==header.planar&&reopened.lsbFirst==header.lsbFirst,"DSD source header changed while opening its ring");
        engine.open(driver);require(sameDriver(requested["driver"],engine.identity()),"DSD initialized driver identity changed");authorize(engine.identity(),requested["outputChannels"]);
        configuration.bitRate=header.bitRate;configuration.channels=header.channels;configuration.firstSourceTick=startTick+initialTick;configuration.dopUserConfigured=quantum==16;
        timeline.reset(0);prepared=engine.prepareDsd(configuration,{this,renderRead,publish});deviceRate=quantum==1?header.bitRate:header.bitRate/16;
        require(prepared.dsdBitstream&&prepared.dsdBitRate==header.bitRate&&prepared.sampleRate==deviceRate&&prepared.latencyKnown&&prepared.outputLatency<=uint64_t(deviceRate)*5,"DSD prepared format or latency is invalid");
        require(file.begin(true)==MA_SUCCESS,"DSD source changed during prepare");
        json layouts=json::array();for(const auto& value:prepared.channels)layouts.push_back({{"index",value.index},{"name",value.name},{"group",value.group},{"sampleType",value.sampleType},
            {"containerBytes",value.containerBytes},{"validBits",value.validBits},{"floating",value.floating},{"bigEndian",value.bigEndian},{"rightAligned",value.rightAligned}});
        output={{"backend","asio"},{"identity",{{"registryName",prepared.identity.registryName},{"clsid",prepared.identity.clsid},{"description",prepared.identity.description}}},
            {"driverName",prepared.driverName},{"driverVersion",prepared.driverVersion},{"transport",name},{"bitRate",header.bitRate},{"deviceSampleRate",deviceRate},
            {"deviceFrameUnit",quantum==1?"dsd-bit":"pcm-carrier"},{"channels",layouts},{"bufferFrames",prepared.bufferFrames},
            {"byteFramesPerBuffer",prepared.dsdByteFramesPerBuffer},{"outputLatencyFrames",prepared.outputLatency},{"numericConversion",false},{"softwareGain",false},
            {"nativeDsdModeReported",prepared.nativeDsdModeReported},{"dopUserConfigured",prepared.dopUserConfigured},{"hardwareVerified",false}};
        json tags=json::array();for(uint32_t i=0;i<header.channels;++i)tags.push_back(header.channelTags[i]);
        sourceInfo={{"kind","dsd-msb-first-interleaved"},{"container",header.container},{"bitRate",header.bitRate},{"channels",header.channels},
            {"totalTicks",std::to_string(header.validBitSamples)},{"layoutCode",header.layoutCode},{"channelTags",tags},
            {"storage",{{"planar",header.planar},{"lsbFirst",header.lsbFirst},{"blockBytes",header.blockBytes}}},
            {"payload",{{"offset",std::to_string(header.dataOffset)},{"bytes",std::to_string(header.dataBytes)}}},{"fileBinding",binding}};
        outputLabel="ASIO · "+prepared.driverName+" · "+name+" (unverified)";
        planToken=channel.session+"-"+stringField(hello,"nonce")+"-asio-dsd-1";channel.generation=1;channel.receipt(request,id,true);
        auto payload=state("preparing");payload["initialPaused"]=paused;payload["planToken"]=planToken;channel.event("dsdPrepared",payload,id);
        json approval;require(readFrame(channel.pipe,approval,GetTickCount64()+10000),"DSD plan approval timed out");
        require(protocol(approval)&&stringField(approval,"kind")=="command"&&stringField(approval,"sessionId")==channel.session&&unsignedField(approval,"expectedGeneration")==1&&
            uuid(stringField(approval,"requestId"))&&uuid(stringField(approval,"commandId"))&&stringField(approval,"commandId")!=id&&approval.contains("params")&&approval["params"].is_object(),"DSD approval identity is invalid");
        if(stringField(approval,"method")=="playback.stop"){
            require(approval["params"].empty(),"DSD prepared stop parameters are invalid");channel.receipt(stringField(approval,"requestId"),stringField(approval,"commandId"),true);
            require(release(),"DSD prepared stop release was not confirmed");++channel.generation;channel.event("dsdStateChanged",{{"state","stopped"},{"driverReleased",true},{"sourceReleased",true}},stringField(approval,"commandId"));return 0;
        }
        require(stringField(approval,"method")=="playback.start"&&fields(approval["params"],{"planToken"})&&stringField(approval["params"],"planToken")==planToken,"DSD prepared plan was not accepted");
        receipts.emplace(id,Receipt{identity(play),"",true,1});receipts.emplace(stringField(approval,"commandId"),Receipt{identity(approval),"",true,1});
        require(file.begin(true)==MA_SUCCESS,"DSD source changed before approved start");channel.receipt(stringField(approval,"requestId"),stringField(approval,"commandId"),true);
        beginInput();prefilling=true;source.start();const auto deadline=GetTickCount64()+2000;
        const auto required=std::min<uint64_t>(prepared.dsdByteFramesPerBuffer,remaining()/8+(remaining()%8?1:0));
        while(source.availableByteFrames()<required&&!source.failed()){
            engine.pumpMessages();require(!overflow.load(),"DSD command queue failed during prefill");if(inputClosed.load()){require(release(),"DSD disconnected cleanup failed");return 0;}
            const auto message=nextCommand();if(!message.is_null()&&!command(message))return 0;
            require(GetTickCount64()<deadline,"DSD source prefill timed out");Sleep(2);
        }
        prefilling=false;require(!source.failed()&&source.availableByteFrames()>=required,"DSD source produced no approved prefill");
        validateStart();if(!paused){engine.start();started=true;}
        callbackAt=producerAt=lastReport=Clock::now();lastWritten=source.writtenByteFrames();channel.event("dsdStateChanged",state(paused?"paused":"playing"),id);
        while(!disposed){
            engine.pumpMessages();require(!overflow.load(),"DSD input queue exceeded its budget or failed");if(inputClosed.load()){require(release(),"DSD disconnected cleanup failed");break;}
            observe();if(disposed)break;const auto message=nextCommand();if(!message.is_null()&&!command(message))break;Sleep(5);
        }return 0;
    }
};
inline int run(Channel& channel,const json& hello,const json& play){
    auto session=std::make_unique<Session>(channel);try{return session->run(hello,play);}
    catch(const std::exception& error){return session->fail(error.what());}
    catch(...){return session->fail("unknown native DSD session failure");}
}
}
