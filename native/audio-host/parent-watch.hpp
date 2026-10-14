#pragma once
#include <windows.h>
#include <thread>
#include <tlhelp32.h>
namespace aural_devices {
struct ParentWatch {
    HANDLE parent=nullptr,done=nullptr;std::thread thread;
    bool init(const wchar_t* text){
        wchar_t* end=nullptr;const unsigned long number=wcstoul(text,&end,10);if(!number||!end||*end||number==GetCurrentProcessId())return false;
        HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);if(snapshot==INVALID_HANDLE_VALUE)return false;PROCESSENTRY32W row{};row.dwSize=sizeof(row);bool verified=false;
        if(Process32FirstW(snapshot,&row))do{if(row.th32ProcessID==GetCurrentProcessId()){verified=row.th32ParentProcessID==number;break;}}while(Process32NextW(snapshot,&row));CloseHandle(snapshot);if(!verified)return false;
        parent=OpenProcess(SYNCHRONIZE,FALSE,number);done=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!parent||!done)return false;
        thread=std::thread([this](){HANDLE handles[]={parent,done};const DWORD result=WaitForMultipleObjects(2,handles,FALSE,INFINITE);if(result!=WAIT_OBJECT_0+1)TerminateProcess(GetCurrentProcess(),70);});return true;
    }
    ~ParentWatch(){if(done)SetEvent(done);if(thread.joinable())thread.join();if(parent)CloseHandle(parent);if(done)CloseHandle(done);}
};
}
