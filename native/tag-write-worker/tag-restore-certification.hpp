// Generated from release/tag-restore-certification.json. Never enable from environment or IPC.
#pragma once
#include <array>
#include <string>
namespace tag_restore_certification {
struct Certificate {const char* id;const char* mode;unsigned version;};
constexpr std::array<Certificate,0> certificates={};
inline bool permits(const std::string& id,const std::string& mode,unsigned version){for(const auto& c:certificates)if(id==c.id&&mode==c.mode&&version==c.version)return true;return false;}
}
