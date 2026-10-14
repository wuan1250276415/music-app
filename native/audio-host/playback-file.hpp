#pragma once
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstddef>
#include <stdexcept>
#include <string>
#include "vendor/json.hpp"

// A single read-only file object. Decoder resets and output fallback borrow this handle.
// VFS callbacks are control/producer operations, never audio callback operations.
struct AuralPlaybackFile {
    ma_vfs_callbacks callbacks{}; // ma_vfs requires its callback table at offset zero.
    HANDLE handle=INVALID_HANDLE_VALUE;
    BY_HANDLE_FILE_INFORMATION initial{};
    std::atomic<bool>* cancellation=nullptr;
    uint64_t deadline=0,checkAt=0;
    ma_result ioError=MA_SUCCESS;
    AuralPlaybackFile(){
        callbacks.onOpen=[](ma_vfs* raw,const char* name,ma_uint32 mode,ma_vfs_file* out){
            auto* self=static_cast<AuralPlaybackFile*>(raw);
            if(!name||std::strcmp(name,"aural-playback")||mode!=MA_OPEN_MODE_READ||self->handle==INVALID_HANDLE_VALUE)return MA_ACCESS_DENIED;
            *out=self;return MA_SUCCESS;
        };
        callbacks.onClose=[](ma_vfs*,ma_vfs_file){return MA_SUCCESS;}; // The owner closes after codec teardown.
        callbacks.onRead=[](ma_vfs*,ma_vfs_file raw,void* out,size_t wanted,size_t* got){
            auto* self=static_cast<AuralPlaybackFile*>(raw);if(got)*got=0;if(!self->allowed())return self->remember(MA_CANCELLED);
            if(!wanted)return MA_SUCCESS;DWORD count=0;
            if(!ReadFile(self->handle,out,DWORD(std::min<size_t>(wanted,0x7fffffff)),&count,nullptr))return self->remember(MA_IO_ERROR);
            if(!self->allowed())return self->remember(MA_CANCELLED);if(got)*got=count;return count?MA_SUCCESS:MA_AT_END;
        };
        callbacks.onSeek=[](ma_vfs*,ma_vfs_file raw,ma_int64 offset,ma_seek_origin origin){
            auto* self=static_cast<AuralPlaybackFile*>(raw);if(!self->allowed())return self->remember(MA_CANCELLED);
            const DWORD base=origin==ma_seek_origin_start?FILE_BEGIN:origin==ma_seek_origin_current?FILE_CURRENT:origin==ma_seek_origin_end?FILE_END:0xffffffff;
            if(base==0xffffffff)return self->remember(MA_INVALID_ARGS);LARGE_INTEGER where{};where.QuadPart=offset;
            return SetFilePointerEx(self->handle,where,nullptr,base)?MA_SUCCESS:self->remember(MA_BAD_SEEK);
        };
        callbacks.onTell=[](ma_vfs*,ma_vfs_file raw,ma_int64* cursor){
            auto* self=static_cast<AuralPlaybackFile*>(raw);if(!self->allowed())return self->remember(MA_CANCELLED);
            LARGE_INTEGER zero{},where{};if(!SetFilePointerEx(self->handle,zero,&where,FILE_CURRENT))return self->remember(MA_IO_ERROR);*cursor=where.QuadPart;return MA_SUCCESS;
        };
        callbacks.onInfo=[](ma_vfs*,ma_vfs_file raw,ma_file_info* info){
            auto* self=static_cast<AuralPlaybackFile*>(raw);if(!self->allowed())return self->remember(MA_CANCELLED);
            LARGE_INTEGER size{};if(!GetFileSizeEx(self->handle,&size)||size.QuadPart<0)return self->remember(MA_IO_ERROR);*info={};info->sizeInBytes=uint64_t(size.QuadPart);return MA_SUCCESS;
        };
    }
    AuralPlaybackFile(const AuralPlaybackFile&)=delete;AuralPlaybackFile& operator=(const AuralPlaybackFile&)=delete;
    ~AuralPlaybackFile(){close();}
    ma_result remember(ma_result value){if(ioError==MA_SUCCESS)ioError=value;return value;}
    bool allowed()const{return handle!=INVALID_HANDLE_VALUE&&(!cancellation||!cancellation->load(std::memory_order_acquire))&&(!deadline||GetTickCount64()<=deadline);}
    static uint64_t size(const BY_HANDLE_FILE_INFORMATION& v){return (uint64_t(v.nFileSizeHigh)<<32)|v.nFileSizeLow;}
    static uint64_t index(const BY_HANDLE_FILE_INFORMATION& v){return (uint64_t(v.nFileIndexHigh)<<32)|v.nFileIndexLow;}
    static uint64_t written(const BY_HANDLE_FILE_INFORMATION& v){return (uint64_t(v.ftLastWriteTime.dwHighDateTime)<<32)|v.ftLastWriteTime.dwLowDateTime;}
    void close(){if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);handle=INVALID_HANDLE_VALUE;initial={};cancellation=nullptr;deadline=checkAt=0;ioError=MA_SUCCESS;}
    ma_result open(const std::wstring& path,std::atomic<bool>* cancel){
        close();std::wstring name=path;if(name.empty()||name.size()>32767||name.find(L'\0')!=std::wstring::npos)return MA_INVALID_ARGS;
        if(name.rfind(L"\\\\?\\",0)!=0){if(name.rfind(L"\\\\",0)==0)name=L"\\\\?\\UNC\\"+name.substr(2);else if(name.size()>2&&name[1]==L':'&&(name[2]==L'\\'||name[2]==L'/'))name=L"\\\\?\\"+name;else return MA_INVALID_ARGS;}
        handle=CreateFileW(name.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(handle==INVALID_HANDLE_VALUE)return MA_DOES_NOT_EXIST;
        if(GetFileType(handle)!=FILE_TYPE_DISK||!GetFileInformationByHandle(handle,&initial)||(initial.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||!size(initial)){close();return MA_INVALID_FILE;}
        cancellation=cancel;return begin(true);
    }
    ma_result begin(bool force=false){
        ioError=MA_SUCCESS;deadline=GetTickCount64()+20000;if(!allowed())return remember(MA_CANCELLED);
        if(force||GetTickCount64()>=checkAt){
            BY_HANDLE_FILE_INFORMATION now{};
            if(!GetFileInformationByHandle(handle,&now)||now.dwVolumeSerialNumber!=initial.dwVolumeSerialNumber||index(now)!=index(initial)||size(now)!=size(initial)||written(now)!=written(initial)||(now.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))return remember(MA_INVALID_DATA);
            checkAt=GetTickCount64()+1000;
        }return MA_SUCCESS;
    }
    nlohmann::json binding()const{
        if(handle==INVALID_HANDLE_VALUE)throw std::runtime_error("playback file not open");
        return {{"version",1},{"kind","windows-readonly-handle"},{"volumeSerial",std::to_string(initial.dwVolumeSerialNumber)},{"fileIndex",std::to_string(index(initial))},{"byteLength",std::to_string(size(initial))},{"lastWriteTicks",std::to_string(written(initial))},{"shareMode","read-only"},{"certification","pending"}};
    }
};
static_assert(offsetof(AuralPlaybackFile,callbacks)==0,"playback VFS callbacks must be first");
