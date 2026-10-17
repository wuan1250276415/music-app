#include "tag-file-transaction.hpp"

static void cleanBackup(const json& r){
 if(!keys(r,{"version","kind","operationId","jobId","backupArtifactId","backupRoot","source","expected"})||r.at("version")!=1||(r.at("kind")!="inspect-backup"&&r.at("kind")!="delete-backup")||!uuid(r.at("jobId").get<std::string>())||!uuid(r.at("backupArtifactId").get<std::string>()))throw std::runtime_error("invalid backup cleanup identity");
 const bool removing=r.at("kind")=="delete-backup";const auto expected=r.at("expected"),source=r.at("source");
 if(!keys(source,{"sha256","audioSha256","metadataSha256","byteLength","audioOffset","audioBytes"})||!digest(source.at("sha256"))||!digest(source.at("audioSha256"))||!digest(source.at("metadataSha256"))||(!removing&&!expected.is_null())||(removing&&(!keys(expected,{"root","backup","removed"})||expected.at("removed")!=false||expected.at("backup").at("flac")!=source)))throw std::runtime_error("backup deletion requires verified original content");
 const auto rootName=normal(wide(r.at("backupRoot").get<std::string>()));
 DirectoryPins pins;HANDLE root=pins.pin(rootName);const auto rootId=identity(root,true);
 if(removing)for(const char* k:{"volume","fileId","creation"})if(rootId.at(k)!=expected.at("root").at(k))throw std::runtime_error("backup root changed since review");
 Artifact backup;backup.role="backup";backup.name=rootName+L"\\"+wide(r.at("jobId").get<std::string>())+L"-"+wide(r.at("backupArtifactId").get<std::string>())+L".bak";backup.name=normal(backup.name);leafOf(backup.name);
 if(parentOf(backup.name)!=rootName)throw std::runtime_error("backup path escaped pinned directory");
 backup.handle.value=CreateFileW(extended(backup.name).c_str(),GENERIC_READ|(removing?DELETE:0),0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
 if(backup.handle.value==INVALID_HANDLE_VALUE||finalPath(backup.handle.value)!=backup.name)throw std::runtime_error("backup missing, busy or redirected");
 const auto fileId=identity(backup.handle.value,false);noStreams(backup.handle.value);
 FILE_BASIC_INFO basic{};if(!GetFileInformationByHandleEx(backup.handle.value,FileBasicInfo,&basic,sizeof(basic))||basic.FileAttributes&~(FILE_ATTRIBUTE_NORMAL|FILE_ATTRIBUTE_ARCHIVE|FILE_ATTRIBUTE_HIDDEN|FILE_ATTRIBUTE_SYSTEM|FILE_ATTRIBUTE_NOT_CONTENT_INDEXED))throw std::runtime_error("unsupported backup attributes");
 if(fileId.at("bytes")!=source.at("byteLength")||std::stoull(fileId.at("bytes").get<std::string>())>68719476736ULL)throw std::runtime_error("backup byte length differs");
 hashArtifact(backup);
 if(backup.result.at("flac")!=source||(removing&&backup.result!=expected.at("backup")))throw std::runtime_error("backup content or exclusive identity differs from original proof");
 json proof={{"root",rootId},{"backup",backup.result},{"removed",false}};
 receipt("checked",proof);
 if(removing){
  // The parent must fsync its write-ahead record and persist the corresponding
  // database decision before acknowledging this exact delete-ready receipt.
  receipt("delete_ready",proof);
  if(WaitForSingleObject(cancelEvent,0)!=WAIT_TIMEOUT||identity(backup.handle.value,false)!=fileId||finalPath(backup.handle.value)!=backup.name||finalPath(root)!=rootName)throw std::runtime_error("backup changed or deletion cancelled before disposition");
  for(const char* k:{"volume","fileId","creation"})if(identity(root,true).at(k)!=rootId.at(k))throw std::runtime_error("pinned backup root identity changed");
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;
  if(!SetFileInformationByHandle(backup.handle.value,FileDispositionInfo,&disposition,sizeof(disposition)))throw std::runtime_error("backup handle disposition failed: "+std::to_string(GetLastError()));
  if(!CloseHandle(backup.handle.value))throw std::runtime_error("backup deletion close unconfirmed");backup.handle.value=INVALID_HANDLE_VALUE;
  Handle check;check.value=CreateFileW(extended(backup.name).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);const DWORD error=GetLastError();
  if(check.value!=INVALID_HANDLE_VALUE||error!=ERROR_FILE_NOT_FOUND||finalPath(root)!=rootName)throw std::runtime_error("deleted backup path is not confirmed absent");
  proof["removed"]=true;receipt("deleted",proof);
 }
 send({{"kind","done"},{"proof",proof}});
}
int wmain(int argc,wchar_t** argv){
 SetPriorityClass(GetCurrentProcess(),BELOW_NORMAL_PRIORITY_CLASS);
 return runTagNativeTransaction(argc,argv,cleanBackup);
}
