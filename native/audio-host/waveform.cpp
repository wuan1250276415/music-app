#define NOMINMAX
#define MA_NO_DEVICE_IO
#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include "vendor/json.hpp"
#include "cue-frames.hpp"
#include "source-sample-span.hpp"
#include "ffmpeg-decoder.hpp"
#include "dsd-description.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <io.h>
#include <fcntl.h>
#include <array>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cwctype>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
using json=nlohmann::json;
constexpr const char* algorithm="minmax-f32-v4-sample-span-ma-0.11.25-ff-8.1.3-dsdpcm-v1";
struct File {HANDLE handle=INVALID_HANDLE_VALUE;~File(){if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);}};
struct Hash {BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::vector<unsigned char> object;~Hash(){if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);}};
static void send(const json& value){const std::string data=value.dump();if(data.size()>524288)throw std::runtime_error("analysis response too large");uint32_t size=uint32_t(data.size());char header[4]={char(size),char(size>>8),char(size>>16),char(size>>24)};std::cout.write(header,4).write(data.data(),data.size()).flush();if(!std::cout)throw std::runtime_error("analysis channel closed");}
static void commitAck(){unsigned char header[4];if(!std::cin.read(reinterpret_cast<char*>(header),4))throw std::runtime_error("analysis commit missing");const uint32_t size=uint32_t(header[0])|(uint32_t(header[1])<<8)|(uint32_t(header[2])<<16)|(uint32_t(header[3])<<24);if(!size||size>1024)throw std::runtime_error("invalid analysis commit");std::string body(size,0);if(!std::cin.read(body.data(),size))throw std::runtime_error("analysis commit incomplete");if(json::parse(body).value("kind","")!="commit")throw std::runtime_error("invalid analysis commit");}
static std::wstring wide(const std::string& text){const int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),int(text.size()),nullptr,0);if(n<=0||n>32767)throw std::runtime_error("invalid media path");std::wstring result(n,0);MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),int(text.size()),result.data(),n);return result;}
static std::wstring extended(const std::wstring& value){if(value.rfind(L"\\\\?\\",0)==0)return value;if(value.rfind(L"\\\\",0)==0)return L"\\\\?\\UNC\\"+value.substr(2);if(value.size()>2&&value[1]==L':')return L"\\\\?\\"+value;throw std::runtime_error("media path is not absolute");}
static std::wstring normal(std::wstring value){if(value.rfind(L"\\\\?\\UNC\\",0)==0)value=L"\\\\"+value.substr(8);else if(value.rfind(L"\\\\?\\",0)==0)value=value.substr(4);for(auto& ch:value){if(ch==L'/')ch=L'\\';ch=std::towlower(ch);}while(value.size()>3&&value.back()==L'\\')value.pop_back();return value;}
struct LockedVfs {ma_vfs_callbacks callbacks{};File* file=nullptr;};
static ma_result openLocked(ma_vfs* vfs,const char*,ma_uint32 mode,ma_vfs_file* file){if(mode&MA_OPEN_MODE_WRITE)return MA_ACCESS_DENIED;*file=static_cast<LockedVfs*>(vfs)->file;return MA_SUCCESS;}
static ma_result readLocked(ma_vfs*,ma_vfs_file file,void* output,size_t wanted,size_t* got){DWORD count=0;if(!ReadFile(static_cast<File*>(file)->handle,output,DWORD(std::min<size_t>(wanted,0x7fffffff)),&count,nullptr))return MA_IO_ERROR;if(got)*got=count;return count?MA_SUCCESS:MA_AT_END;}
static ma_result seekLocked(ma_vfs*,ma_vfs_file file,ma_int64 offset,ma_seek_origin origin){LARGE_INTEGER where;where.QuadPart=offset;return SetFilePointerEx(static_cast<File*>(file)->handle,where,nullptr,origin==ma_seek_origin_start?FILE_BEGIN:origin==ma_seek_origin_current?FILE_CURRENT:FILE_END)?MA_SUCCESS:MA_BAD_SEEK;}
static ma_result tellLocked(ma_vfs*,ma_vfs_file file,ma_int64* cursor){LARGE_INTEGER zero{},where{};if(!SetFilePointerEx(static_cast<File*>(file)->handle,zero,&where,FILE_CURRENT))return MA_IO_ERROR;*cursor=where.QuadPart;return MA_SUCCESS;}
static ma_result infoLocked(ma_vfs*,ma_vfs_file file,ma_file_info* info){LARGE_INTEGER size{};if(!GetFileSizeEx(static_cast<File*>(file)->handle,&size))return MA_IO_ERROR;info->sizeInBytes=size.QuadPart;return MA_SUCCESS;}
static uint64_t integer(const json& value,const char* key){if(!value.contains(key)||!value[key].is_number_integer()||value[key]<0)throw std::runtime_error("invalid media span");return value[key].get<uint64_t>();}
int main(){
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);SetPriorityClass(GetCurrentProcess(),PROCESS_MODE_BACKGROUND_BEGIN);SetThreadPriority(GetCurrentThread(),THREAD_PRIORITY_BELOW_NORMAL);
 try{
  unsigned char header[4];if(!std::cin.read(reinterpret_cast<char*>(header),4))return 2;
  uint32_t size=uint32_t(header[0])|(uint32_t(header[1])<<8)|(uint32_t(header[2])<<16)|(uint32_t(header[3])<<24);if(!size||size>131072)return 2;
  std::string body(size,0);if(!std::cin.read(body.data(),size))return 2;
  const auto request=json::parse(body);if(request.value("version",0)!=2||request.value("algorithm","")!=algorithm)throw std::runtime_error("analysis protocol mismatch");
  const uint64_t parentId=integer(request,"parentPid");if(!parentId||parentId>UINT32_MAX)throw std::runtime_error("invalid analysis owner");
  HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,DWORD(parentId));if(!parent)throw std::runtime_error("analysis owner unavailable");
  std::thread([parent](){WaitForSingleObject(parent,INFINITE);ExitProcess(3);}).detach(); // Handle lives until this short-lived process exits.
  File file;const auto filename=wide(request.at("path").get<std::string>()),root=normal(wide(request.at("rootPath").get<std::string>()));
  file.handle=CreateFileW(extended(filename).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
  if(file.handle==INVALID_HANDLE_VALUE)throw std::runtime_error("media unavailable or being modified");
  BY_HANDLE_FILE_INFORMATION info{};if(!GetFileInformationByHandle(file.handle,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))throw std::runtime_error("media is not a regular file");
  std::wstring finalPath(32768,0);const DWORD finalLength=GetFinalPathNameByHandleW(file.handle,finalPath.data(),DWORD(finalPath.size()),FILE_NAME_NORMALIZED);if(!finalLength||finalLength>=finalPath.size())throw std::runtime_error("media path cannot be verified");finalPath.resize(finalLength);finalPath=normal(finalPath);
  const auto prefix=root+(root.back()==L'\\'?L"":L"\\");if(finalPath.rfind(prefix,0)!=0)throw std::runtime_error("media is outside the library root");
  const uint64_t fileBytes=(uint64_t(info.nFileSizeHigh)<<32)|info.nFileSizeLow;if(!fileBytes)throw std::runtime_error("empty media file");
  Hash hash;DWORD objectLength=0,returned=0;if(BCryptOpenAlgorithmProvider(&hash.algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0||BCryptGetProperty(hash.algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&objectLength),sizeof(objectLength),&returned,0)<0||!objectLength||objectLength>1048576)throw std::runtime_error("content hash unavailable");
  hash.object.resize(objectLength);std::vector<unsigned char> block(1024*1024);if(BCryptCreateHash(hash.algorithm,&hash.hash,hash.object.data(),objectLength,nullptr,0,0)<0)throw std::runtime_error("content hash unavailable");
  uint64_t hashed=0;auto progressAt=std::chrono::steady_clock::now()-std::chrono::seconds(1);
  while(true){DWORD got=0;if(!ReadFile(file.handle,block.data(),DWORD(block.size()),&got,nullptr))throw std::runtime_error("media read failed");if(!got)break;if(BCryptHashData(hash.hash,block.data(),got,0)<0)throw std::runtime_error("content hash failed");hashed+=got;
   const auto now=std::chrono::steady_clock::now();if(now-progressAt>=std::chrono::milliseconds(500)){send({{"kind","progress"},{"phase","hashing"},{"progress",std::min(1.,double(hashed)/double(fileBytes))}});progressAt=now;}
  }
  if(hashed!=fileBytes)throw std::runtime_error("media changed during analysis");std::array<unsigned char,32> digest{};if(BCryptFinishHash(hash.hash,digest.data(),DWORD(digest.size()),0)<0)throw std::runtime_error("content hash failed");
  std::string sha;for(auto byte:digest){sha+="0123456789abcdef"[byte>>4];sha+="0123456789abcdef"[byte&15];}
  if(request.value("cachedSha256","")==sha){send({{"kind","complete"},{"cached",true},{"sha256",sha}});commitAck();return 0;}
  LARGE_INTEGER zero{};if(!SetFilePointerEx(file.handle,zero,nullptr,FILE_BEGIN))throw std::runtime_error("media seek failed");
  LockedVfs vfs;vfs.file=&file;vfs.callbacks.onOpen=openLocked;vfs.callbacks.onClose=[](ma_vfs*,ma_vfs_file){return MA_SUCCESS;};vfs.callbacks.onRead=readLocked;vfs.callbacks.onSeek=seekLocked;vfs.callbacks.onTell=tellLocked;vfs.callbacks.onInfo=infoLocked;
  AuralPcmDecoder source;if(source.initHandle(file.handle,&vfs)!=MA_SUCCESS)throw std::runtime_error("unsupported or damaged media");
  const uint32_t rate=source.outputSampleRate,channels=source.outputChannels;if(!rate||rate>1536000||!channels||channels>16||source.outputFormat!=ma_format_f32)throw std::runtime_error("unsupported media layout");
  const std::string backend=source.backend,codec=source.codecName;const json opusGain=source.opusGain.describe();
  const auto dsdConversion=auralDsdDescription(source.dsd);
  std::vector<float> samples(size_t(4096)*channels);
  // Decode to actual EOF, including codec-owned delay/padding handling. Never use container duration as an exact frame count.
  uint64_t length=0;progressAt=std::chrono::steady_clock::now()-std::chrono::seconds(1);
  send({{"kind","progress"},{"phase","decoding"},{"stage","measuring"},{"progress",0.}});
  while(true){ma_uint64 got=0;const auto result=source.read(samples.data(),4096,&got);
   if(got>4096||(result!=MA_SUCCESS&&result!=MA_AT_END)||!got&&result!=MA_AT_END)throw std::runtime_error("media decode incomplete");
   if(length>UINT64_MAX/8192-got)throw std::runtime_error("media length overflow");length+=got;
   const auto now=std::chrono::steady_clock::now();if(now-progressAt>=std::chrono::milliseconds(500)){
    LARGE_INTEGER where{};if(!SetFilePointerEx(file.handle,zero,&where,FILE_CURRENT)||where.QuadPart<0)throw std::runtime_error("media position unavailable");
    send({{"kind","progress"},{"phase","decoding"},{"stage","measuring"},{"progress",std::min(.39,.4*double(where.QuadPart)/double(fileBytes))}});progressAt=now;
   }
   if(result==MA_AT_END)break;
  }
  if(!length)throw std::runtime_error("empty decoded media");
  uint64_t start=0,end=length;
  if(request.contains("sampleRange")){
   const auto range=aural_sample_span::read(request.at("sampleRange"),rate);
   if(range.next||!request.at("startCueFrame").is_null()||!request.at("endCueFrame").is_null())throw std::runtime_error("analysis sample span conflicts with legacy CUE bounds");
   start=range.start;end=range.end;
  }else if(request.contains("startCueFrame")&&!request["startCueFrame"].is_null()){
   if(!cueToPcmFrame(integer(request,"startCueFrame"),rate,start))throw std::runtime_error("CUE span overflow");if(request.contains("endCueFrame")&&!request["endCueFrame"].is_null()&&!cueToPcmFrame(integer(request,"endCueFrame"),rate,end))throw std::runtime_error("CUE span overflow");
  }else{
   const double a=request.value("startSeconds",-1.),b=request.value("endSeconds",-1.);if(!std::isfinite(a)||a<0||a*rate>=double(UINT64_MAX)||!std::isfinite(b)||b>=0&&b*rate>=double(UINT64_MAX))throw std::runtime_error("invalid media span");start=uint64_t(a*rate);if(b>=0)end=uint64_t(b*rate);
  }
  if(start>=end||end>length||end-start>UINT64_MAX/8192||end>9007199254740991ull)throw std::runtime_error("media span outside source");
  const uint64_t count=end-start;size_t points=1;while(points<8192&&points*2<=count)points*=2;
  std::vector<std::array<float,2>> bins(points,{16.f,-16.f});
  // Reinitialize from the same locked handle. Sequential discard avoids container seek/PTS approximations in analysis.
  if(source.initHandle(file.handle,&vfs)!=MA_SUCCESS||source.outputSampleRate!=rate||source.outputChannels!=channels||source.outputFormat!=ma_format_f32||source.backend!=backend||source.codecName!=codec||auralDsdDescription(source.dsd)!=dsdConversion||source.opusGain.describe()!=opusGain)throw std::runtime_error("media decoder changed");
  uint64_t skipped=0;progressAt=std::chrono::steady_clock::now()-std::chrono::seconds(1);
  while(skipped<start){const auto wanted=std::min<uint64_t>(4096,start-skipped);ma_uint64 got=0;const auto result=source.read(samples.data(),wanted,&got);
   if(!got||got>wanted||(result!=MA_SUCCESS&&result!=MA_AT_END))throw std::runtime_error("media start incomplete");skipped+=got;
   const auto now=std::chrono::steady_clock::now();if(now-progressAt>=std::chrono::milliseconds(500)){send({{"kind","progress"},{"phase","decoding"},{"stage","positioning"},{"progress",.4+.6*double(skipped)/double(end)}});progressAt=now;}
  }
  uint64_t decoded=0,invalid=0;double squares=0;float peak=0;progressAt=std::chrono::steady_clock::now()-std::chrono::seconds(1);
  while(decoded<count){const auto wanted=std::min<uint64_t>(4096,count-decoded);ma_uint64 got=0;const auto result=source.read(samples.data(),wanted,&got);if(!got||got>wanted||(result!=MA_SUCCESS&&result!=MA_AT_END))throw std::runtime_error("media decode incomplete");
   for(uint64_t frame=0;frame<got;++frame){auto& bin=bins[size_t((decoded+frame)*points/count)];for(uint32_t ch=0;ch<channels;++ch){float value=samples[size_t(frame)*channels+ch];if(!std::isfinite(value)){value=0;++invalid;}else if(std::abs(value)>16){value=std::clamp(value,-16.f,16.f);++invalid;}bin[0]=std::min(bin[0],value);bin[1]=std::max(bin[1],value);peak=std::max(peak,std::abs(value));squares+=double(value)*value;}}
   decoded+=got;const auto now=std::chrono::steady_clock::now();if(now-progressAt>=std::chrono::milliseconds(500)){send({{"kind","progress"},{"phase","decoding"},{"stage","building"},{"progress",.4+.6*double(start+decoded)/double(end)}});progressAt=now;}
  }
  if(end==length){ma_uint64 extra=0;if(source.read(samples.data(),1,&extra)!=MA_AT_END||extra)throw std::runtime_error("decoded length changed");}
  json levels=json::array();size_t last=0;for(size_t target:{128,512,2048,8192}){target=std::min(target,points);if(target==last)continue;last=target;json values=json::array();for(size_t group=0;group<target;++group){float lo=16,hi=-16;for(size_t i=group*points/target;i<(group+1)*points/target;++i){lo=std::min(lo,bins[i][0]);hi=std::max(hi,bins[i][1]);}values.push_back({std::floor(lo*10000)/10000,std::ceil(hi*10000)/10000});}levels.push_back({{"points",target},{"values",values}});}
  const auto db=[](double value){return std::round(std::clamp(20*std::log10(std::max(value,0.0000158489)),-96.,24.)*100)/100;};
  send({{"kind","complete"},{"cached",false},{"sha256",sha},{"summary",{{"version",1},{"algorithm",algorithm},{"sha256",sha},{"decoder",{{"backend",backend},{"codec",codec},{"certification","pending"}}},{"dsdConversion",dsdConversion},{"sampleRate",rate},{"channels",channels},{"startFrame",std::to_string(start)},{"endFrame",std::to_string(end)},{"durationSeconds",double(count)/rate},{"peakDb",db(peak)},{"rmsDb",db(std::sqrt(squares/(double(count)*channels)))},{"invalidSamples",std::to_string(invalid)},{"levels",levels}}}});commitAck();return 0;
 }catch(...){try{send({{"kind","error"},{"message","音乐文件不可用、格式不支持、内容损坏或分析被中断"}});}catch(...){}return 2;}
}
