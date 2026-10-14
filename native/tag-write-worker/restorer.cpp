#include "tag-file-transaction.hpp"
#include "tag-restore-certification.hpp"
#include <limits>

static json missing(const std::string& role){return {{"role",role},{"state","missing"},{"identity",nullptr},{"sha256",nullptr},{"flac",nullptr},{"reason","recovery-path-absent"}};}
static bool sameObject(const json& a,const json& b){return a.at("volume")==b.at("volume")&&a.at("fileId")==b.at("fileId")&&a.at("bytes")==b.at("bytes");}
static bool sameFile(const json& a,const json& b){return a.at("state")=="present"&&a.at("reason")==""&&!a.at("flac").is_null()&&a.at("flac")==b.at("flac")&&sameObject(a.at("identity"),b.at("identity"));}
static bool sameDirectory(const json& a,const json& b){return a.at("volume")==b.at("volume")&&a.at("fileId")==b.at("fileId")&&a.at("creation")==b.at("creation");}
static std::wstring sibling(const std::wstring& parent,const std::wstring& leaf){return parent+(parent.back()==L'\\'?L"":L"\\")+leaf;}
static uint64_t fileTime(const json& value){
 if(!value.is_string())throw std::runtime_error("restore time is not decimal");const auto text=value.get<std::string>();
 if(text.empty()||text.size()>19||(text.size()>1&&text.front()=='0')||!std::all_of(text.begin(),text.end(),[](char c){return c>='0'&&c<='9';}))throw std::runtime_error("restore time bounds");
 const auto number=std::stoull(text);if(number>uint64_t(std::numeric_limits<LONGLONG>::max()))throw std::runtime_error("restore signed time bounds");return number;
}
static void absent(const std::wstring& name){
 Handle check;check.value=CreateFileW(extended(name).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
 if(check.value!=INVALID_HANDLE_VALUE||GetLastError()!=ERROR_FILE_NOT_FOUND)throw std::runtime_error("restore path is present or absence cannot be established");
}
static void transfer(Artifact& from,Artifact& to,HANDLE directory){
 const auto old=from.name;renameAbsent(from,directory,to.name);std::swap(from.handle.value,to.handle.value);from.name=old;from.result=missing(from.role);hashArtifact(to);absent(from.name);
}
static json sourcePolicy(Artifact& source,const json& baseline,const std::string& mode,const json& origin){
 if(!origin.is_null()){
  OriginPolicyBytes archive(origin);for(const char* k:{"creation","modified","lastAccess"})fileTime(origin.at(k));
  if(!origin.at("attributes").is_number_unsigned()||origin.at("attributes").get<uint64_t>()>MAXDWORD||origin.at("attributes").get<DWORD>()&~(FILE_ATTRIBUTE_NORMAL|FILE_ATTRIBUTE_ARCHIVE|FILE_ATTRIBUTE_HIDDEN|FILE_ATTRIBUTE_SYSTEM|FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)||origin.at("creation")!=baseline.at("identity").at("creation")||origin.at("modified")!=baseline.at("identity").at("modified"))throw std::runtime_error("archived original basic policy invalid");
  if(mode=="victim"){archive.verify(source.handle.value);FILE_BASIC_INFO basic{};if(!GetFileInformationByHandleEx(source.handle.value,FileBasicInfo,&basic,sizeof(basic))||std::to_string(ticks(basic.CreationTime))!=origin.at("creation")||std::to_string(ticks(basic.LastWriteTime))!=origin.at("modified")||basic.FileAttributes!=origin.at("attributes"))throw std::runtime_error("archived victim policy differs");}
  return {{"source",mode},{"creation",origin.at("creation")},{"modified",origin.at("modified")},{"lastAccess",origin.at("lastAccess")},{"attributes",origin.at("attributes")},{"security",origin.at("security")},{"origin",origin},{"permissions","original-source-dacl"},{"streams","unnamed-only"},{"audit","not-certified"}};
 }
 Security security(source.handle.value);FILE_BASIC_INFO basic{};if(!GetFileInformationByHandleEx(source.handle.value,FileBasicInfo,&basic,sizeof(basic)))throw std::runtime_error("restore source policy unavailable");
 if(mode=="victim"&&(std::to_string(ticks(basic.CreationTime))!=baseline.at("identity").at("creation")||std::to_string(ticks(basic.LastWriteTime))!=baseline.at("identity").at("modified")))throw std::runtime_error("victim source timestamps changed");
 fileTime(baseline.at("identity").at("creation"));fileTime(baseline.at("identity").at("modified"));
 return {{"source",mode},{"creation",baseline.at("identity").at("creation")},{"modified",baseline.at("identity").at("modified")},{"lastAccess",std::to_string(ticks(basic.LastAccessTime))},{"attributes",basic.FileAttributes},{"security",securityEvidence(security)},{"permissions","restoration-source-dacl"},{"streams","unnamed-only"},{"audit","not-certified"}};
}
static void cloneBackup(Artifact& source,Artifact& replacement,const json& baseline,const json& policy,const std::wstring& directory){
 ULARGE_INTEGER available{};const auto bytes=std::stoull(source.result.at("identity").at("bytes").get<std::string>());
 if(!GetDiskFreeSpaceExW(extended(directory).c_str(),&available,nullptr,nullptr)||available.QuadPart<bytes+16ULL*1024*1024)throw std::runtime_error("restore copy free space unavailable");
 // CREATE_NEW and share0: never use a prior partial copy or replace a name.
 replacement.handle.value=CreateFileW(extended(replacement.name).c_str(),GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL|WRITE_DAC,0,nullptr,CREATE_NEW,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
 if(replacement.handle.value==INVALID_HANDLE_VALUE||finalPath(replacement.handle.value)!=replacement.name)throw std::runtime_error("exclusive restore copy creation failed");
 identity(replacement.handle.value,false);
 if(policy.contains("origin")){OriginPolicyBytes archive(policy.at("origin"));archive.apply(replacement.handle.value);}
 seek(source.handle.value,0);std::vector<unsigned char> buffer(4*1024*1024);uint64_t at=0;ULONGLONG last=GetTickCount64();
 while(at<bytes){const DWORD n=DWORD(std::min<uint64_t>(buffer.size(),bytes-at));exact(source.handle.value,buffer.data(),n);DWORD written=0;while(written<n){DWORD got=0;if(!WriteFile(replacement.handle.value,buffer.data()+written,n-written,&got,nullptr)||!got)throw std::runtime_error("restore copy write failed");written+=got;}at+=n;
  const auto now=GetTickCount64();if(now-last>=250||at==bytes){last=now;send({{"kind","progress"},{"role","replacement"},{"bytes",std::to_string(at)},{"total",std::to_string(bytes)}});}
 }
 if(!policy.contains("origin")){Security old(source.handle.value),next(replacement.handle.value);if(!EqualSid(old.owner,next.owner)||!EqualSid(old.group,next.group))throw std::runtime_error("restore owner/group requires unavailable privileged policy");
 const auto protectedAcl=policy.at("security").at("protected").get<bool>();
 if(SetSecurityInfo(replacement.handle.value,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|(protectedAcl?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION),nullptr,nullptr,old.dacl,nullptr)!=ERROR_SUCCESS)throw std::runtime_error("restore source DACL copy failed");
 Security after(replacement.handle.value);if(securityEvidence(after)!=policy.at("security"))throw std::runtime_error("restore source DACL differs");}
 else {OriginPolicyBytes archive(policy.at("origin"));archive.verify(replacement.handle.value);}
 FILE_BASIC_INFO basic{};basic.CreationTime.QuadPart=LONGLONG(fileTime(policy.at("creation")));basic.LastWriteTime.QuadPart=LONGLONG(fileTime(policy.at("modified")));basic.LastAccessTime.QuadPart=LONGLONG(fileTime(policy.at("lastAccess")));basic.FileAttributes=policy.at("attributes").get<DWORD>();
 if(!SetFileInformationByHandle(replacement.handle.value,FileBasicInfo,&basic,sizeof(basic))||!FlushFileBuffers(replacement.handle.value))throw std::runtime_error("restore copy policy or flush failed");
 noStreams(replacement.handle.value);hashArtifact(replacement);if(replacement.result.at("flac")!=baseline.at("flac"))throw std::runtime_error("restore copied content differs from source baseline");
}
static void restore(const json& r){
 const bool v2=r.at("version")==2;auto shape=r;if(v2)shape.erase("origin");
 if(!keys(shape,{"version","kind","operationId","commitOperationId","jobId","leaseId","leaseRevision","certificateId","mode","sourceRoot","backupRoot","files","expected","baseline","victimArtifactId","replacementArtifactId","displacedArtifactId","commitJournalSha256","stagingJournalSha256"})||(r.at("version")!=1&&!v2)||(v2&&!r.contains("origin"))||r.at("kind")!="restore"||!r.at("leaseRevision").is_number_unsigned()||r.at("leaseRevision").get<uint64_t>()<1||r.at("leaseRevision").get<uint64_t>()>9007199254740991ULL)throw std::runtime_error("restore frozen identity invalid");
 for(const char* key:{"operationId","commitOperationId","jobId","leaseId","victimArtifactId","replacementArtifactId","displacedArtifactId"})if(!uuid(r.at(key).get<std::string>()))throw std::runtime_error("restore UUID invalid");
 const auto mode=r.at("mode").get<std::string>();if((mode!="victim"&&mode!="backup")||!tag_restore_certification::permits(r.at("certificateId").get<std::string>(),mode,protocolVersion)||!digest(r.at("commitJournalSha256"))||!digest(r.at("stagingJournalSha256"))||r.at("operationId")==r.at("commitOperationId")||r.at("victimArtifactId")==r.at("replacementArtifactId")||r.at("victimArtifactId")==r.at("displacedArtifactId")||r.at("replacementArtifactId")==r.at("displacedArtifactId"))throw std::runtime_error("uncertified restoration or log binding invalid");
 const auto expected=r.at("expected"),baseline=r.at("baseline"),paths=r.at("files");
 if(!keys(expected,{"files","roots","parent","exclusiveRead"})||expected.at("exclusiveRead")!=true||!expected.at("files").is_array()||expected.at("files").size()!=4||!expected.at("roots").is_array()||expected.at("roots").size()!=2||!keys(baseline,{"files","roots","exclusiveRead"})||baseline.at("exclusiveRead")!=true||!baseline.at("files").is_array()||baseline.at("files").size()!=3||!baseline.at("roots").is_array()||baseline.at("roots").size()!=2||!paths.is_array()||paths.size()!=4)throw std::runtime_error("restore snapshot shape invalid");
 const auto sourceRoot=normal(wide(r.at("sourceRoot").get<std::string>())),backupRoot=normal(wide(r.at("backupRoot").get<std::string>()));DirectoryPins pins;HANDLE sourcePin=pins.pin(sourceRoot),backupPin=pins.pin(backupRoot);const json roots={identity(sourcePin,true),identity(backupPin,true)};
 for(size_t i=0;i<2;i++)if(!sameDirectory(roots.at(i),expected.at("roots").at(i))||!sameDirectory(roots.at(i),baseline.at("roots").at(i)))throw std::runtime_error("restore root physical identity changed");
 std::array<Artifact,6> files;const std::array<const char*,6> roles={"original","backup","temporary","victim","replacement","displaced"};
 for(size_t i=0;i<4;i++){const auto p=paths.at(i);if(!keys(p,{"role","path"})||p.at("role")!=roles[i]||expected.at("files").at(i).at("role")!=roles[i])throw std::runtime_error("restore role order");files[i].role=roles[i];files[i].name=normal(wide(p.at("path").get<std::string>()));leafOf(files[i].name);if(!inside(i==1?backupRoot:sourceRoot,files[i].name))throw std::runtime_error("restore artifact escaped fixed roots");}
 const auto directory=parentOf(files[0].name);const auto job=r.at("jobId").get<std::string>();const auto prefix=L".aural-"+wide(job)+L"-";const auto temporaryLeaf=leafOf(files[2].name),backupLeaf=leafOf(files[1].name);
 if(parentOf(files[2].name)!=directory||parentOf(files[3].name)!=directory||parentOf(files[1].name)!=backupRoot||files[3].name!=sibling(directory,prefix+wide(r.at("victimArtifactId").get<std::string>())+L".victim")||temporaryLeaf.size()!=prefix.size()+40||temporaryLeaf.substr(0,prefix.size())!=prefix||temporaryLeaf.substr(temporaryLeaf.size()-4)!=L".tmp"||!uuid(std::string(temporaryLeaf.begin()+prefix.size(),temporaryLeaf.end()-4))||backupLeaf.size()!=job.size()+41||backupLeaf.substr(0,job.size()+1)!=wide(job)+L"-"||backupLeaf.substr(backupLeaf.size()-4)!=L".bak"||!uuid(std::string(backupLeaf.begin()+job.size()+1,backupLeaf.end()-4))||files[0].name.size()<5||files[0].name.substr(files[0].name.size()-5)!=L".flac")throw std::runtime_error("restore artifact fixed naming mismatch");
 files[4].role=roles[4];files[4].name=sibling(directory,prefix+wide(r.at("replacementArtifactId").get<std::string>())+L".restore");files[5].role=roles[5];files[5].name=sibling(directory,prefix+wide(r.at("displacedArtifactId").get<std::string>())+L".displaced");
 for(size_t i=0;i<files.size();i++)for(size_t j=0;j<i;j++)if(files[i].name==files[j].name)throw std::runtime_error("restore aliased artifact paths");
 HANDLE parentPin=pins.pin(directory,true);const auto parentIdentity=identity(parentPin,true);if(!sameDirectory(parentIdentity,expected.at("parent")))throw std::runtime_error("restore parent identity changed");
 for(size_t i=0;i<files.size();i++){
  if(i>=4||expected.at("files").at(i).at("state")=="missing"){absent(files[i].name);files[i].result=i<4?expected.at("files").at(i):missing(files[i].role);}
  else {if(expected.at("files").at(i).at("state")!="present")throw std::runtime_error("restore busy or unreadable artifact");openArtifact(files[i],i==0||i==3&&mode=="victim");hashArtifact(files[i]);if(files[i].result!=expected.at("files").at(i))throw std::runtime_error("restore evidence changed after inspection");}
 }
 const auto frozenSource=baseline.at("files").at(0),frozenBackup=baseline.at("files").at(1),frozenTarget=baseline.at("files").at(2);
 if(frozenSource.at("flac").is_null()||frozenSource.at("flac")!=frozenBackup.at("flac")||frozenSource.at("sha256")==frozenTarget.at("sha256")||frozenSource.at("flac").at("audioSha256")!=frozenTarget.at("flac").at("audioSha256")||frozenSource.at("flac").at("audioBytes")!=frozenTarget.at("flac").at("audioBytes")||!sameFile(files[1].result,frozenBackup)||files[0].result.at("state")=="present"&&!sameFile(files[0].result,frozenTarget)||files[2].result.at("state")=="present"&&!sameFile(files[2].result,frozenTarget)||files[3].result.at("state")=="present"&&!sameFile(files[3].result,frozenSource)||files[0].result.at("state")=="present"&&files[2].result.at("state")=="present"||mode=="victim"&&!sameFile(files[3].result,frozenSource))throw std::runtime_error("restore contains unknown content or physical source");
 auto proof=[&](const json& policy){return json{{"files",{files[0].result,files[1].result,files[2].result,files[3].result,files[4].result,files[5].result}},{"roots",roots},{"parent",identity(parentPin,true)},{"policy",policy},{"leaseId",r.at("leaseId")},{"leaseRevision",r.at("leaseRevision")},{"certificateId",r.at("certificateId")},{"mode",mode},{"commitOperationId",r.at("commitOperationId")},{"victimArtifactId",r.at("victimArtifactId")},{"replacementArtifactId",r.at("replacementArtifactId")},{"displacedArtifactId",r.at("displacedArtifactId")},{"commitJournalSha256",r.at("commitJournalSha256")},{"stagingJournalSha256",r.at("stagingJournalSha256")}};};
 auto stable=[&]{if(finalPath(sourcePin)!=sourceRoot||finalPath(backupPin)!=backupRoot||finalPath(parentPin)!=directory||!sameDirectory(identity(parentPin,true),parentIdentity))throw std::runtime_error("restore pinned directory changed");for(auto& file:files){if(file.result.at("state")=="missing")absent(file.name);else if(identity(file.handle.value,false)!=file.result.at("identity")||finalPath(file.handle.value)!=file.name)throw std::runtime_error("restore artifact changed while held");}};
 stable();receipt("locked",proof(nullptr));auto& policySource=files[mode=="victim"?3:1];const json policy=sourcePolicy(policySource,frozenSource,mode,v2?r.at("origin"):json(nullptr));
 if(mode=="backup")cloneBackup(files[1],files[4],frozenSource,policy,directory);
 stable();receipt("prepared",proof(policy));
 auto policyStable=[&](Artifact& destination){Security source(policySource.handle.value),target(destination.handle.value);FILE_BASIC_INFO basic{};if((!v2&&securityEvidence(source)!=policy.at("security"))||securityEvidence(target)!=policy.at("security")||!GetFileInformationByHandleEx(destination.handle.value,FileBasicInfo,&basic,sizeof(basic))||std::to_string(ticks(basic.CreationTime))!=policy.at("creation")||std::to_string(ticks(basic.LastWriteTime))!=policy.at("modified")||basic.FileAttributes!=policy.at("attributes"))throw std::runtime_error("restore source permission or timestamp policy changed");};
 Artifact& prepared=files[mode=="victim"?3:4];stable();policyStable(prepared);receipt("intent",proof(policy));stable();policyStable(prepared);
 // Both moves are non-overwriting. Persisted phases expose the missing-path
 // crash gap and retained targets; no rollback, delete, or implicit retry.
 if(files[0].result.at("state")=="present")transfer(files[0],files[5],parentPin);else absent(files[0].name);
 stable();receipt("displaced",proof(policy));stable();policyStable(prepared);transfer(prepared,files[0],parentPin);
 // For victim mode the chosen source handle moved to the destination slot.
 if(mode=="victim")policySource.result=missing(policySource.role);
 stable();receipt("restored",proof(policy));for(auto& file:files)if(file.result.at("state")=="present")hashArtifact(file);stable();
 auto finalPolicy=[&]{Security destination(files[0].handle.value);FILE_BASIC_INFO finalBasic{};
  if(files[0].result.at("flac")!=frozenSource.at("flac")||securityEvidence(destination)!=policy.at("security")||!GetFileInformationByHandleEx(files[0].handle.value,FileBasicInfo,&finalBasic,sizeof(finalBasic))||std::to_string(ticks(finalBasic.CreationTime))!=policy.at("creation")||std::to_string(ticks(finalBasic.LastWriteTime))!=policy.at("modified")||finalBasic.FileAttributes!=policy.at("attributes"))throw std::runtime_error("restored final bytes or policy differs");
 };
 finalPolicy();receipt("verified",proof(policy));stable();finalPolicy();send({{"kind","done"},{"proof",proof(policy)}});
}
int wmain(int argc,wchar_t** argv){return runTagNativeTransaction(argc,argv,restore);}
