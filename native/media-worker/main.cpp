#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cwchar>

// The JS TagAdapter is disposable; all process lifetime and budgets live here.
struct Handle {
 HANDLE value=nullptr;
 Handle()=default; explicit Handle(HANDLE v):value(v){}
 ~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
 Handle(const Handle&)=delete; Handle& operator=(const Handle&)=delete;
};
static bool absolute(const std::wstring& value){return value.size()>3&&(value[1]==L':'&&(value[2]==L'\\'||value[2]==L'/')||value[0]==L'\\'&&value[1]==L'\\')&&value.find(L'"')==std::wstring::npos;}
static bool duplicate(HANDLE source,Handle& target){return DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&target.value,0,TRUE,DUPLICATE_SAME_ACCESS)!=FALSE;}
static bool readExact(HANDLE source,unsigned char* data,DWORD length,const std::atomic<bool>& stop){
 DWORD offset=0;while(offset<length&&!stop.load()){DWORD got=0;if(!ReadFile(source,data+offset,length-offset,&got,nullptr)||!got)return false;offset+=got;}return offset==length;
}
static bool writeExact(HANDLE target,const unsigned char* data,DWORD length,const std::atomic<bool>& stop){
 DWORD offset=0;while(offset<length&&!stop.load()){DWORD sent=0;if(!WriteFile(target,data+offset,length-offset,&sent,nullptr)||!sent)return false;offset+=sent;}return offset==length;
}
#ifndef AURAL_TAG_WRITE_SUPERVISOR
int convertArtwork();
#endif
int wmain(int argc,wchar_t** argv){
#ifndef AURAL_TAG_WRITE_SUPERVISOR
 if(argc==2&&std::wcscmp(argv[1],L"--artwork-convert")==0)return convertArtwork();
#endif
 if(argc!=4)return 65;
 const std::wstring executable=argv[1],script=argv[2];wchar_t* end=nullptr;
 const unsigned long parentId=std::wcstoul(argv[3],&end,10);
#ifdef AURAL_TAG_WRITE_SUPERVISOR
 const std::wstring scriptName=L"tag-write-worker-entry.js";
 constexpr DWORD wallLimit=8UL*60*60*1000;
#else
 const std::wstring scriptName=L"media-worker-entry.js";
 constexpr DWORD wallLimit=22000;
#endif
 if(!absolute(executable)||!absolute(script)||script.size()<scriptName.size()||script.substr(script.size()-scriptName.size())!=scriptName||!parentId||!end||*end)return 65;
 Handle parent(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,parentId));if(!parent.value)return 68;
 wchar_t parentImage[32768];DWORD parentImageLength=32768;
 if(!QueryFullProcessImageNameW(parent.value,0,parentImage,&parentImageLength)||_wcsicmp(executable.c_str(),parentImage)!=0)return 68;
 Handle job(CreateJobObjectW(nullptr,nullptr));if(!job.value)return 66;
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
 limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_JOB_TIME;
 // The fixed image converter is the only extra child used by the adapter.
#ifdef AURAL_TAG_WRITE_SUPERVISOR
 limits.BasicLimitInformation.ActiveProcessLimit=1;
 limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart=6LL*60*60*10000000LL;
#else
 limits.BasicLimitInformation.ActiveProcessLimit=2;
 limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart=20LL*10000000LL;
#endif
 limits.ProcessMemoryLimit=384ULL*1024*1024;limits.JobMemoryLimit=512ULL*1024*1024;
 if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))return 66;
 JOBOBJECT_END_OF_JOB_TIME_INFORMATION action{};action.EndOfJobTimeAction=JOB_OBJECT_TERMINATE_AT_END_OF_JOB;
 if(!SetInformationJobObject(job.value,JobObjectEndOfJobTimeInformation,&action,sizeof(action)))return 66;
 Handle inputRead,inputWrite,output,error,cancel(CreateEventW(nullptr,TRUE,FALSE,nullptr));
 SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
 if(!cancel.value||!CreatePipe(&inputRead.value,&inputWrite.value,&security,65536)||!SetHandleInformation(inputWrite.value,HANDLE_FLAG_INHERIT,0)||!duplicate(GetStdHandle(STD_OUTPUT_HANDLE),output)||!duplicate(GetStdHandle(STD_ERROR_HANDLE),error))return 66;
 SIZE_T attributeBytes=0;InitializeProcThreadAttributeList(nullptr,2,0,&attributeBytes);
 if(!attributeBytes)return 66;std::vector<unsigned char> attributeStorage(attributeBytes);
 auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
 if(!InitializeProcThreadAttributeList(attributes,2,0,&attributeBytes))return 66;
 HANDLE inherited[]={inputRead.value,output.value,error.value};HANDLE jobs[]={job.value};
 const bool ready=UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr)&&UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,jobs,sizeof(jobs),nullptr,nullptr);
 STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
 startup.StartupInfo.hStdInput=inputRead.value;startup.StartupInfo.hStdOutput=output.value;startup.StartupInfo.hStdError=error.value;startup.lpAttributeList=attributes;
 wchar_t supervisorImage[32768];const DWORD supervisorLength=GetModuleFileNameW(nullptr,supervisorImage,32768);
 if(!supervisorLength||supervisorLength>=32768){DeleteProcThreadAttributeList(attributes);return 66;}
 std::wstring command=L"\""+executable+L"\" --max-old-space-size=128 \""+script+L"\" \""+supervisorImage+L"\"";
 PROCESS_INFORMATION process{};
 const BOOL created=ready&&CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|BELOW_NORMAL_PRIORITY_CLASS|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&process);
 DeleteProcThreadAttributeList(attributes);if(!created)return 67;
 Handle child(process.hProcess),initialThread(process.hThread);
 // Job-list assignment is atomic with creation, including a supervisor crash here.
 std::atomic<bool> stopping{false};std::thread reader;
 try{reader=std::thread([&]{
  unsigned char header[4];
  if(!readExact(GetStdHandle(STD_INPUT_HANDLE),header,4,stopping)){SetEvent(cancel.value);return;}
  const uint32_t size=uint32_t(header[0])|(uint32_t(header[1])<<8)|(uint32_t(header[2])<<16)|(uint32_t(header[3])<<24);
#ifdef AURAL_TAG_WRITE_SUPERVISOR
  if(!size||size>524288){SetEvent(cancel.value);return;}
#else
  if(!size||size>65536){SetEvent(cancel.value);return;}
#endif
  std::vector<unsigned char> payload(size);
  if(!readExact(GetStdHandle(STD_INPUT_HANDLE),payload.data(),size,stopping)||!writeExact(inputWrite.value,header,4,stopping)||!writeExact(inputWrite.value,payload.data(),size,stopping)){SetEvent(cancel.value);return;}
#ifdef AURAL_TAG_WRITE_SUPERVISOR
  // Only small acknowledgement frames may follow the one frozen start request.
  // Structural identity and phase ordering are also checked by the JS adapter.
  while(!stopping.load()){
   if(!readExact(GetStdHandle(STD_INPUT_HANDLE),header,4,stopping)){SetEvent(cancel.value);return;}
   const uint32_t next=uint32_t(header[0])|(uint32_t(header[1])<<8)|(uint32_t(header[2])<<16)|(uint32_t(header[3])<<24);
   if(!next||next>4096){SetEvent(cancel.value);return;}
   std::vector<unsigned char> acknowledgement(next);
   if(!readExact(GetStdHandle(STD_INPUT_HANDLE),acknowledgement.data(),next,stopping)||!writeExact(inputWrite.value,header,4,stopping)||!writeExact(inputWrite.value,acknowledgement.data(),next,stopping)){SetEvent(cancel.value);return;}
  }
#else
  // EOF, any further byte, or parent death cancels even a CPU-blocked TagAdapter.
  unsigned char extra;DWORD got=0;
  if(!stopping.load())ReadFile(GetStdHandle(STD_INPUT_HANDLE),&extra,1,&got,nullptr);
  if(!stopping.load())SetEvent(cancel.value);
#endif
 });}catch(...){TerminateJobObject(job.value,77);WaitForSingleObject(child.value,INFINITE);return 66;}
 const DWORD resumed=ResumeThread(initialThread.value);
 HANDLE watched[]={child.value,parent.value,cancel.value};
 const DWORD outcome=resumed==DWORD(-1)?WAIT_FAILED:WaitForMultipleObjects(3,watched,FALSE,wallLimit);
 int result=0;
 if(outcome!=WAIT_OBJECT_0){result=outcome==WAIT_OBJECT_0+1?68:outcome==WAIT_OBJECT_0+2?69:outcome==WAIT_TIMEOUT?70:72;TerminateJobObject(job.value,77);}
 // Do not acknowledge cancellation or free the parser slot before process exit.
 if(WaitForSingleObject(child.value,INFINITE)!=WAIT_OBJECT_0)result=72;
 DWORD code=1;if(!GetExitCodeProcess(child.value,&code)||code!=0){if(!result)result=71;}
 // A converter can outlive a crashed JS adapter. Confirm the whole Job is empty.
 if(!TerminateJobObject(job.value,77))result=72;
 for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if(!QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr)){result=72;break;}
  if(!accounting.ActiveProcesses)break;Sleep(20);
 }
 stopping.store(true);
 while(WaitForSingleObject(reader.native_handle(),0)==WAIT_TIMEOUT){CancelSynchronousIo(reader.native_handle());WaitForSingleObject(reader.native_handle(),20);}
 reader.join();return result;
}
