#pragma once
#include "tag-file-io.hpp"
#include <aclapi.h>
#include <condition_variable>
#include <mutex>
#include <cstddef>

// Fixed one-process transport and file helpers shared by commit and restoration.
static std::string operationId;
static uint32_t sequence=0;
static uint32_t protocolVersion=1;
static std::atomic<bool> finished{false};
static std::atomic<uint32_t> expectedAck{0};
static std::atomic<ULONGLONG> ackDeadline{0};
static HANDLE cancelEvent=nullptr;
static std::mutex ackMutex;
static std::condition_variable ackReady;
static json queuedAck;

static bool keys(const json& r,std::initializer_list<const char*> names){if(!r.is_object()||r.size()!=names.size())return false;for(const char* n:names)if(!r.contains(n))return false;return true;}
static bool digest(const json& v){if(!v.is_string())return false;auto s=v.get<std::string>();return s.size()==64&&std::all_of(s.begin(),s.end(),[](char c){return c>='0'&&c<='9'||c>='a'&&c<='f';});}
static void send(json body){body["version"]=protocolVersion;body["operationId"]=operationId;body["sequence"]=++sequence;auto s=body.dump();if(s.size()>65536)throw std::runtime_error("commit response budget");uint32_t n=uint32_t(s.size());char head[4]={char(n),char(n>>8),char(n>>16),char(n>>24)};std::cout.write(head,4).write(s.data(),s.size()).flush();if(!std::cout.good())throw std::runtime_error("commit output closed");}
static json frame(DWORD bound){unsigned char head[4];exact(GetStdHandle(STD_INPUT_HANDLE),head,4);uint32_t n=uint32_t(head[0])|(uint32_t(head[1])<<8)|(uint32_t(head[2])<<16)|(uint32_t(head[3])<<24);if(!n||n>bound)throw std::runtime_error("commit input budget");std::string s(n,0);exact(GetStdHandle(STD_INPUT_HANDLE),reinterpret_cast<unsigned char*>(s.data()),n);return json::parse(s);}
static void receipt(const char* phase,const json& proof){
 expectedAck.store(sequence+1);ackDeadline.store(GetTickCount64()+30000);send({{"kind","stage"},{"phase",phase},{"proof",proof}});
 std::unique_lock<std::mutex> guard(ackMutex);if(!ackReady.wait_for(guard,std::chrono::seconds(30),[]{return !queuedAck.is_null();}))throw std::runtime_error("durable receipt acknowledgement timeout");
 if(queuedAck.at("sequence")!=expectedAck.load())throw std::runtime_error("commit acknowledgement changed");queuedAck=nullptr;expectedAck.store(0);ackDeadline.store(0);
}
static void receiveAcks(){try{while(!finished.load()){
 auto a=frame(4096);std::lock_guard<std::mutex> guard(ackMutex);const auto expected=expectedAck.load();
 if(!expected||!keys(a,{"version","kind","operationId","sequence","receiptSha256"})||a.at("version")!=protocolVersion||a.at("kind")!="ack"||a.at("operationId")!=operationId||a.at("sequence")!=expected||!digest(a.at("receiptSha256"))||!queuedAck.is_null())throw std::runtime_error("commit acknowledgement identity");
 queuedAck=a;ackReady.notify_one();
 }}catch(...){if(!finished.load())SetEvent(cancelEvent);}}
static std::wstring parentOf(const std::wstring& name){auto i=name.find_last_of(L'\\');if(i==std::wstring::npos||i<2)throw std::runtime_error("commit parent path");return i==2?name.substr(0,3):name.substr(0,i);}
static std::wstring leafOf(const std::wstring& name){auto i=name.find_last_of(L'\\');auto leaf=name.substr(i+1);if(leaf.empty()||leaf.size()>255||leaf==L"."||leaf==L".."||leaf.back()==L'.'||leaf.back()==L' '||leaf.find_first_of(L":/\\")!=std::wstring::npos)throw std::runtime_error("unsafe commit leaf");return leaf;}
static void localNtfs(HANDLE handle,const std::wstring& name){
 wchar_t volumePath[32768],filesystem[64];DWORD flags=0;
 if(name.size()<3||name[1]!=L':'||name[2]!=L'\\'||!GetVolumePathNameW(extended(name).c_str(),volumePath,32768)||GetDriveTypeW(volumePath)!=DRIVE_FIXED||!GetVolumeInformationByHandleW(handle,nullptr,0,nullptr,nullptr,&flags,filesystem,64)||_wcsicmp(filesystem,L"NTFS")!=0||flags&FILE_READ_ONLY_VOLUME)throw std::runtime_error("only certified local writable NTFS is eligible");
}
struct DirectoryPins {
 std::vector<std::unique_ptr<Handle>> handles;
 HANDLE pin(const std::wstring& name,bool writable=false,bool directoryMove=false){
  if(name.size()<3||name[1]!=L':'||name[2]!=L'\\')throw std::runtime_error("remote root unsupported");HANDLE result=INVALID_HANDLE_VALUE;
  size_t end=3;while(true){std::wstring part=name.substr(0,end);auto h=std::make_unique<Handle>();DWORD access=FILE_READ_ATTRIBUTES;if(writable&&end==name.size())access|=(directoryMove?FILE_ADD_SUBDIRECTORY:FILE_ADD_FILE)|FILE_TRAVERSE;h->value=CreateFileW(extended(part).c_str(),access,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
   if(h->value==INVALID_HANDLE_VALUE||finalPath(h->value)!=part)throw std::runtime_error("commit directory identity unavailable");identity(h->value,true);result=h->value;handles.push_back(std::move(h));if(end==name.size())break;
   auto next=name.find(L'\\',end==3?3:end+1);end=next==std::wstring::npos?name.size():next;if(end<3)throw std::runtime_error("commit directory layout");
  }localNtfs(result,name);return result;
 }
};
static void noStreams(HANDLE handle){
 std::vector<unsigned char> storage(65536);if(!GetFileInformationByHandleEx(handle,FileStreamInfo,storage.data(),DWORD(storage.size())))throw std::runtime_error("alternate streams cannot be confirmed");size_t at=0;
 for(unsigned i=0;i<1024;i++){if(at+offsetof(FILE_STREAM_INFO,StreamName)>storage.size())throw std::runtime_error("stream information bounds");auto* r=reinterpret_cast<FILE_STREAM_INFO*>(storage.data()+at);
  if(r->StreamNameLength%2||r->StreamNameLength>storage.size()-at-offsetof(FILE_STREAM_INFO,StreamName))throw std::runtime_error("stream name bounds");
  if(std::wstring(r->StreamName,r->StreamNameLength/sizeof(wchar_t))!=L"::$DATA")throw std::runtime_error("alternate streams require a different preservation adapter");if(!r->NextEntryOffset)return;
  if(r->NextEntryOffset<offsetof(FILE_STREAM_INFO,StreamName)+r->StreamNameLength||r->NextEntryOffset>storage.size()-at)throw std::runtime_error("stream chain bounds");at+=r->NextEntryOffset;
 }throw std::runtime_error("stream count budget");
}
struct Artifact {std::string role;std::wstring name;Handle handle;json result;};
static void openArtifact(Artifact& a,bool writable){
 DWORD access=GENERIC_READ|READ_CONTROL;if(writable)access|=GENERIC_WRITE|DELETE|WRITE_DAC;
 a.handle.value=CreateFileW(extended(a.name).c_str(),access,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
 if(a.handle.value==INVALID_HANDLE_VALUE||finalPath(a.handle.value)!=a.name)throw std::runtime_error("commit artifact unavailable or redirected");
 auto id=identity(a.handle.value,false);if(std::stoull(id.at("bytes").get<std::string>())>68719476736ULL)throw std::runtime_error("commit file size budget");
 FILE_BASIC_INFO basic{};if(!GetFileInformationByHandleEx(a.handle.value,FileBasicInfo,&basic,sizeof(basic))||basic.FileAttributes&~(FILE_ATTRIBUTE_NORMAL|FILE_ATTRIBUTE_ARCHIVE|FILE_ATTRIBUTE_HIDDEN|FILE_ATTRIBUTE_SYSTEM|FILE_ATTRIBUTE_NOT_CONTENT_INDEXED))throw std::runtime_error("unsupported file attribute preservation");noStreams(a.handle.value);
}
static void hashArtifact(Artifact& a){
 auto before=identity(a.handle.value,false);uint64_t bytes=std::stoull(before.at("bytes").get<std::string>()),offset=audioOffset(a.handle.value,bytes),at=0;seek(a.handle.value,0);Hash full,metadata,audio;std::vector<unsigned char> b(4*1024*1024);ULONGLONG last=GetTickCount64();
 while(at<bytes){DWORD n=DWORD(std::min<uint64_t>(b.size(),bytes-at));exact(a.handle.value,b.data(),n);full.add(b.data(),n);DWORD prefix=DWORD(std::min<uint64_t>(n,at<offset?offset-at:0));metadata.add(b.data(),prefix);audio.add(b.data()+prefix,n-prefix);at+=n;auto now=GetTickCount64();if(now-last>=250||at==bytes){last=now;send({{"kind","progress"},{"role",a.role},{"bytes",std::to_string(at)},{"total",std::to_string(bytes)}});}}
 if(identity(a.handle.value,false)!=before||finalPath(a.handle.value)!=a.name)throw std::runtime_error("commit artifact identity changed");auto sha=full.finish();
 a.result={{"role",a.role},{"state","present"},{"identity",before},{"sha256",sha},{"flac",{{"sha256",sha},{"audioSha256",audio.finish()},{"metadataSha256",metadata.finish()},{"byteLength",std::to_string(bytes)},{"audioOffset",std::to_string(offset)},{"audioBytes",std::to_string(bytes-offset)}}},{"reason",""}};
}
struct Security {PSID owner=nullptr,group=nullptr;PACL dacl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;~Security(){if(descriptor)LocalFree(descriptor);}Security(HANDLE h){if(GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,&group,&dacl,nullptr,&descriptor)!=ERROR_SUCCESS||!IsValidSid(owner)||!IsValidSid(group)||dacl&&!IsValidAcl(dacl))throw std::runtime_error("file security unavailable");}Security(const Security&)=delete;};
static std::string bytesHash(const void* p,DWORD n){Hash hash;hash.add(static_cast<const unsigned char*>(p),n);return hash.finish();}
static json securityEvidence(const Security& s){SECURITY_DESCRIPTOR_CONTROL control{};DWORD revision=0;BOOL present=FALSE,defaulted=FALSE;PACL acl=nullptr;if(!GetSecurityDescriptorControl(s.descriptor,&control,&revision)||!GetSecurityDescriptorDacl(s.descriptor,&present,&acl,&defaulted))throw std::runtime_error("security control unavailable");return {{"ownerSha256",bytesHash(s.owner,GetLengthSid(s.owner))},{"groupSha256",bytesHash(s.group,GetLengthSid(s.group))},{"daclSha256",s.dacl?json(bytesHash(s.dacl,s.dacl->AclSize)):json(nullptr)},{"present",bool(present)},{"protected",bool(control&SE_DACL_PROTECTED)}};}
#include "tag-origin-policy.hpp"
static json preparePolicy(Artifact& original,Artifact& temporary){
 const json origin=captureOriginPolicy(original.handle.value);OriginPolicyBytes archive(origin);
 Security source(original.handle.value),target(temporary.handle.value);if(!EqualSid(source.owner,target.owner)||!EqualSid(source.group,target.group))throw std::runtime_error("owner/group cannot be preserved without privileged mutation");auto security=securityEvidence(source);
 SECURITY_INFORMATION flags=DACL_SECURITY_INFORMATION|(security.at("protected").get<bool>()?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION);
 if(SetSecurityInfo(temporary.handle.value,SE_FILE_OBJECT,flags,nullptr,nullptr,source.dacl,nullptr)!=ERROR_SUCCESS)throw std::runtime_error("DACL preservation failed");Security after(temporary.handle.value);if(securityEvidence(after)!=security)throw std::runtime_error("DACL preservation differs");
 FILE_BASIC_INFO old{},next{};if(!GetFileInformationByHandleEx(original.handle.value,FileBasicInfo,&old,sizeof(old))||!GetFileInformationByHandleEx(temporary.handle.value,FileBasicInfo,&next,sizeof(next)))throw std::runtime_error("file attributes unavailable");next.CreationTime=old.CreationTime;next.LastAccessTime=old.LastAccessTime;next.ChangeTime.QuadPart=0;next.FileAttributes=old.FileAttributes;
 if(!SetFileInformationByHandle(temporary.handle.value,FileBasicInfo,&next,sizeof(next))||!FlushFileBuffers(temporary.handle.value))throw std::runtime_error("temporary policy flush failed");
 return {{"origin",origin},{"creation",std::to_string(ticks(old.CreationTime))},{"lastAccess",std::to_string(ticks(old.LastAccessTime))},{"attributes",old.FileAttributes},{"security",security},{"streams","unnamed-only"},{"lastWrite","staged-file-time"},{"audit","not-certified"}};
}
static void renameAbsent(Artifact& artifact,HANDLE directory,const std::wstring& target){
 const auto leaf=leafOf(target);const DWORD bytes=DWORD(leaf.size()*sizeof(wchar_t));std::vector<unsigned char> storage(offsetof(FILE_RENAME_INFO,FileName)+bytes+sizeof(wchar_t));auto* r=reinterpret_cast<FILE_RENAME_INFO*>(storage.data());r->ReplaceIfExists=FALSE;r->RootDirectory=directory;r->FileNameLength=bytes;std::memcpy(r->FileName,leaf.data(),bytes);
 if(!SetFileInformationByHandle(artifact.handle.value,FileRenameInfo,r,DWORD(storage.size())))throw std::runtime_error("exclusive handle rename failed: "+std::to_string(GetLastError()));artifact.name=target;
 if(finalPath(artifact.handle.value)!=target||!FlushFileBuffers(artifact.handle.value))throw std::runtime_error("renamed handle path or flush unconfirmed");
}
static int runTagNativeTransaction(int argc,wchar_t** argv,void (*transaction)(const json&)){
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);if(argc!=3)return 65;wchar_t* end=nullptr;DWORD pid=DWORD(std::wcstoul(argv[2],&end,10));if(!pid||!end||*end)return 65;
 Handle parent;parent.value=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!parent.value)return 68;wchar_t image[32768];DWORD length=32768;if(!QueryFullProcessImageNameW(parent.value,0,image,&length)||_wcsicmp(image,argv[1]))return 68;
 HANDLE job=CreateJobObjectW(nullptr,nullptr);JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_JOB_TIME|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY;limit.BasicLimitInformation.ActiveProcessLimit=1;limit.BasicLimitInformation.PerJobUserTimeLimit.QuadPart=6LL*60*60*10000000LL;limit.ProcessMemoryLimit=128ULL*1024*1024;limit.JobMemoryLimit=128ULL*1024*1024;if(!job||!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limit,sizeof(limit))||!AssignProcessToJobObject(job,GetCurrentProcess()))return 66;
 Handle cancel;cancel.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!cancel.value)return 66;cancelEvent=cancel.value;const ULONGLONG wall=GetTickCount64()+8ULL*60*60*1000;
 std::thread watcher([&]{HANDLE hs[]={parent.value,cancel.value};while(!finished.load()){auto status=WaitForMultipleObjects(2,hs,FALSE,100);auto deadline=ackDeadline.load();if(!finished.load()&&(status!=WAIT_TIMEOUT||GetTickCount64()>=wall||deadline&&GetTickCount64()>=deadline))TerminateProcess(GetCurrentProcess(),status==WAIT_TIMEOUT?70:68);}});
 std::thread input;int code=0;try{ackDeadline.store(GetTickCount64()+30000);auto r=frame(131072);ackDeadline.store(0);if(!r.contains("operationId")||!uuid(r.at("operationId").get<std::string>()))throw std::runtime_error("commit operation identity");operationId=r.at("operationId").get<std::string>();if(!r.contains("version")||(r.at("version")!=1&&r.at("version")!=2))throw std::runtime_error("transaction protocol version");protocolVersion=r.at("version").get<uint32_t>();input=std::thread(receiveAcks);transaction(r);}catch(const std::exception& e){code=71;if(!operationId.empty())try{send({{"kind","error"},{"message",e.what()}});}catch(...){}}
 finished.store(true);SetEvent(cancel.value);if(input.joinable()){while(WaitForSingleObject(input.native_handle(),20)==WAIT_TIMEOUT)CancelSynchronousIo(input.native_handle());input.join();}watcher.join();std::cout.flush();ExitProcess(code);
}
