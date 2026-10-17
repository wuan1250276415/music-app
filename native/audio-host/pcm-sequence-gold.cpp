#define NOMINMAX
#define MA_NO_DEVICE_IO
#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include "pcm-sequence.hpp"
#include <bcrypt.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>

using json=nlohmann::json;
static void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
static std::vector<uint8_t> fileBytes(const std::filesystem::path& name,size_t limit){
 const auto size=std::filesystem::file_size(name);require(size<=limit,"gold file budget exceeded");std::vector<uint8_t> data(size);
 std::ifstream stream(name,std::ios::binary);require(!size||bool(stream.read(reinterpret_cast<char*>(data.data()),size)),"gold input read failed");return data;
}
static std::string digest(const std::vector<uint8_t>& data){
 BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;DWORD size=0,used=0;std::array<uint8_t,32> result{};
 require(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0,"gold hash unavailable");
 BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&used,0);std::vector<uint8_t> object(size);
 const bool ok=BCryptCreateHash(algorithm,&hash,object.data(),size,nullptr,0,0)>=0&&BCryptHashData(hash,const_cast<PUCHAR>(data.data()),ULONG(data.size()),0)>=0&&BCryptFinishHash(hash,result.data(),32,0)>=0;
 if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);require(ok,"gold hash failed");
 const char* hex="0123456789abcdef";std::string value;for(const auto b:result){value+=hex[b>>4];value+=hex[b&15];}return value;
}
int wmain(int argc,wchar_t** argv){
 try{
  require(argc==2,"expected one gold request path");const auto input=fileBytes(argv[1],1048576);const auto request=json::parse(input);
  std::vector<aural_sequence::Source> sources;
  for(const auto& item:request.at("sources")){
   const auto name=std::filesystem::u8path(item.at("file").get<std::string>());require(name.is_absolute(),"gold source must be absolute");
   sources.push_back({item.at("entryId").get<std::string>(),name.wstring(),item.at("start").get<uint64_t>(),item.at("end").get<uint64_t>(),item.value("expectedBinding",json(nullptr))});
  }
  std::atomic<bool> cancel{request.value("cancelBeforeOpen",false)};aural_sequence::PcmSequence sequence;
  const auto opened=sequence.open(sources,ma_format_f32,request.value("integer",false),&cancel);
  if(request.contains("expectOpenFailure")){
   require(opened==request.at("expectOpenFailure").get<int>(),"unexpected open result: "+std::to_string(opened));
   require(sequence.liveDecoders()==0,"failed open retained a decoder");
   std::cout<<json({{"completed",true},{"rejectedAt","open"},{"result",opened},{"reason",sequence.failure()},{"devicesOpened",0}}).dump()<<std::endl;return 0;
  }
  require(opened==MA_SUCCESS,"sequence open failed: "+std::to_string(opened)+" "+sequence.failure());
  unsigned verifiedReadLocks=0;
  if(request.value("verifyReadLocks",false))for(size_t i=0;i<std::min<size_t>(sources.size(),2);++i){
   const auto handle=CreateFileW(sources[i].path.c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
   const auto error=GetLastError();if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);
   require(handle==INVALID_HANDLE_VALUE&&error==ERROR_SHARING_VIOLATION,"active/preopened source did not deny a write handle");++verifiedReadLocks;
  }
  const auto frameBytes=sequence.bytesPerFrame();std::vector<uint8_t> block(8192*frameBytes),full;
  if(request.value("cancelAfterOpen",false))cancel=true;
  ma_result terminal=MA_SUCCESS;unsigned calls=0;size_t observedMaxLive=sequence.liveDecoders();const uint64_t deadline=GetTickCount64()+120000;
  const uint64_t chunks[]={1,257,4096,13,2048,997,8192};
  do{
   require(GetTickCount64()<deadline,"sequence gold deadline");ma_uint64 got=0;
   const auto count=chunks[calls++%7];terminal=sequence.read(block.data(),count,&got);
   observedMaxLive=std::max(observedMaxLive,sequence.liveDecoders());require(got<=count&&observedMaxLive<=2,"sequence read or live decoder bound exceeded");
   if(terminal!=MA_SUCCESS&&terminal!=MA_AT_END)break;
   require(full.size()+got*frameBytes<=64*1024*1024,"gold PCM budget exceeded");full.insert(full.end(),block.begin(),block.begin()+got*frameBytes);
  }while(terminal==MA_SUCCESS);
  if(request.contains("expectReadFailure")){
   require(terminal==request.at("expectReadFailure").get<int>(),"unexpected read result: "+std::to_string(terminal));
   ma_uint64 again=99;require(sequence.read(block.data(),1,&again)==terminal&&again==0,"decode failure did not remain terminal");
   std::cout<<json({{"completed",true},{"rejectedAt","read"},{"result",terminal},{"reason",sequence.failure()},{"acceptedPrefixFrames",full.size()/frameBytes},{"devicesOpened",0}}).dump()<<std::endl;return 0;
  }
  require(terminal==MA_AT_END,"sequence decode failed: "+std::to_string(terminal)+" "+sequence.failure());
  require(full.size()/frameBytes==sequence.length(),"sequence total length differs");
  ma_uint64 eof=99;require(sequence.read(block.data(),1,&eof)==MA_AT_END&&eof==0,"sequence repeated EOF is not stable");
  const auto opens=sequence.openedDecoders(),shared=sequence.sharedTransitions();
  // Independent composition: decode each whole physical source from its origin
  // using the production adapter, then crop and concatenate outside the sequence.
  std::map<std::wstring,std::vector<uint8_t>> physical;std::vector<uint8_t> reference;
  for(const auto& source:sources){
   auto found=physical.find(source.path);
   if(found==physical.end()){
    AuralPcmDecoder decoder;require(decoder.init(source.path,ma_format_f32,request.value("integer",false),&cancel,false)==MA_SUCCESS,"reference source open failed");
    require(decoder.outputFormat==sequence.format()&&decoder.outputChannels==sequence.channels()&&decoder.outputSampleRate==sequence.sampleRate(),"reference output format differs");
    std::vector<uint8_t> data;ma_result result=MA_SUCCESS;
    do{ma_uint64 got=0;result=decoder.read(block.data(),4096,&got);require(result==MA_SUCCESS||result==MA_AT_END,"reference decode failed");require(data.size()+got*frameBytes<=64*1024*1024,"reference budget exceeded");data.insert(data.end(),block.begin(),block.begin()+got*frameBytes);if(!got)break;}while(result==MA_SUCCESS);
    found=physical.emplace(source.path,std::move(data)).first;
   }
   require(source.end<=found->second.size()/frameBytes,"reference span exceeds source");
   reference.insert(reference.end(),found->second.begin()+source.start*frameBytes,found->second.begin()+source.end*frameBytes);
  }
  require(reference==full,"sequence differs from separately decoded and cropped sources");
  if(request.contains("reference"))require(fileBytes(std::filesystem::u8path(request.at("reference").get<std::string>()),64*1024*1024)==full,"sequence differs from independent original PCM");
  unsigned clockCases=0;json evidence=json::array();for(size_t i=0;i<sources.size();++i){const auto& span=sequence.spans()[i];require(!span.evidence.is_null(),"segment source evidence missing");
   for(const auto frame:{span.begin,span.end-1}){aural_sequence::Position position;require(sequence.locate(frame,position)&&position.segment==i&&position.itemFrame==frame-span.begin&&position.sourceFrame==sources[i].start+frame-span.begin&&!position.atEnd,"presented-clock segment boundary differs");++clockCases;}
   evidence.push_back({{"entryId",sources[i].entryId},{"begin",std::to_string(span.begin)},{"end",std::to_string(span.end)},{"source",span.evidence}});
  }
  aural_sequence::Position endPosition;require(sequence.locate(sequence.length(),endPosition)&&endPosition.atEnd&&endPosition.segment==sources.size()-1&&endPosition.sourceFrame==sources.back().end&&!sequence.locate(sequence.length()+1,endPosition),"EOF clock mapping differs");++clockCases;
  unsigned seekCases=0;
  for(const auto& value:request.value("seeks",json::array())){
   require(GetTickCount64()<deadline,"sequence seek deadline");const uint64_t frame=value.get<uint64_t>();
   require(sequence.seek(frame)==MA_SUCCESS,"sequence seek failed at "+std::to_string(frame)+": "+sequence.failure());
   const auto count=std::min<uint64_t>(257,sequence.length()-frame);ma_uint64 got=0;const auto result=sequence.read(block.data(),count,&got);
   require((result==MA_SUCCESS||result==MA_AT_END)&&got==count,"sequence seek read frame count differs");
   require(std::memcmp(block.data(),full.data()+frame*frameBytes,count*frameBytes)==0,"sequence seek samples differ at "+std::to_string(frame));
   observedMaxLive=std::max(observedMaxLive,sequence.liveDecoders());require(sequence.position()==frame+count&&observedMaxLive<=2,"sequence seek clock or resource bound differs");++seekCases;
  }
  bool replacementRejected=false;
  if(request.contains("replaceReleasedSource")){
   require(sources.front().path!=sources.back().path&&sequence.seek(sequence.length()-1)==MA_SUCCESS,"replacement fixture must release the first source");
   const auto replacement=std::filesystem::u8path(request.at("replaceReleasedSource").get<std::string>());
   std::filesystem::remove(std::filesystem::path(sources.front().path));std::filesystem::copy_file(replacement,std::filesystem::path(sources.front().path));
   require(sequence.seek(0)==MA_INVALID_DATA,"replaced historical source was accepted");replacementRejected=true;
  }
  const char* format=sequence.format()==ma_format_s16?"s16":sequence.format()==ma_format_s32?"s32":"f32";
  json result={{"version",1},{"completed",true},{"segments",sources.size()},{"frames",std::to_string(full.size()/frameBytes)},
   {"sampleRate",sequence.sampleRate()},{"channels",sequence.channels()},{"format",format},{"decodedSha256",digest(full)},
   {"sequentialOpens",opens},{"sharedCueTransitions",shared},{"seekCases",seekCases},{"clockMappingCases",clockCases},{"sourceEvidence",evidence},
   {"independentPcmReference",request.contains("reference")},{"replacementRejected",replacementRejected},{"observedMaxLiveDecoders",observedMaxLive},
   {"devicesOpened",0},{"hardwareVerified",false},{"audioHostIntegrated",false},{"verifiedReadOnlyLocks",verifiedReadLocks}};
  sequence.close();
  if(verifiedReadLocks)for(size_t i=0;i<std::min<size_t>(sources.size(),2);++i){
   const auto handle=CreateFileW(sources[i].path.c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
   require(handle!=INVALID_HANDLE_VALUE,"closed sequence retained a source lock");CloseHandle(handle);
  }
  std::cout<<result.dump()<<std::endl;
  return 0;
 }catch(const std::exception& error){std::cout<<json({{"version",1},{"completed",false},{"error",error.what()}}).dump()<<std::endl;return 2;}
}
