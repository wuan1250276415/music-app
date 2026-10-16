#include "tag-file-transaction.hpp"
#include <limits>

static void absent(const std::wstring& name){
 const DWORD attributes=GetFileAttributesW(extended(name).c_str());
 if(attributes!=INVALID_FILE_ATTRIBUTES)throw std::runtime_error("directory move destination already exists");
 const DWORD error=GetLastError();
 // Parent directories are already pinned. A missing parent or denied query is
 // not evidence that this particular directory entry is absent.
 if(error!=ERROR_FILE_NOT_FOUND)throw std::runtime_error("directory move absence cannot be confirmed: "+std::to_string(error));
}

// One handle-bound, non-overwriting directory rename per invocation. The Main
// restoration owner records each intent and proof durably before acknowledging.
static std::string nodeDirectoryIdentity(HANDLE h){
 identity(h,true);BY_HANDLE_FILE_INFORMATION i{};if(!GetFileInformationByHandle(h,&i))throw std::runtime_error("directory file-index identity unavailable");
 const uint64_t raw=(uint64_t(i.ftCreationTime.dwHighDateTime)<<32)|i.ftCreationTime.dwLowDateTime;
 if(raw>uint64_t(std::numeric_limits<int64_t>::max()))throw std::runtime_error("directory creation-time identity bounds");
 const int64_t delta=int64_t(raw)-116444736000000000LL;
 if(delta>std::numeric_limits<int64_t>::max()/100||delta<std::numeric_limits<int64_t>::min()/100)throw std::runtime_error("directory nanosecond creation-time bounds");
 const uint64_t index=(uint64_t(i.nFileIndexHigh)<<32)|i.nFileIndexLow;
 return std::to_string(i.dwVolumeSerialNumber)+":"+std::to_string(index)+":"+std::to_string(delta*100);
}
static void directoryMove(const json& r){
 if(!keys(r,{"version","kind","operationId","transactionId","action","userData","userDataIdentity","transactionIdentity","dataIdentity","candidateIdentity","sourceIdentity"})||r.at("version")!=1||r.at("kind")!="directory-move"||!uuid(r.at("transactionId").get<std::string>()))throw std::runtime_error("directory move request identity");
 const auto root=normal(wide(r.at("userData").get<std::string>()));if(root.size()<=3)throw std::runtime_error("user data cannot be volume root");
 const auto transaction=normal(root+L"\\backups\\restore-transactions\\"+wide(r.at("transactionId").get<std::string>())),data=transaction+L"\\data",candidate=data+L"\\candidate";
 const auto action=r.at("action").get<std::string>();std::string from,to;std::wstring source,target,sourceParent,targetParent;
 if(action=="retire-original"){from="live";to="original";source=root+L"\\library";target=data+L"\\original-library";sourceParent=root;targetParent=data;}
 else if(action=="install-candidate"){from="candidate";to="live";source=candidate+L"\\library";target=root+L"\\library";sourceParent=candidate;targetParent=root;}
 else if(action=="retire-candidate"){from="live";to="retired-candidate";source=root+L"\\library";target=data+L"\\retired-candidate";sourceParent=root;targetParent=data;}
 else if(action=="restore-original"){from="original";to="live";source=data+L"\\original-library";target=root+L"\\library";sourceParent=data;targetParent=root;}
 else throw std::runtime_error("directory move action not allowed");
 DirectoryPins pins;const HANDLE rootHandle=pins.pin(root),transactionHandle=pins.pin(transaction),dataHandle=pins.pin(data),candidateHandle=pins.pin(candidate);
 const HANDLE targetHandle=pins.pin(targetParent,true,true);
 const json roots={{"userData",nodeDirectoryIdentity(rootHandle)},{"transaction",nodeDirectoryIdentity(transactionHandle)},{"data",nodeDirectoryIdentity(dataHandle)},{"candidate",nodeDirectoryIdentity(candidateHandle)}};
 for(const char* k:{"userData","transaction","data","candidate"})if(roots.at(k)!=r.at(std::string(k)+"Identity"))throw std::runtime_error("directory root identity differs from durable intent");
 Handle sourceHandle;sourceHandle.value=CreateFileW(extended(source).c_str(),FILE_READ_ATTRIBUTES|DELETE,0,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
 if(sourceHandle.value==INVALID_HANDLE_VALUE||finalPath(sourceHandle.value)!=source||nodeDirectoryIdentity(sourceHandle.value)!=r.at("sourceIdentity"))throw std::runtime_error("source directory handle identity unavailable");
 localNtfs(sourceHandle.value,source);if(roots.at("userData").get<std::string>().substr(0,roots.at("userData").get<std::string>().find(':'))!=nodeDirectoryIdentity(sourceHandle.value).substr(0,nodeDirectoryIdentity(sourceHandle.value).find(':')))throw std::runtime_error("directory cutover requires the same local volume");
 absent(target);const auto sourceId=nodeDirectoryIdentity(sourceHandle.value);
 const auto proof=[&](bool moved){return json{{"action",action},{"source",from},{"target",to},{"identity",sourceId},{"sourcePresent",!moved},{"targetPresent",moved},{"roots",roots}};};
 const auto stable=[&](const std::wstring& current){if(finalPath(rootHandle)!=root||finalPath(transactionHandle)!=transaction||finalPath(dataHandle)!=data||finalPath(candidateHandle)!=candidate||finalPath(targetHandle)!=targetParent||finalPath(sourceHandle.value)!=current||nodeDirectoryIdentity(sourceHandle.value)!=sourceId||nodeDirectoryIdentity(rootHandle)!=roots.at("userData")||nodeDirectoryIdentity(transactionHandle)!=roots.at("transaction")||nodeDirectoryIdentity(dataHandle)!=roots.at("data")||nodeDirectoryIdentity(candidateHandle)!=roots.at("candidate"))throw std::runtime_error("directory handles changed during cutover");};
 stable(source);receipt("locked",proof(false));stable(source);absent(target);receipt("intent",proof(false));stable(source);absent(target);
 renamePinnedHandleAbsent(sourceHandle.value,targetHandle,target);
 // Directory FlushFileBuffers is not supported by this adapter. A durable log
 // is not proof of power-loss rename persistence: startup must inspect namespace.
 stable(target);absent(source);receipt("moved",proof(true));stable(target);absent(source);receipt("verified",proof(true));stable(target);absent(source);send({{"kind","done"},{"proof",proof(true)}});
}
int wmain(int argc,wchar_t** argv){return runTagNativeTransaction(argc,argv,directoryMove);}
