#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincred.h>
#include <sddl.h>
#include <io.h>
#include <fcntl.h>
#include <iostream>
#include <vector>
#include <string>
#include <regex>
#include <cstdint>
#include <cstring>
#include <cstdio>

static bool read(void* value,size_t bytes){return !!std::cin.read(static_cast<char*>(value),bytes);}
static uint32_t number(const BYTE* p,size_t bytes){uint32_t value=0;for(size_t i=0;i<bytes;i++)value|=uint32_t(p[i])<<(8*i);return value;}
static void reply(DWORD status,const BYTE* value=nullptr,DWORD size=0){BYTE header[12]={'A','U','R','1'};for(int i=0;i<4;i++){header[4+i]=BYTE(status>>(8*i));header[8+i]=BYTE(size>>(8*i));}std::cout.write(reinterpret_cast<char*>(header),sizeof(header));if(size)std::cout.write(reinterpret_cast<const char*>(value),size);std::cout.flush();}
struct Wiped {std::vector<BYTE> bytes;~Wiped(){if(!bytes.empty())SecureZeroMemory(bytes.data(),bytes.size());}};
struct MutexGuard {HANDLE handle=nullptr;bool owned=false;~MutexGuard(){if(owned)ReleaseMutex(handle);if(handle)CloseHandle(handle);}};
struct LocalString {LPWSTR value=nullptr;~LocalString(){if(value)LocalFree(value);}};
static std::wstring userSid(){
 MutexGuard token;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.handle))throw GetLastError();
 DWORD size=0;GetTokenInformation(token.handle,TokenUser,nullptr,0,&size);
 if(!size||size>65536)throw DWORD(ERROR_INVALID_DATA);
 Wiped data;data.bytes.resize(size);
 if(!GetTokenInformation(token.handle,TokenUser,data.bytes.data(),size,&size))throw GetLastError();
 LocalString sid;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.bytes.data())->User.Sid,&sid.value))throw GetLastError();
 return std::wstring(sid.value);
}
int main(){
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
 try{
  BYTE header[15];if(!read(header,sizeof(header))||std::memcmp(header,"AUR1",4)){reply(ERROR_INVALID_DATA);return 0;}
  const BYTE op=header[4];const auto scopeSize=number(header+5,2),providerSize=number(header+7,2),slotSize=number(header+9,2),secretSize=number(header+11,4);
  if(op<1||op>5||scopeSize!=36||!providerSize||providerSize>64||!slotSize||slotSize>64||secretSize>2048||(op==2||op==5?secretSize==0:secretSize!=0)){reply(ERROR_INVALID_PARAMETER);return 0;}
  Wiped input;input.bytes.resize(scopeSize+providerSize+slotSize+secretSize);if(!read(input.bytes.data(),input.bytes.size())||std::cin.get()!=EOF){reply(ERROR_INVALID_DATA);return 0;}
  const std::string scope(reinterpret_cast<char*>(input.bytes.data()),scopeSize),provider(reinterpret_cast<char*>(input.bytes.data()+scopeSize),providerSize),slot(reinterpret_cast<char*>(input.bytes.data()+scopeSize+providerSize),slotSize);
  if(!std::regex_match(scope,std::regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"))||!std::regex_match(provider,std::regex("[a-z][a-z0-9-]{0,63}"))||!std::regex_match(slot,std::regex("[a-z][a-z0-9-]{0,63}"))){reply(ERROR_INVALID_PARAMETER);return 0;}
  const std::string suffix=scope+"/"+provider+"/"+slot;std::wstring target=L"Aural/provider/"+std::wstring(suffix.begin(),suffix.end()),mutexName=L"Global\\AuralCredential/"+userSid()+L"/"+std::wstring(suffix.begin(),suffix.end());
  if(mutexName.size()>=MAX_PATH){reply(ERROR_INVALID_PARAMETER);return 0;}
  MutexGuard mutex;mutex.handle=CreateMutexW(nullptr,FALSE,mutexName.c_str());if(!mutex.handle){reply(GetLastError());return 0;}const DWORD waited=WaitForSingleObject(mutex.handle,5000);if(waited!=WAIT_OBJECT_0&&waited!=WAIT_ABANDONED){reply(ERROR_BUSY);return 0;}mutex.owned=true;
  if(op==2||op==5){bool create=true;if(op==5){PCREDENTIALW existing=nullptr;if(CredReadW(target.c_str(),CRED_TYPE_GENERIC,0,&existing)){if(existing->CredentialBlobSize>2048)reply(ERROR_INVALID_DATA);else reply(ERROR_SUCCESS,existing->CredentialBlob,existing->CredentialBlobSize);if(existing->CredentialBlob&&existing->CredentialBlobSize)SecureZeroMemory(existing->CredentialBlob,existing->CredentialBlobSize);CredFree(existing);create=false;}else{const DWORD error=GetLastError();if(error!=ERROR_NOT_FOUND){reply(error);create=false;}}}if(create){CREDENTIALW credential{};credential.Type=CRED_TYPE_GENERIC;credential.TargetName=const_cast<wchar_t*>(target.c_str());credential.UserName=const_cast<wchar_t*>(L"Aural");credential.Persist=CRED_PERSIST_LOCAL_MACHINE;credential.CredentialBlob=input.bytes.data()+scopeSize+providerSize+slotSize;credential.CredentialBlobSize=secretSize;const BOOL success=CredWriteW(&credential,0);const DWORD status=success?ERROR_SUCCESS:GetLastError();reply(status,success&&op==5?credential.CredentialBlob:nullptr,success&&op==5?secretSize:0);}}
  else if(op==3){const BOOL success=CredDeleteW(target.c_str(),CRED_TYPE_GENERIC,0);const DWORD status=success?ERROR_SUCCESS:GetLastError();reply(status==ERROR_NOT_FOUND?ERROR_SUCCESS:status);}
  else{PCREDENTIALW credential=nullptr;if(!CredReadW(target.c_str(),CRED_TYPE_GENERIC,0,&credential))reply(GetLastError());else{if(credential->CredentialBlobSize>2048)reply(ERROR_INVALID_DATA);else if(op==4){const BYTE present=1;reply(ERROR_SUCCESS,&present,1);}else reply(ERROR_SUCCESS,credential->CredentialBlob,credential->CredentialBlobSize);if(credential->CredentialBlob&&credential->CredentialBlobSize)SecureZeroMemory(credential->CredentialBlob,credential->CredentialBlobSize);CredFree(credential);}}
  return 0;
 }catch(DWORD error){reply(error);return 0;}catch(...){reply(ERROR_INVALID_DATA);return 0;}
}
