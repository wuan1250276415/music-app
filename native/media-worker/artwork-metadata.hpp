#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace artwork_metadata {
constexpr size_t maxExifBytes=256U*1024,maxProfileBytes=1024U*1024;
struct Exif {unsigned orientation=1,colorSpace=0;bool embeddedIcc=false;};
inline uint16_t word(const unsigned char* p,bool little){return little?uint16_t(p[0])|(uint16_t(p[1])<<8):(uint16_t(p[0])<<8)|p[1];}
inline uint32_t integer(const unsigned char* p,bool little){return little?uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24):(uint32_t(p[0])<<24)|(uint32_t(p[1])<<16)|(uint32_t(p[2])<<8)|p[3];}
inline bool exif(const unsigned char* bytes,size_t size,Exif& result){
 if(!bytes||size>maxExifBytes)return false;
 if(size>=6&&std::memcmp(bytes,"Exif\0\0",6)==0){bytes+=6;size-=6;}
 if(size<8)return false;
 const bool little=bytes[0]=='I'&&bytes[1]=='I';if(!little&&!(bytes[0]=='M'&&bytes[1]=='M'))return false;
 if(word(bytes+2,little)!=42)return false;
 const uint32_t root=integer(bytes+4,little);uint32_t sub=0;bool seenOrientation=false,seenSub=false,seenColor=false;
 const auto directory=[&](uint32_t offset,bool primary)->bool{
  if(offset<8||offset>size||size-offset<2)return false;
  const size_t count=word(bytes+offset,little);if(count>1024||size-offset-2<count*12+4)return false;
  for(size_t i=0;i<count;i++){
   const unsigned char* entry=bytes+offset+2+i*12;const unsigned tag=word(entry,little);
   if(primary&&tag==274){
    if(seenOrientation||word(entry+2,little)!=3||integer(entry+4,little)!=1)return false;seenOrientation=true;
    result.orientation=word(entry+8,little);if(result.orientation<1||result.orientation>8)return false;
   }else if(primary&&tag==34665){
    if(seenSub||word(entry+2,little)!=4||integer(entry+4,little)!=1)return false;seenSub=true;sub=integer(entry+8,little);
   }else if(!primary&&tag==40961){
    if(seenColor||word(entry+2,little)!=3||integer(entry+4,little)!=1)return false;seenColor=true;
    result.colorSpace=word(entry+8,little);if(result.colorSpace!=1&&result.colorSpace!=2&&result.colorSpace!=65535)return false;
   }
  }
  return true;
 };
 // Only the root and its one EXIF subdirectory; never follow thumbnail/MakerNote chains.
 return directory(root,true)&&(!seenSub||sub!=root&&directory(sub,false));
}
inline bool jpegExif(const unsigned char* bytes,size_t size,Exif& result){
 if(size<2||bytes[0]!=255||bytes[1]!=216)return false;size_t offset=2,segments=0;bool found=false;
 while(offset<size&&segments++<2048){
  if(bytes[offset++]!=255)return false;while(offset<size&&bytes[offset]==255)offset++;
  if(offset==size)return false;const unsigned marker=bytes[offset++];
  if(marker==218||marker==217)return true;
  if(marker==0||marker==216)return false;if(marker==1||(marker>=208&&marker<=215))continue;
  if(size-offset<2)return false;const size_t length=word(bytes+offset,false);if(length<2||length>size-offset)return false;
  if(marker==225&&length>=8&&std::memcmp(bytes+offset+2,"Exif\0\0",6)==0){if(found||!exif(bytes+offset+2,length-2,result))return false;found=true;}
  if(marker==226&&length>=14&&std::memcmp(bytes+offset+2,"ICC_PROFILE\0",12)==0)result.embeddedIcc=true;
  offset+=length;
 }
 return false;
}
inline bool pngExif(const unsigned char* bytes,size_t size,Exif& result){
 static const unsigned char signature[8]={137,80,78,71,13,10,26,10};if(size<8||std::memcmp(bytes,signature,8))return false;
 size_t offset=8,chunks=0;bool found=false;
 while(size-offset>=12&&chunks++<4096){
  const size_t length=integer(bytes+offset,false);if(length>size-offset-12)return false;
  if(std::memcmp(bytes+offset+4,"eXIf",4)==0){
   if(found||!exif(bytes+offset+8,length,result))return false;found=true;
   uint32_t crc=0xffffffffU;for(size_t i=0;i<length+4;i++){crc^=bytes[offset+4+i];for(unsigned bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1)?0xedb88320U:0U);}
   if((crc^0xffffffffU)!=integer(bytes+offset+8+length,false))return false;
  }
  if(std::memcmp(bytes+offset+4,"iCCP",4)==0)result.embeddedIcc=true;
  if(std::memcmp(bytes+offset+4,"IEND",4)==0)return length==0&&offset+12==size;
  offset+=length+12;
 }
 return false;
}
enum class ProfileSpace {rgb,gray,cmyk};
inline bool profile(const unsigned char* bytes,size_t size,ProfileSpace& space){
 if(!bytes||size<132||size>maxProfileBytes||integer(bytes,false)!=size||std::memcmp(bytes+36,"acsp",4))return false;
 if(std::memcmp(bytes+16,"RGB ",4)==0)space=ProfileSpace::rgb;
 else if(std::memcmp(bytes+16,"GRAY",4)==0)space=ProfileSpace::gray;
 else if(std::memcmp(bytes+16,"CMYK",4)==0)space=ProfileSpace::cmyk;else return false;
 const size_t count=integer(bytes+128,false);if(count>1024||count>(size-132)/12)return false;
 for(size_t i=0;i<count;i++){const auto* tag=bytes+132+i*12;const size_t start=integer(tag+4,false),length=integer(tag+8,false);if(start>size||length>size-start)return false;}
 return true; // Structural bounds only; Windows color management validates profile semantics.
}
}
