#pragma once
// Included after readFrame and the private-host helpers. This command runs only
// in a disposable STA process, before any buffers or playback can be prepared.
#include "asio-query.hpp"
#include <atomic>

namespace aural_asio_panel {
using Json=nlohmann::json;
inline bool uuid(const std::string& value){
    if(value.size()!=36)return false;
    for(size_t i=0;i<36;++i){if(i==8||i==13||i==18||i==23){if(value[i]!='-')return false;}
        else if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')||(value[i]>='A'&&value[i]<='F')))return false;}return true;
}
struct Deadline {
    HANDLE done=CreateEventW(nullptr,TRUE,FALSE,nullptr);std::thread worker;
    Deadline(){if(!done)throw std::runtime_error("ASIO panel deadline could not be created");try{worker=std::thread([this](){if(WaitForSingleObject(done,905000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),70);});}catch(...){CloseHandle(done);done=nullptr;throw;}}
    ~Deadline(){SetEvent(done);if(worker.joinable())worker.join();CloseHandle(done);}
};
struct Input {
    std::atomic<bool> finish{false},invalid{false},closed{false},stopping{false},completed{false};std::thread worker;
    Input(const std::string& nonce,const std::string& operation){
        worker=std::thread([this,nonce,operation](){
            struct Completion {std::atomic<bool>& flag;~Completion(){flag.store(true);}} completion{completed};
            try{
            auto exact=[this](void* bytes,DWORD length){DWORD offset=0;while(offset<length){if(stopping.load())return false;DWORD read=0;if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),static_cast<char*>(bytes)+offset,length-offset,&read,nullptr)||!read)return false;offset+=read;}return true;};
            uint8_t size[4]{};if(!exact(size,4)){closed=true;return;}
            const uint32_t length=uint32_t(size[0])|(uint32_t(size[1])<<8)|(uint32_t(size[2])<<16)|(uint32_t(size[3])<<24);
            if(!length||length>512){invalid=true;return;}std::string bytes(length,'\0');if(!exact(bytes.data(),length)){closed=true;return;}
            const auto command=Json::parse(bytes);if(!command.is_object()||command.size()!=4||command.value("nonce",std::string())!=nonce||command.value("operationId",std::string())!=operation||command.value("action",std::string())!="finish"||!uuid(command.value("commandId",std::string())))invalid=true;else finish=true;
            }
            catch(...){invalid=true;}
        });
    }
    ~Input(){if(worker.joinable()){stopping=true;while(!completed.load()){CancelSynchronousIo(worker.native_handle());Sleep(1);}worker.join();}}
};
inline int run(const wchar_t* nonceText,const wchar_t* parent,const wchar_t* name,const wchar_t* clsid,const wchar_t* operationText){
    aural_devices::ParentWatch parentWatch;if(!parentWatch.init(parent))return 70;
    const auto nonce=aural_asio_query::text(nonceText,36),operation=aural_asio_query::text(operationText,36);
    if(!uuid(nonce)||!uuid(operation))return 64;
    Deadline deadline;aural_asio::Engine engine;uint32_t sequence=0;
    aural_asio::DriverIdentity identity{aural_asio_query::text(name,512),aural_asio_query::text(clsid,38),{}};
    auto report=[&](const char* phase,const char* message,bool released){
        if(aural_asio_query::write({{"version",1},{"backend","asio"},{"operation","panel"},{"buildId",aural_release::host_build_id},{"nonce",nonce},{"architecture","x64"},
            {"payload",{{"sequence",++sequence},{"identity",aural_asio_query::identity(identity)},{"phase",phase},{"message",message},{"driverReleased",released},{"buffersCreated",false},{"playbackStarted",false},{"hardwareVerified",false}}}})!=0)throw std::runtime_error("ASIO panel report pipe failed");
    };
    try{
        engine.open(identity);identity=engine.identity(); // Do not require capability inspection just to open vendor settings.
        report("calling","ASIO driver controlPanel call is in progress",false);
        engine.pumpMessages();engine.controlPanel();
        report("returned","ASIO controlPanel returned; its window closure is not proven",false);
        Input input(nonce,operation);
        while(!input.finish.load()&&!input.invalid.load()&&!input.closed.load()){
            engine.pumpMessages();if(engine.snapshot().events&aural_asio::ownerQuit)throw std::runtime_error("ASIO panel owner requested exit");Sleep(10);
        }
        if(input.invalid.load())throw std::runtime_error("ASIO panel finish identity is invalid");
        if(input.closed.load())throw std::runtime_error("ASIO panel supervisor channel was closed");
        if(!engine.close())return 70;report("closed","ASIO driver reference and owning process resources were released",true);return 0;
    }catch(...){
        if(!engine.close())return 70;
        try{report("failed","ASIO driver initialization, control panel or supervisor session failed",true);return 0;}catch(...){return 69;}
    }
}
}
