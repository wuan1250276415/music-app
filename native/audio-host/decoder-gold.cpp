#define NOMINMAX
#define MA_NO_DEVICE_IO
#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include "vendor/json.hpp"
#include "ffmpeg-decoder.hpp"
#include <bcrypt.h>
#include <filesystem>
#include <fstream>
#include <iostream>

using json=nlohmann::json;
static std::vector<uint8_t> bytes(const std::filesystem::path& file,size_t limit){
 const auto size=std::filesystem::file_size(file);if(size>limit)throw std::runtime_error("gold input exceeds byte budget");
 std::vector<uint8_t> data(size);std::ifstream stream(file,std::ios::binary);if(size&&!stream.read(reinterpret_cast<char*>(data.data()),size))throw std::runtime_error("gold input read failed");return data;
}
static std::string digest(const std::vector<uint8_t>& data){
 BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;DWORD size=0,used=0;std::array<uint8_t,32> result{};
 if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)throw std::runtime_error("gold hash unavailable");
 BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&used,0);std::vector<uint8_t> object(size);
 const bool ok=BCryptCreateHash(algorithm,&hash,object.data(),size,nullptr,0,0)>=0&&BCryptHashData(hash,const_cast<PUCHAR>(data.data()),ULONG(data.size()),0)>=0&&BCryptFinishHash(hash,result.data(),32,0)>=0;
 if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);if(!ok)throw std::runtime_error("gold hash failed");
 const char* alphabet="0123456789abcdef";std::string out;for(auto b:result){out+=alphabet[b>>4];out+=alphabet[b&15];}return out;
}
int wmain(int argc,wchar_t** argv){
 try{
  if(argc!=2)throw std::runtime_error("expected one gold request path");const auto input=bytes(argv[1],65536);const json request=json::parse(input);
  const auto file=std::filesystem::u8path(request.at("file").get<std::string>());if(!file.is_absolute())throw std::runtime_error("gold file must be absolute");
  AuralPcmDecoder decoder;std::atomic<bool> cancelled{false};const auto opened=decoder.init(file.wstring(),ma_format_f32,request.value("integer",false),&cancelled,false);
  if(opened!=MA_SUCCESS)throw std::runtime_error("decoder open failed: "+std::to_string(opened)+" "+decoder.failureReason);
  if(decoder.outputSampleRate!=request.at("sampleRate").get<unsigned>()||decoder.outputChannels!=request.at("channels").get<unsigned>()||decoder.codecName!=request.at("codec").get<std::string>())throw std::runtime_error("actual decoder identity differs from requested gold case");
  const size_t frameBytes=decoder.outputChannels*ma_get_bytes_per_sample(decoder.outputFormat);if(!frameBytes||frameBytes>64)throw std::runtime_error("gold frame size unsupported");
  const uint64_t deadline=GetTickCount64()+60000;std::vector<uint8_t> full,scratch(4096*frameBytes);uint64_t frames=0;size_t turn=0;
  const std::array<uint64_t,6> sizes{{1,17,4096,511,1023,73}};
  for(;;){if(GetTickCount64()>deadline)throw std::runtime_error("gold decode deadline");ma_uint64 got=0;const auto rc=decoder.read(scratch.data(),sizes[turn++%sizes.size()],&got);if((rc!=MA_SUCCESS&&rc!=MA_AT_END)||got>4096)throw std::runtime_error("sequential decoder failed: "+std::to_string(rc));if(full.size()+got*frameBytes>64*1024*1024)throw std::runtime_error("decoded gold exceeds budget");full.insert(full.end(),scratch.begin(),scratch.begin()+size_t(got)*frameBytes);frames+=got;if(rc==MA_AT_END||!got)break;}
  if(!frames)throw std::runtime_error("empty gold decode");
  if(request.contains("reference")){const auto reference=bytes(std::filesystem::u8path(request.at("reference").get<std::string>()),64*1024*1024);if(reference!=full)throw std::runtime_error("lossless samples differ from independently generated PCM reference");}
  if(request.contains("frames")&&frames!=request.at("frames").get<uint64_t>())throw std::runtime_error("decoded frame count differs from known source duration");
  std::vector<uint64_t> targets{0,1,17,1023,1024,4095,decoder.outputSampleRate-1,decoder.outputSampleRate,frames/2,frames-1,0};
  uint32_t seed=0x7f4a7c15;for(unsigned i=0;i<24;i++){seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;targets.push_back(seed%frames);}
  double maximumError=0;unsigned seeks=0;const double tolerance=request.value("seekTolerance",0.0);
  for(const auto target:targets){if(target>=frames)continue;if(GetTickCount64()>deadline)throw std::runtime_error("gold seek deadline");const auto rc=decoder.seek(target);if(rc!=MA_SUCCESS)throw std::runtime_error("seek failed at "+std::to_string(target)+": "+std::to_string(rc));const uint64_t wanted=std::min<uint64_t>(257,frames-target);ma_uint64 got=0;const auto read=decoder.read(scratch.data(),wanted,&got);if((read!=MA_SUCCESS&&read!=MA_AT_END)||got!=wanted)throw std::runtime_error("seek returned wrong frame count at "+std::to_string(target));const auto* baseline=full.data()+target*frameBytes;
   if(decoder.outputFormat==ma_format_f32){for(size_t i=0;i<got*decoder.outputChannels;i++){float actual=0,expected=0;std::memcpy(&actual,scratch.data()+i*4,4);std::memcpy(&expected,baseline+i*4,4);const auto error=std::abs(double(actual)-expected);if(!std::isfinite(actual)||error>tolerance)throw std::runtime_error("seek sample mismatch at "+std::to_string(target)+" delta="+std::to_string(error));maximumError=std::max(maximumError,error);}}
   else if(std::memcmp(baseline,scratch.data(),got*frameBytes))throw std::runtime_error("integer seek sample mismatch at "+std::to_string(target));seeks++;
  }
  const char* format=decoder.outputFormat==ma_format_s16?"s16":decoder.outputFormat==ma_format_s32?"s32":"f32";
  std::cout<<json({{"version",1},{"completed",true},{"backend",decoder.backend},{"codec",decoder.codecName},{"container",decoder.containerEvidence()},{"sampleRate",decoder.outputSampleRate},{"channels",decoder.outputChannels},{"format",format},{"media",decoder.sourceEvidence()},{"frames",std::to_string(frames)},{"decodedSha256",digest(full)},{"seekCases",seeks},{"maxSeekError",maximumError},{"seekTolerance",tolerance},{"independentReference",request.contains("reference")},{"hardwareVerified",false},{"crossFileGaplessVerified",false}}).dump()<<std::endl;
  return 0;
 }catch(const std::exception& error){std::cout<<json({{"version",1},{"completed",false},{"error",error.what()}}).dump()<<std::endl;return 2;}
}
