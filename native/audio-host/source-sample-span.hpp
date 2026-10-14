#pragma once
#include "vendor/json.hpp"
#include <cstdint>
#include <stdexcept>
#include <string>

namespace aural_sample_span {
struct Range {uint32_t rate;uint64_t start,end,boundary;bool next;};
inline uint64_t decimal(const nlohmann::json& value){
 if(!value.is_string())throw std::runtime_error("sample span requires decimal strings");
 const auto text=value.get<std::string>();
 if(text.empty()||text.size()>16||text.size()>1&&text[0]=='0')throw std::runtime_error("noncanonical sample position");
 uint64_t number=0;for(const auto c:text){if(c<'0'||c>'9')throw std::runtime_error("invalid sample position");number=number*10+uint64_t(c-'0');if(number>9007199254740991ULL)throw std::runtime_error("sample position exceeds source budget");}
 return number;
}
inline Range read(const nlohmann::json& value,uint32_t decodedRate=0){
 if(!value.is_object()||value.size()!=5||!value.contains("sampleRate")||!value.contains("startFrame")||!value.contains("endFrame")||!value.contains("nextStartFrame")||!value.contains("nextEndFrame")||!value["sampleRate"].is_number_integer()||value["sampleRate"]<1||value["sampleRate"]>1536000)throw std::runtime_error("invalid sample span fields");
 const auto rate=value["sampleRate"].get<uint32_t>();if(decodedRate&&decodedRate!=rate)throw std::runtime_error("decoded sample rate differs from embedded sample span");
 const auto start=decimal(value["startFrame"]),end=decimal(value["endFrame"]);const bool next=!value["nextStartFrame"].is_null();
 if(end<=start||next!=!value["nextEndFrame"].is_null())throw std::runtime_error("invalid sample span bounds");
 if(!next)return {rate,start,end,UINT64_MAX,false};
 const auto followingStart=decimal(value["nextStartFrame"]),followingEnd=decimal(value["nextEndFrame"]);
 if(followingStart!=end||followingEnd<=end)throw std::runtime_error("sample spans are not adjacent");
 return {rate,start,followingEnd,end,true};
}
}
