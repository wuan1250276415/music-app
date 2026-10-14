#include "tag-file-io.hpp"
struct Artifact{std::string role;std::wstring name,root;Handle handle;json result;};
static std::atomic<bool> finished{false};
static std::string inspectionId;static uint32_t sequence=0,inspectionVersion=1;
static void send(json body){body["version"]=inspectionVersion;body["inspectionId"]=inspectionId;body["sequence"]=++sequence;auto s=body.dump();if(s.size()>65536)throw std::runtime_error("inspection response bound");uint32_t n=uint32_t(s.size());char header[4]={char(n),char(n>>8),char(n>>16),char(n>>24)};std::cout.write(header,4).write(s.data(),s.size()).flush();if(!std::cout.good())throw std::runtime_error("inspection output closed");}
static void openArtifact(Artifact& a){a.handle.value=CreateFileW(extended(a.name).c_str(),GENERIC_READ,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);if(a.handle.value==INVALID_HANDLE_VALUE){DWORD e=GetLastError();a.result={{"role",a.role},{"state",e==ERROR_FILE_NOT_FOUND||e==ERROR_PATH_NOT_FOUND?"missing":e==ERROR_SHARING_VIOLATION||e==ERROR_LOCK_VIOLATION?"busy":"unreadable"},{"identity",nullptr},{"sha256",nullptr},{"flac",nullptr},{"reason",std::to_string(e)}};return;}auto id=identity(a.handle.value,false);if(!inside(a.root,finalPath(a.handle.value))||(inspectionVersion>=2&&finalPath(a.handle.value)!=a.name))throw std::runtime_error("artifact escaped approved root");uint64_t size=std::stoull(id["bytes"].get<std::string>());if(size>68719476736ULL)throw std::runtime_error("artifact size budget");a.result={{"role",a.role},{"state","present"},{"identity",id},{"sha256",nullptr},{"flac",nullptr},{"reason",""}};}
static void hashArtifact(Artifact& a){if(a.handle.value==INVALID_HANDLE_VALUE)return;const json before=a.result["identity"];uint64_t bytes=std::stoull(before["bytes"].get<std::string>()),offset=0;try{offset=audioOffset(a.handle.value,bytes);}catch(const std::exception& e){a.result["reason"]=e.what();}seek(a.handle.value,0);Hash full,prefix,audio;std::vector<unsigned char> b(4*1024*1024);uint64_t at=0;ULONGLONG last=GetTickCount64();while(at<bytes){DWORD wanted=DWORD(std::min<uint64_t>(b.size(),bytes-at)),got=0;if(!ReadFile(a.handle.value,b.data(),wanted,&got,nullptr)||!got)throw std::runtime_error("artifact hash read incomplete");full.add(b.data(),got);if(offset){DWORD meta=DWORD(std::min<uint64_t>(got,at<offset?offset-at:0));prefix.add(b.data(),meta);audio.add(b.data()+meta,got-meta);}at+=got;auto now=GetTickCount64();if(now-last>=250||at==bytes){last=now;send({{"kind","progress"},{"role",a.role},{"bytes",std::to_string(at)},{"total",std::to_string(bytes)}});}}if(identity(a.handle.value,false)!=before||!inside(a.root,finalPath(a.handle.value))||(inspectionVersion>=2&&finalPath(a.handle.value)!=a.name))throw std::runtime_error("artifact changed during inspection");a.result["sha256"]=full.finish();if(offset)a.result["flac"]={{"sha256",a.result["sha256"]},{"audioSha256",audio.finish()},{"metadataSha256",prefix.finish()},{"byteLength",std::to_string(bytes)},{"audioOffset",std::to_string(offset)},{"audioBytes",std::to_string(bytes-offset)}};}

static json request(){
 unsigned char head[4];exact(GetStdHandle(STD_INPUT_HANDLE),head,4);
 uint32_t n=uint32_t(head[0])|(uint32_t(head[1])<<8)|(uint32_t(head[2])<<16)|(uint32_t(head[3])<<24);
 if(!n||n>131072)throw std::runtime_error("inspection request budget");
 std::string s(n,0);exact(GetStdHandle(STD_INPUT_HANDLE),reinterpret_cast<unsigned char*>(s.data()),n);
 json r=json::parse(s);
 if(!r.is_object()||r.size()!=6||!r.contains("sourceRoot")||!r.contains("backupRoot")||!r.contains("files")||!((r.at("version")==1&&r.at("kind")=="inspect")||(r.at("version")==2&&r.at("kind")=="inspect-commit")||(r.at("version")==3&&r.at("kind")=="inspect-restore"))||!uuid(r.at("inspectionId").get<std::string>()))throw std::runtime_error("inspection identity");
 inspectionId=r["inspectionId"].get<std::string>();inspectionVersion=r["version"].get<uint32_t>();return r;
}
static std::wstring artifactParent(const std::wstring& name){auto at=name.find_last_of(L'\\');if(at==std::wstring::npos||at<2)throw std::runtime_error("inspection parent");return at==2?name.substr(0,3):name.substr(0,at);}
struct InspectionPins{
 std::vector<std::unique_ptr<Handle>> handles;
 HANDLE pin(const std::wstring& name){
  if(name.size()<3||name[1]!=L':'||name[2]!=L'\\')throw std::runtime_error("commit recovery requires a local absolute path");size_t end=3;HANDLE result=INVALID_HANDLE_VALUE;
  while(true){auto part=name.substr(0,end);auto h=std::make_unique<Handle>();h->value=CreateFileW(extended(part).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
   if(h->value==INVALID_HANDLE_VALUE||finalPath(h->value)!=part)throw std::runtime_error("inspection ancestor unavailable or redirected");identity(h->value,true);result=h->value;handles.push_back(std::move(h));if(end==name.size())break;
   auto next=name.find(L'\\',end==3?3:end+1);end=next==std::wstring::npos?name.size():next;
  }return result;
 }
};
static void inspect(const json& r){
 auto paths=r.at("files");if(!paths.is_array()||paths.size()!=(inspectionVersion==3?6:inspectionVersion==2?4:3))throw std::runtime_error("inspection file roles");
 const std::wstring sourceRoot=normal(wide(r.at("sourceRoot").get<std::string>())),backupRoot=normal(wide(r.at("backupRoot").get<std::string>()));
 InspectionPins pins;Handle parent;json parentId;std::wstring parentName;
 if(inspectionVersion>=2){pins.pin(sourceRoot);pins.pin(backupRoot);parentName=artifactParent(normal(wide(paths.at(0).at("path").get<std::string>())));parent.value=CreateFileW(extended(parentName).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);pins.pin(parentName);if(parent.value==INVALID_HANDLE_VALUE||finalPath(parent.value)!=parentName||!inside(sourceRoot,parentName))throw std::runtime_error("inspection source parent unavailable");parentId=identity(parent.value,true);}
 std::array<Handle,2> roots;const std::array<std::wstring,2> names={sourceRoot,backupRoot};
 for(size_t i=0;i<2;i++){
  roots[i].value=CreateFileW(extended(names[i]).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(roots[i].value==INVALID_HANDLE_VALUE||finalPath(roots[i].value)!=names[i])throw std::runtime_error("approved root unavailable");identity(roots[i].value,true);
 }
 json rootIds={identity(roots[0].value,true),identity(roots[1].value,true)};std::vector<std::unique_ptr<Artifact>> files;
 for(size_t i=0;i<paths.size();i++){
  auto p=paths.at(i);if(!p.is_object()||p.size()!=2||p.at("role")!=std::array<const char*,6>{"original","backup","temporary","victim","replacement","displaced"}[i])throw std::runtime_error("inspection role order");
  auto file=std::make_unique<Artifact>();file->role=p.at("role").get<std::string>();file->name=normal(wide(p.at("path").get<std::string>()));file->root=i==1?backupRoot:sourceRoot;
  if(!inside(file->root,file->name)||(inspectionVersion>=2&&artifactParent(file->name)!=(i==1?backupRoot:parentName)))throw std::runtime_error("inspection path boundary");
  if(std::any_of(files.begin(),files.end(),[&](const auto& other){return other->name==file->name;}))throw std::runtime_error("duplicate inspection path");openArtifact(*file);files.push_back(std::move(file));
 }
 // All existing artifacts remain locked together until this scope ends.
 for(auto& file:files)hashArtifact(*file);
 for(size_t i=0;i<2;i++){
  auto after=identity(roots[i].value,true);
  if(after["fileId"]!=rootIds.at(i)["fileId"]||after["volume"]!=rootIds.at(i)["volume"]||finalPath(roots[i].value)!=names[i])throw std::runtime_error("root identity changed");
 }
 json results=json::array();for(auto& file:files){
  if(inspectionVersion>=2&&file->handle.value!=INVALID_HANDLE_VALUE&&(identity(file->handle.value,false)!=file->result["identity"]||finalPath(file->handle.value)!=file->name))throw std::runtime_error("held artifact changed before final snapshot");
  if(inspectionVersion>=2&&file->result["state"]=="missing"){
   Handle check;check.value=CreateFileW(extended(file->name).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);DWORD error=GetLastError();
   if(check.value!=INVALID_HANDLE_VALUE||(error!=ERROR_FILE_NOT_FOUND&&error!=ERROR_PATH_NOT_FOUND))throw std::runtime_error("missing artifact could not be reconfirmed");
  }results.push_back(file->result);
 }
 json done={{"kind","done"},{"files",results},{"roots",rootIds},{"exclusiveRead",true}};
 if(inspectionVersion>=2){auto after=identity(parent.value,true);if(after["volume"]!=parentId["volume"]||after["fileId"]!=parentId["fileId"]||after["creation"]!=parentId["creation"]||finalPath(parent.value)!=parentName)throw std::runtime_error("inspection parent changed");done["parent"]=parentId;}
 send(done);
}
int wmain(int argc,wchar_t** argv){
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
 if(argc!=3)return 65;wchar_t* end=nullptr;unsigned long parsed=std::wcstoul(argv[2],&end,10);DWORD pid=DWORD(parsed);
 if(!pid||!end||*end)return 65;
 Handle parent;parent.value=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!parent.value)return 68;
 wchar_t image[32768];DWORD imageLength=32768;
 if(!QueryFullProcessImageNameW(parent.value,0,image,&imageLength)||_wcsicmp(argv[1],image)!=0)return 68;
 HANDLE job=CreateJobObjectW(nullptr,nullptr);JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
 limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_JOB_TIME|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY;
 limit.BasicLimitInformation.ActiveProcessLimit=1;limit.BasicLimitInformation.PerJobUserTimeLimit.QuadPart=6LL*60*60*10000000LL;
 limit.ProcessMemoryLimit=128ULL*1024*1024;limit.JobMemoryLimit=128ULL*1024*1024;
 if(!job||!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limit,sizeof(limit))||!AssignProcessToJobObject(job,GetCurrentProcess()))return 66;
 Handle cancel;cancel.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!cancel.value)return 66;
 std::thread parentWatch([&]{HANDLE handles[]={parent.value,cancel.value};DWORD status=WaitForMultipleObjects(2,handles,FALSE,8UL*60*60*1000);if(!finished.load())TerminateProcess(GetCurrentProcess(),status==WAIT_TIMEOUT?70:68);});
 std::thread inputWatch;int code=0;
 try{
  auto r=request();
  // EOF is cancellation; no additional input is legal for this read-only task.
  inputWatch=std::thread([&]{if(finished.load())return;unsigned char extra=0;DWORD got=0;ReadFile(GetStdHandle(STD_INPUT_HANDLE),&extra,1,&got,nullptr);if(!finished.load())SetEvent(cancel.value);});
  inspect(r);
 }catch(const std::exception& e){code=71;if(!inspectionId.empty())try{send({{"kind","error"},{"message",e.what()}});}catch(...){}}
 finished.store(true);SetEvent(cancel.value);
 if(inputWatch.joinable()){while(WaitForSingleObject(inputWatch.native_handle(),20)==WAIT_TIMEOUT)CancelSynchronousIo(inputWatch.native_handle());inputWatch.join();}
 parentWatch.join();std::cout.flush();
 // The self-owned kill-on-close Job is retained until the process exits.
 ExitProcess(code);
}
