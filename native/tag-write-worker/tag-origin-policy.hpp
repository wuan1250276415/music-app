#pragma once
// Included by tag-file-transaction.hpp after security helpers. No privileges are enabled or owners changed.
static json captureOriginPolicy(HANDLE handle){
 Security source(handle);FILE_BASIC_INFO basic{};if(!GetFileInformationByHandleEx(handle,FileBasicInfo,&basic,sizeof(basic)))throw std::runtime_error("original policy timestamps unavailable");
 if(source.dacl&&source.dacl->AclSize>16384)throw std::runtime_error("original DACL exceeds archive budget");
 return {{"version",1},{"ownerSidHex",hex(static_cast<unsigned char*>(source.owner),GetLengthSid(source.owner))},{"groupSidHex",hex(static_cast<unsigned char*>(source.group),GetLengthSid(source.group))},{"daclHex",source.dacl?json(hex(reinterpret_cast<unsigned char*>(source.dacl),source.dacl->AclSize)):json(nullptr)},{"security",securityEvidence(source)},{"creation",std::to_string(ticks(basic.CreationTime))},{"modified",std::to_string(ticks(basic.LastWriteTime))},{"lastAccess",std::to_string(ticks(basic.LastAccessTime))},{"attributes",basic.FileAttributes},{"streams","unnamed-only"},{"audit","not-certified"}};
}
struct OriginPolicyBytes {
 json policy;std::vector<unsigned char> owner,group,dacl;
 static std::vector<unsigned char> decode(const json& value,size_t max){
  if(!value.is_string())throw std::runtime_error("original policy hex type");const auto s=value.get<std::string>();if(s.empty()||s.size()%2||s.size()>max*2)throw std::runtime_error("original policy hex bounds");std::vector<unsigned char> out(s.size()/2);
  const auto nibble=[](char c)->unsigned{if(c>='0'&&c<='9')return unsigned(c-'0');if(c>='a'&&c<='f')return unsigned(c-'a'+10);throw std::runtime_error("original policy hex encoding");};for(size_t i=0;i<out.size();i++)out[i]=static_cast<unsigned char>((nibble(s[i*2])<<4)|nibble(s[i*2+1]));return out;
 }
 explicit OriginPolicyBytes(const json& p):policy(p){
  if(!keys(p,{"version","ownerSidHex","groupSidHex","daclHex","security","creation","modified","lastAccess","attributes","streams","audit"})||p.at("version")!=1||p.at("streams")!="unnamed-only"||p.at("audit")!="not-certified")throw std::runtime_error("original policy archive shape");
  owner=decode(p.at("ownerSidHex"),68);group=decode(p.at("groupSidHex"),68);
  for(auto* sid:{&owner,&group})if(sid->size()<8||sid->at(0)!=SID_REVISION||sid->at(1)>15||sid->size()!=8+4*sid->at(1)||!IsValidSid(sid->data())||GetLengthSid(sid->data())!=sid->size())throw std::runtime_error("original SID invalid");
  const auto s=p.at("security");if(!keys(s,{"ownerSha256","groupSha256","daclSha256","present","protected"})||!s.at("present").is_boolean()||!s.at("protected").is_boolean()||!digest(s.at("ownerSha256"))||!digest(s.at("groupSha256"))||bytesHash(owner.data(),DWORD(owner.size()))!=s.at("ownerSha256")||bytesHash(group.data(),DWORD(group.size()))!=s.at("groupSha256"))throw std::runtime_error("original SID archive digest");
  if(!p.at("daclHex").is_null()){
   dacl=decode(p.at("daclHex"),16384);if(dacl.size()<sizeof(ACL)||!s.at("present").get<bool>()||!digest(s.at("daclSha256")))throw std::runtime_error("original DACL archive bounds");auto acl=reinterpret_cast<PACL>(dacl.data());size_t at=sizeof(ACL);if(acl->AclSize!=dacl.size()||(acl->AclRevision!=ACL_REVISION&&acl->AclRevision!=ACL_REVISION_DS))throw std::runtime_error("original ACL header");for(unsigned i=0;i<acl->AceCount;i++){if(at+sizeof(ACE_HEADER)>dacl.size())throw std::runtime_error("original ACE header bounds");auto ace=reinterpret_cast<ACE_HEADER*>(dacl.data()+at);if(ace->AceSize<sizeof(ACE_HEADER)||ace->AceSize%4||ace->AceSize>dacl.size()-at)throw std::runtime_error("original ACE bounds");at+=ace->AceSize;}if(!IsValidAcl(acl)||bytesHash(dacl.data(),DWORD(dacl.size()))!=s.at("daclSha256"))throw std::runtime_error("original DACL archive invalid");
  }else if(!s.at("daclSha256").is_null())throw std::runtime_error("original null DACL digest");
  // Missing DACL cannot be represented by SetSecurityInfo(nullptr), which grants
  // full access. Keep history readable but reject execution of that policy.
  if(!s.at("present").get<bool>())throw std::runtime_error("absent original DACL is not eligible for this restoration adapter");
 }
 void verify(HANDLE handle)const {Security actual(handle);if(securityEvidence(actual)!=policy.at("security"))throw std::runtime_error("original owner/group/DACL policy differs");}
 void apply(HANDLE handle)const {
  Security actual(handle);if(!EqualSid(actual.owner,const_cast<unsigned char*>(owner.data()))||!EqualSid(actual.group,const_cast<unsigned char*>(group.data())))throw std::runtime_error("original owner/group requires unavailable privileged mutation");
  const auto flags=DACL_SECURITY_INFORMATION|(policy.at("security").at("protected").get<bool>()?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION);
  if(SetSecurityInfo(handle,SE_FILE_OBJECT,flags,nullptr,nullptr,dacl.empty()?nullptr:reinterpret_cast<PACL>(const_cast<unsigned char*>(dacl.data())),nullptr)!=ERROR_SUCCESS)throw std::runtime_error("original DACL restore failed");verify(handle);
 }
};
