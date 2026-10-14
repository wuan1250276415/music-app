// Generated from release/tag-write-certification.json. Never enable from environment or IPC.
#pragma once
#include <array>
#include <string>
namespace tag_certification {
constexpr std::array<const char*,0> ids={};
inline bool permits(const std::string& id){for(const auto* v:ids)if(id==v)return true;return false;}
}
