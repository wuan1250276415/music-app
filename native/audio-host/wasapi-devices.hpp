#pragma once
#include <string>
#include <vector>
#include <algorithm>
#include <thread>
#include <tlhelp32.h>
#include "parent-watch.hpp"
namespace aural_devices {
struct Endpoint {ma_device_id nativeId{};std::string id,name;bool isDefault=false;};
struct Catalog {std::vector<Endpoint> devices;bool truncated=false,incomplete=false;};
inline std::string endpointId(const ma_device_id& id) {
    size_t length=0;while(length<64&&id.wasapi[length])++length;if(!length||length==64)return {};
    const int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,id.wasapi,static_cast<int>(length),nullptr,0,nullptr,nullptr);
    if(count<=0||count>255)return {};std::string result(count,'\0');
    if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,id.wasapi,static_cast<int>(length),&result[0],count,nullptr,nullptr))return {};
    for(unsigned char c:result)if(c<32||c==127)return {};return result;
}
inline ma_bool32 visit(ma_context*,ma_device_type type,const ma_device_info* info,void* pointer) {
    if(type!=ma_device_type_playback)return MA_TRUE;auto& result=*static_cast<Catalog*>(pointer);
    if(result.devices.size()>=128){result.truncated=true;return MA_FALSE;}
    const std::string id=endpointId(info->id);size_t length=0;while(length<sizeof(info->name)&&info->name[length])++length;
    if(id.empty()||!length||length==sizeof(info->name)||MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,info->name,static_cast<int>(length),nullptr,0)<=0){result.incomplete=true;return MA_TRUE;}
    std::string name(info->name,length);for(char& c:name)if(static_cast<unsigned char>(c)<32||c==127)c=' ';
    if(std::any_of(result.devices.begin(),result.devices.end(),[&](const Endpoint& e){return e.id==id;})){result.incomplete=true;return MA_TRUE;}
    result.devices.push_back({info->id,id,name,info->isDefault!=MA_FALSE});return MA_TRUE;
}
inline ma_result enumerate(ma_context& context,Catalog& result){return ma_context_enumerate_devices(&context,visit,&result);}
inline int report(const wchar_t* nonce,const wchar_t* parentText) {
    ParentWatch watch;if(!watch.init(parentText))return 70;
    size_t length=0;while(length<37&&nonce[length])++length;if(length!=36)return 64;
    std::string token;for(size_t i=0;i<length;++i){if(nonce[i]>127)return 64;token.push_back(static_cast<char>(nonce[i]));}
    ma_context context{};const ma_backend backend=ma_backend_wasapi;
    if(ma_context_init(&backend,1,nullptr,&context)!=MA_SUCCESS)return 65;Catalog catalog;
    const ma_result rc=enumerate(context,catalog);ma_context_uninit(&context);if(rc!=MA_SUCCESS)return 66;
    nlohmann::json devices=nlohmann::json::array();for(const auto& item:catalog.devices)devices.push_back({{"id",item.id},{"name",item.name},{"isDefault",item.isDefault}});
    const std::string body=nlohmann::json({{"protocol",{{"major",aural_release::protocol_major},{"minor",aural_release::protocol_minor}}},{"buildId",aural_release::host_build_id},{"nonce",token},{"backend","wasapi"},{"devices",devices},{"truncated",catalog.truncated},{"incomplete",catalog.incomplete}}).dump();
    if(body.size()>256*1024)return 67;const uint32_t size=static_cast<uint32_t>(body.size());std::string frame(4,'\0');for(int i=0;i<4;++i)frame[i]=static_cast<char>(size>>(8*i));frame+=body;
    size_t offset=0;while(offset<frame.size()){DWORD sent=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),frame.data()+offset,static_cast<DWORD>(frame.size()-offset),&sent,nullptr)||!sent)return 68;offset+=sent;}return 0;
}
}
