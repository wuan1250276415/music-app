#pragma once
#include "asio-backend.hpp"
#include "parent-watch.hpp"
#include "vendor/json.hpp"
#include "release.hpp"
#include <stdexcept>
#include <string>

namespace aural_asio_query {
using Json=nlohmann::json;
inline std::string text(const wchar_t* value,size_t limit) {
    const size_t length=wcsnlen_s(value,limit+1);
    if(!length||length>limit)throw std::runtime_error("ASIO query identity is invalid");
    const int bytes=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value,int(length),nullptr,0,nullptr,nullptr);
    if(bytes<=0)throw std::runtime_error("ASIO query identity is invalid UTF-16");
    std::string result(size_t(bytes),'\0');
    if(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value,int(length),result.data(),bytes,nullptr,nullptr)!=bytes)
        throw std::runtime_error("ASIO query identity conversion failed");
    return result;
}
inline Json identity(const aural_asio::DriverIdentity& driver) {
    return {{"registryName",driver.registryName},{"clsid",driver.clsid},{"description",driver.description}};
}
inline int write(const Json& reply) {
    const auto body=reply.dump();if(body.size()>256*1024)return 67;
    const uint32_t count=uint32_t(body.size());std::string frame(4,'\0');
    for(int i=0;i<4;++i)frame[i]=char(count>>(8*i));frame+=body;
    size_t offset=0;while(offset<frame.size()){
        DWORD sent=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),frame.data()+offset,DWORD(frame.size()-offset),&sent,nullptr)||!sent)return 68;offset+=sent;
    }
    return 0;
}
inline int report(const wchar_t* nonce,const wchar_t* parent,const wchar_t* registryName=nullptr,const wchar_t* clsid=nullptr) {
    aural_devices::ParentWatch watch;if(!watch.init(parent))return 70;
    const auto token=text(nonce,36);if(token.size()!=36)return 64;
    for(size_t i=0;i<token.size();++i){
        if(i==8||i==13||i==18||i==23){if(token[i]!='-')return 64;}
        else if(!((token[i]>='0'&&token[i]<='9')||(token[i]>='a'&&token[i]<='f')||(token[i]>='A'&&token[i]<='F')))return 64;
    }
    Json payload;const bool inspection=registryName!=nullptr;
    if(!inspection){
        const auto catalog=aural_asio::enumerateDrivers();Json drivers=Json::array();
        for(const auto& driver:catalog.drivers)drivers.push_back(identity(driver));
        payload={{"registryStatus",catalog.registryStatus},{"skipped",catalog.skipped},{"truncated",catalog.truncated},{"drivers",drivers}};
    }else{
        aural_asio::Engine engine;engine.open({text(registryName,512),text(clsid,38),{}});
        const auto info=engine.inspect();Json channels=Json::array();
        for(const auto& channel:info.channels)channels.push_back({{"index",channel.index},{"sampleType",channel.sampleType},{"group",channel.group},{"name",channel.name},
            {"containerBytes",channel.containerBytes},{"validBits",channel.validBits},{"floating",channel.floating},{"bigEndian",channel.bigEndian},{"rightAligned",channel.rightAligned}});
        Json formats=Json::array(),rates=Json::array();
        for(const auto& f:info.ioFormats)formats.push_back({{"requestedFormat",f.requested},{"returnedFormat",f.returned},{"error",f.error}});
        for(const auto& r:info.sampleRates)rates.push_back({{"rate",r.rate},{"error",r.error}});
        // A success is publishable only after driver teardown has completed.
        if(!engine.close())return 70;
        payload={{"identity",identity(info.identity)},{"driverName",info.driverName},{"driverVersion",info.driverVersion},
            {"inputChannels",info.inputChannels},{"outputChannels",info.outputChannels},{"channels",channels},{"channelsTruncated",info.channelsTruncated},
            {"buffers",{{"minimum",info.minimumFrames},{"maximum",info.maximumFrames},{"preferred",info.preferredFrames},{"granularity",info.granularity}}},
            {"currentSampleRate",info.sampleRateKnown?Json(info.currentSampleRate):Json(nullptr)},{"ioMode",info.ioMode},
            {"latencies",info.latencyKnown?Json{{"input",info.inputLatency},{"output",info.outputLatency}}:Json(nullptr)},
            {"ioFormats",formats},{"sampleRates",rates},{"buffersCreated",false},{"playbackStarted",false},{"hardwareVerified",false}};
    }
    return write({{"version",1},{"backend","asio"},{"operation",inspection?"inspect":"catalog"},{"buildId",aural_release::host_build_id},
        {"nonce",token},{"architecture","x64"},{"payload",payload}});
}
}
