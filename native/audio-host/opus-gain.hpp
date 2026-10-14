#pragma once
#include <windows.h>
#include <array>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>
#include <utility>
#include "vendor/json.hpp"
namespace aural_opus {
using Json=nlohmann::json;
struct Info {
 bool present=false;int header=0,track=0,album=0,index=0;uint32_t serial=0,pages=0,tagBytes=0;
 std::string trackStatus="missing",albumStatus="missing";bool legacyPresent=false;
 Json legacy={{"source","file-tags"},{"trackGainDb",nullptr},{"albumGainDb",nullptr},{"trackPeak",nullptr},{"albumPeak",nullptr}};
 Json describe()const{
  if(!present)return nullptr;
  return {{"version",1},{"headerGainQ78",header},{"r128TrackQ78",trackStatus=="valid"?Json(track):Json(nullptr)},{"r128AlbumQ78",albumStatus=="valid"?Json(album):Json(nullptr)},{"r128TrackStatus",trackStatus},{"r128AlbumStatus",albumStatus},{"legacyTags",legacy},{"legacyPresent",legacyPresent},{"decoder","ffmpeg-native-opus"},{"headerApplied",true},{"referenceLUFS",-23},{"packetValidation","ogg-crc-and-opushead-match"},{"streamIndex",index},{"streamSerial",serial},{"pageCount",pages},{"tagBytes",tagBytes},{"hardwareVerified",false}};
 }
};
inline uint32_t u32(const uint8_t* p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
inline int signed16(const uint8_t* p){const uint32_t value=uint32_t(p[0])|(uint32_t(p[1])<<8);return value>=32768?int(value)-65536:int(value);}
inline bool named(const uint8_t* p,size_t size,const char* name){
 if(size!=std::strlen(name))return false;for(size_t i=0;i<size;++i){const auto c=p[i]>='a'&&p[i]<='z'?p[i]-32:p[i];if(c!=uint8_t(name[i]))return false;}return true;
}
inline bool q78(const uint8_t* p,size_t size,int& result){
 if(!size||size>6)return false;size_t i=0;bool negative=false;if(p[i]=='+'||p[i]=='-'){negative=p[i]=='-';if(++i==size)return false;}
 int value=0;for(;i<size;++i){if(p[i]<'0'||p[i]>'9')return false;value=value*10+p[i]-'0';if(value>32768)return false;}
 result=negative?-value:value;return result>=-32768&&result<=32767;
}
inline Json legacyNumber(const uint8_t* p,size_t size,bool peak){
 if(!size||size>80)return nullptr;
 for(size_t i=0;i<size;++i)if(p[i]<32&&p[i]!='\t'||p[i]>126||p[i]==';')return nullptr;
 std::string text(reinterpret_cast<const char*>(p),size);char* end=nullptr;const double value=std::strtod(text.c_str(),&end);
 // Accept decimal gain/peak text only. strtod alone also accepts hexadecimal and exponents.
 size_t i=0;while(i<size&&(p[i]==' '||p[i]=='\t'))++i;if(i<size&&(p[i]=='+'||p[i]=='-'))++i;
 bool digits=false;while(i<size&&p[i]>='0'&&p[i]<='9'){digits=true;++i;}
 if(i<size&&p[i]=='.'){++i;while(i<size&&p[i]>='0'&&p[i]<='9'){digits=true;++i;}}
 if(!digits||text.c_str()+i!=end)return nullptr;
 if(end==text.c_str()||!std::isfinite(value)||value<(peak?0:-60)||value>(peak?64:60)||peak&&value==0)return nullptr;
 while(*end==' '||*end=='\t')++end;
 if(!peak&&(end[0]=='d'||end[0]=='D')&&(end[1]=='b'||end[1]=='B')){end+=2;while(*end==' '||*end=='\t')++end;}
 if(*end)return nullptr;return value;
}
inline bool comments(const std::vector<uint8_t>& packet,Info& info){
 if(packet.size()<16||std::memcmp(packet.data(),"OpusTags",8))return false;
 size_t position=8;const auto vendor=u32(packet.data()+position);position+=4;
 if(vendor>packet.size()-position||packet.size()-position-vendor<4)return false;position+=vendor;
 const auto count=u32(packet.data()+position);position+=4;if(count>65536)return false;
 std::array<bool,6> seen{};const char* keys[]={"R128_TRACK_GAIN","R128_ALBUM_GAIN","REPLAYGAIN_TRACK_GAIN","REPLAYGAIN_ALBUM_GAIN","REPLAYGAIN_TRACK_PEAK","REPLAYGAIN_ALBUM_PEAK"};
 const char* legacyKeys[]={"trackGainDb","albumGainDb","trackPeak","albumPeak"};
 for(uint32_t i=0;i<count;++i){
  if(packet.size()-position<4)return false;const auto length=u32(packet.data()+position);position+=4;
  if(length>packet.size()-position)return false;const uint8_t* value=packet.data()+position;position+=length;
  size_t equals=0;while(equals<length&&value[equals]!='=')++equals;if(equals==length)continue;
  for(size_t key=0;key<6;++key)if(named(value,equals,keys[key])){
   const auto* raw=value+equals+1;const size_t rawSize=length-equals-1;
   if(key<2){auto& status=key==0?info.trackStatus:info.albumStatus;auto& number=key==0?info.track:info.album;status=!seen[key]&&q78(raw,rawSize,number)?"valid":"invalid";}
   else{info.legacyPresent=true;info.legacy[legacyKeys[key-2]]=seen[key]?Json(nullptr):legacyNumber(raw,rawSize,key>=4);}
   seen[key]=true;break;
  }
 }
 // RFC permits trailing padding or preserved binary data after the comment list.
 info.tagBytes=static_cast<uint32_t>(packet.size());return true;
}
inline uint32_t crc(const std::vector<uint8_t>& page){
 static const auto table=[](){std::array<uint32_t,256> result{};for(uint32_t i=0;i<256;++i){uint32_t value=i<<24;for(int bit=0;bit<8;++bit)value=value&0x80000000?(value<<1)^0x04c11db7:value<<1;result[i]=value;}return result;}();
 uint32_t value=0;for(size_t i=0;i<page.size();++i){const uint8_t byte=i>=22&&i<26?0:page[i];value=(value<<8)^table[(value>>24)^byte];}return value;
}
struct PositionGuard {
 HANDLE file;LARGE_INTEGER previous{};bool ready=false,restored=false;
 explicit PositionGuard(HANDLE value):file(value){LARGE_INTEGER zero{};ready=SetFilePointerEx(file,zero,&previous,FILE_CURRENT)!=FALSE;}
 bool restore(){if(!ready)return false;if(restored)return true;restored=SetFilePointerEx(file,previous,nullptr,FILE_BEGIN)!=FALSE;return restored;}
 ~PositionGuard(){restore();}
};
// FFmpeg's Ogg demuxer supplies the page start in AVPacket.pos. Bind audio packets
// to the original serial too, including chains with identical head/comment bytes.
template<class Cancel>
inline bool samePageStream(HANDLE file,int64_t position,uint32_t serial,Cancel cancelled){
 if(position<0||cancelled())return false;PositionGuard guard(file);LARGE_INTEGER where{};where.QuadPart=position;
 if(!guard.ready||!SetFilePointerEx(file,where,nullptr,FILE_BEGIN))return false;
 const auto exact=[&](uint8_t* target,size_t count){size_t done=0;while(done<count){if(cancelled())return false;DWORD got=0;if(!ReadFile(file,target+done,static_cast<DWORD>(std::min<size_t>(count-done,32768)),&got,nullptr)||!got)return false;done+=got;}return true;};
 std::vector<uint8_t> page(27);if(!exact(page.data(),27)||std::memcmp(page.data(),"OggS",4)||page[4]!=0||(page[5]&~7)||u32(page.data()+14)!=serial)return false;
 const auto segments=page[26];page.resize(27+segments);if(!exact(page.data()+27,segments))return false;
 size_t payload=0;for(unsigned i=0;i<segments;++i)payload+=page[27+i];page.resize(27+segments+payload);
 return exact(page.data()+27+segments,payload)&&crc(page)==u32(page.data()+22)&&guard.restore()&&!cancelled();
}
template<class Cancel>
inline bool read(HANDLE file,int selected,const uint8_t* expected,size_t expectedSize,Info& result,Cancel cancelled){
 constexpr size_t MAX_PREFIX=32u*1024*1024,MAX_PACKET=16u*1024*1024;
 if(selected<0||selected>=16||!expected||expectedSize<19||expectedSize>65536||std::memcmp(expected,"OpusHead",8)||(expected[8]&0xf0))return false;
 PositionGuard guard(file);LARGE_INTEGER zero{};if(!guard.ready||!SetFilePointerEx(file,zero,nullptr,FILE_BEGIN))return false;
 size_t bytes=0;const auto exact=[&](uint8_t* target,size_t count)->bool{
  if(count>MAX_PREFIX-bytes)return false;size_t done=0;
  while(done<count){if(cancelled())return false;DWORD got=0;if(!ReadFile(file,target+done,static_cast<DWORD>(std::min<size_t>(count-done,32768)),&got,nullptr)||!got)return false;done+=got;bytes+=got;}return true;
 };
 struct Stream{uint32_t serial=0,sequence=0;bool continuing=false,ended=false;};
 std::array<Stream,16> streams{};size_t streamCount=0;std::vector<uint8_t> packet;unsigned packets=0;
 Info observed;observed.index=selected;observed.header=signed16(expected+16);
 for(unsigned pageCount=0;pageCount<4096;++pageCount){
  std::vector<uint8_t> page(27);if(!exact(page.data(),27)||std::memcmp(page.data(),"OggS",4)||page[4]!=0||(page[5]&~7))return false;
  const unsigned segments=page[26];page.resize(27+segments);if(!exact(page.data()+27,segments))return false;
  size_t payload=0;for(unsigned i=0;i<segments;++i)payload+=page[27+i];page.resize(27+segments+payload);if(!exact(page.data()+27+segments,payload)||crc(page)!=u32(page.data()+22))return false;
  const auto serial=u32(page.data()+14),sequence=u32(page.data()+18);size_t index=0;while(index<streamCount&&streams[index].serial!=serial)++index;
  if(index==streamCount){if(streamCount>=16||!(page[5]&2)||sequence!=0||(page[5]&1))return false;streams[streamCount++].serial=serial;}
  else if((page[5]&2)||streams[index].ended||sequence!=streams[index].sequence+1)return false;
  auto& stream=streams[index];if(bool(page[5]&1)!=stream.continuing)return false;stream.sequence=sequence;stream.ended=bool(page[5]&4);
  size_t offset=27+segments;
  for(unsigned segment=0;segment<segments;++segment){
   const size_t length=page[27+segment];
   if(index==static_cast<size_t>(selected)){
    if(length>MAX_PACKET-packet.size())return false;packet.insert(packet.end(),page.begin()+offset,page.begin()+offset+length);
    if(length<255){
     if(packets==0){if(packet.size()!=expectedSize||std::memcmp(packet.data(),expected,expectedSize))return false;}
     else if(packets==1){if(!comments(packet,observed))return false;observed.present=true;observed.serial=serial;observed.pages=pageCount+1;if(!guard.restore()||cancelled())return false;result=std::move(observed);return true;}
     ++packets;packet.clear();
    }
   }
   offset+=length;stream.continuing=length==255;
  }
  if(stream.ended&&stream.continuing)return false;
 }
 return false;
}
}
