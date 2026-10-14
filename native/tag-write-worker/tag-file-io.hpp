#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <bcrypt.h>
#include "../audio-host/vendor/json.hpp"
#include <io.h>
#include <fcntl.h>
#include <array>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstring>
#include <cstdlib>
#include <cwchar>
#include <cwctype>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>
using json=nlohmann::json;
struct Handle{HANDLE value=INVALID_HANDLE_VALUE;~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}Handle()=default;Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;};
static std::wstring wide(const std::string& s){if(s.empty()||s.size()>131072||s.find('\0')!=std::string::npos)throw std::runtime_error("invalid path");int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0);if(n<=0||n>32767)throw std::runtime_error("invalid UTF8 path");std::wstring r(n,0);MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),r.data(),n);return r;}
static std::wstring normal(std::wstring s){if(s.rfind(L"\\\\?\\UNC\\",0)==0)s=L"\\\\"+s.substr(8);else if(s.rfind(L"\\\\?\\",0)==0)s=s.substr(4);for(auto& c:s){if(c==L'/')c=L'\\';c=std::towlower(c);}while(s.size()>3&&s.back()==L'\\')s.pop_back();return s;}
static std::wstring extended(const std::wstring& s){if(s.rfind(L"\\\\?\\",0)==0)return s;if(s.rfind(L"\\\\",0)==0)return L"\\\\?\\UNC\\"+s.substr(2);if(s.size()>=3&&s[1]==L':'&&(s[2]==L'\\'||s[2]==L'/'))return L"\\\\?\\"+s;throw std::runtime_error("path is not absolute");}
static std::wstring finalPath(HANDLE h){std::vector<wchar_t> b(32768);DWORD n=GetFinalPathNameByHandleW(h,b.data(),DWORD(b.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);if(!n||n>=b.size())throw std::runtime_error("final path unavailable");return normal(std::wstring(b.data(),n));}
static bool inside(const std::wstring& root,const std::wstring& name){return name==root||(name.size()>root.size()&&name.compare(0,root.size(),root)==0&&(root.back()==L'\\'||name[root.size()]==L'\\'));}
static std::string hex(const unsigned char* p,size_t n){static const char* chars="0123456789abcdef";std::string s;for(size_t i=0;i<n;i++){s+=chars[p[i]>>4];s+=chars[p[i]&15];}return s;}
static bool uuid(const std::string& s){if(s.size()!=36)return false;for(size_t i=0;i<s.size();i++){if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}else if(!std::isxdigit(static_cast<unsigned char>(s[i])))return false;}return true;}
static uint64_t ticks(const LARGE_INTEGER& t){return static_cast<uint64_t>(t.QuadPart);}
static json identity(HANDLE h,bool directory){FILE_ID_INFO id{};FILE_BASIC_INFO basic{};FILE_STANDARD_INFO standard{};if(!GetFileInformationByHandleEx(h,FileIdInfo,&id,sizeof(id))||!GetFileInformationByHandleEx(h,FileBasicInfo,&basic,sizeof(basic))||!GetFileInformationByHandleEx(h,FileStandardInfo,&standard,sizeof(standard))||(basic.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||bool(standard.Directory)!=directory||(!directory&&standard.NumberOfLinks!=1)||standard.EndOfFile.QuadPart<0)throw std::runtime_error("file identity unavailable or unsafe");return {{"volume",std::to_string(id.VolumeSerialNumber)},{"fileId",hex(id.FileId.Identifier,16)},{"creation",std::to_string(ticks(basic.CreationTime))},{"modified",std::to_string(ticks(basic.LastWriteTime))},{"changed",std::to_string(ticks(basic.ChangeTime))},{"bytes",std::to_string(standard.EndOfFile.QuadPart)}};}
struct Hash{BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE value=nullptr;std::vector<unsigned char> object;Hash(){DWORD n=0,got=0;if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0||BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&n),sizeof(n),&got,0)<0)throw std::runtime_error("SHA provider unavailable");object.resize(n);if(BCryptCreateHash(algorithm,&value,object.data(),n,nullptr,0,0)<0)throw std::runtime_error("SHA context unavailable");}~Hash(){if(value)BCryptDestroyHash(value);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);}void add(const unsigned char* p,DWORD n){if(n&&BCryptHashData(value,const_cast<PUCHAR>(p),n,0)<0)throw std::runtime_error("SHA update failed");}std::string finish(){unsigned char b[32];if(BCryptFinishHash(value,b,32,0)<0)throw std::runtime_error("SHA final failed");return hex(b,32);}};
static void seek(HANDLE h,uint64_t n){LARGE_INTEGER p{};p.QuadPart=static_cast<LONGLONG>(n);if(!SetFilePointerEx(h,p,nullptr,FILE_BEGIN))throw std::runtime_error("seek failed");}
static void exact(HANDLE h,unsigned char* b,DWORD n){DWORD at=0;while(at<n){DWORD got=0;if(!ReadFile(h,b+at,n-at,&got,nullptr)||!got)throw std::runtime_error("read failed");at+=got;}}
static uint64_t audioOffset(HANDLE h,uint64_t bytes){if(bytes<43)throw std::runtime_error("not a complete FLAC prefix");unsigned char magic[4];seek(h,0);exact(h,magic,4);if(std::memcmp(magic,"fLaC",4)!=0)throw std::runtime_error("not standard FLAC");uint64_t at=4;for(unsigned i=0;i<1024;i++){if(at+4>bytes||at+4>33554432)throw std::runtime_error("FLAC metadata bounds");seek(h,at);unsigned char head[4];exact(h,head,4);unsigned type=head[0]&127;uint64_t length=(uint64_t(head[1])<<16)|(uint64_t(head[2])<<8)|head[3];if(type==127||(i==0&&(type!=0||length!=34))||(i!=0&&type==0)||at+4+length>33554432||at+4+length>=bytes)throw std::runtime_error("FLAC metadata layout");at+=4+length;if(head[0]&128)return at;}throw std::runtime_error("FLAC block count");}
