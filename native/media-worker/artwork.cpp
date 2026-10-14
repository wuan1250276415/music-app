#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincodec.h>
#include <objidl.h>
#include <oleauto.h>
#include <vector>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <webp/decode.h>
#include <webp/demux.h>
#include "artwork-metadata.hpp"

template<class T> struct Com {
 T* value=nullptr; ~Com(){if(value)value->Release();}
 Com()=default;Com(const Com&)=delete;Com& operator=(const Com&)=delete;
 T** put(){return &value;} T* operator->(){return value;}
};
struct Apartment {HRESULT result=CoInitializeEx(nullptr,COINIT_MULTITHREADED);~Apartment(){if(SUCCEEDED(result))CoUninitialize();}};
static bool exactRead(HANDLE handle,unsigned char* bytes,DWORD length){DWORD offset=0;while(offset<length){DWORD got=0;if(!ReadFile(handle,bytes+offset,length-offset,&got,nullptr)||!got)return false;offset+=got;}return true;}
static bool exactWrite(HANDLE handle,const unsigned char* bytes,DWORD length){DWORD offset=0;while(offset<length){DWORD sent=0;if(!WriteFile(handle,bytes+offset,length-offset,&sent,nullptr)||!sent)return false;offset+=sent;}return true;}
static uint32_t u32(const unsigned char* p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
static void put32(unsigned char* p,uint32_t n){for(int i=0;i<4;i++)p[i]=static_cast<unsigned char>(n>>(i*8));}
static bool dimensions(uint32_t width,uint32_t height){return width&&height&&width<=8192&&height<=8192&&uint64_t(width)*height<=32ULL*1024*1024;}
struct WebpAnimation {WebPAnimDecoder* value=nullptr;~WebpAnimation(){if(value)WebPAnimDecoderDelete(value);}};
struct WebpOutput {WebPDecoderConfig config{};~WebpOutput(){WebPFreeDecBuffer(&config.output);}};
struct WebpDemux {WebPDemuxer* value=nullptr;~WebpDemux(){if(value)WebPDemuxDelete(value);}};
struct WebpChunk {WebPChunkIterator iterator{};bool found=false;~WebpChunk(){if(found)WebPDemuxReleaseChunkIterator(&iterator);}};
static bool webpMetadata(IWICImagingFactory* factory,const std::vector<unsigned char>& input,artwork_metadata::Exif& exif,Com<IWICColorContext>& profile,artwork_metadata::ProfileSpace& space){
 const WebPData data={input.data(),input.size()};WebpDemux demux;demux.value=WebPDemux(&data);if(!demux.value)return false;
 WebpChunk metadata;metadata.found=WebPDemuxGetChunk(demux.value,"EXIF",1,&metadata.iterator)!=0;
 if(metadata.found&&(metadata.iterator.num_chunks!=1||!artwork_metadata::exif(metadata.iterator.chunk.bytes,metadata.iterator.chunk.size,exif)))return false;
 WebpChunk icc;icc.found=WebPDemuxGetChunk(demux.value,"ICCP",1,&icc.iterator)!=0;
 const uint32_t flags=WebPDemuxGetI(demux.value,WEBP_FF_FORMAT_FLAGS);
 if(bool(flags&EXIF_FLAG)!=metadata.found||bool(flags&ICCP_FLAG)!=icc.found)return false;
 if(icc.found){
  if(icc.iterator.num_chunks!=1||!artwork_metadata::profile(icc.iterator.chunk.bytes,icc.iterator.chunk.size,space)||space!=artwork_metadata::ProfileSpace::rgb)return false;
  if(FAILED(factory->CreateColorContext(profile.put()))||FAILED(profile->InitializeFromMemory(icc.iterator.chunk.bytes,UINT(icc.iterator.chunk.size))))return false;
 }
 return true;
}
static bool frameProfile(IWICImagingFactory* factory,IWICBitmapFrameDecode* frame,Com<IWICColorContext>& profile,artwork_metadata::ProfileSpace& space){
 UINT count=0;HRESULT status=frame->GetColorContexts(0,nullptr,&count);
 if(status==WINCODEC_ERR_UNSUPPORTEDOPERATION)return true;if(FAILED(status)||count>4)return false;if(!count)return true;
 Com<IWICColorContext> contexts[4];IWICColorContext* pointers[4]{};
 for(UINT i=0;i<count;i++){if(FAILED(factory->CreateColorContext(contexts[i].put())))return false;pointers[i]=contexts[i].value;}
 UINT actual=0;if(FAILED(frame->GetColorContexts(count,pointers,&actual))||actual!=count)return false;
 int selected=-1;
 for(UINT i=0;i<count;i++){
  WICColorContextType type=WICColorContextUninitialized;if(FAILED(contexts[i]->GetType(&type)))return false;
  if(type==WICColorContextProfile){
   UINT bytes=0;if(FAILED(contexts[i]->GetProfileBytes(0,nullptr,&bytes))||bytes<132||bytes>artwork_metadata::maxProfileBytes)return false;
   std::vector<unsigned char> payload(bytes);UINT read=0;artwork_metadata::ProfileSpace candidate;
   if(FAILED(contexts[i]->GetProfileBytes(bytes,payload.data(),&read))||read!=bytes||!artwork_metadata::profile(payload.data(),payload.size(),candidate))return false;
   if(selected>=0)return false;selected=int(i);space=candidate;
  }
 }
 if(selected>=0){profile.value=contexts[selected].value;profile.value->AddRef();return true;}
 // ICC takes precedence; select a supported EXIF context only if no ICC exists.
 for(UINT i=0;i<count;i++){
  WICColorContextType type=WICColorContextUninitialized;if(FAILED(contexts[i]->GetType(&type)))return false;
  if(type==WICColorContextExifColorSpace){UINT value=0;if(FAILED(contexts[i]->GetExifColorSpace(&value)))return false;if(value==1||value==2){profile.value=contexts[i].value;profile.value->AddRef();space=artwork_metadata::ProfileSpace::rgb;return true;}}
 }
 return true;
}
static bool webpBitmap(IWICImagingFactory* factory,const std::vector<unsigned char>& input,UINT edge,IWICBitmap** bitmap){
 WebpOutput decoded;if(!WebPInitDecoderConfig(&decoded.config)||WebPGetFeatures(input.data(),input.size(),&decoded.config.input)!=VP8_STATUS_OK)return false;
 const auto& features=decoded.config.input;if(!dimensions(features.width,features.height))return false;
 if(features.has_animation){
  WebPAnimDecoderOptions options;if(!WebPAnimDecoderOptionsInit(&options))return false;options.color_mode=MODE_BGRA;options.use_threads=0;
  const WebPData data={input.data(),input.size()};WebpAnimation animation;animation.value=WebPAnimDecoderNew(&data,&options);if(!animation.value)return false;
  WebPAnimInfo info{};if(!WebPAnimDecoderGetInfo(animation.value,&info)||!dimensions(info.canvas_width,info.canvas_height)||info.canvas_width!=UINT(features.width)||info.canvas_height!=UINT(features.height))return false;
  unsigned char* pixels=nullptr;int timestamp=0;if(!WebPAnimDecoderGetNext(animation.value,&pixels,&timestamp)||!pixels)return false;
  return SUCCEEDED(factory->CreateBitmapFromMemory(info.canvas_width,info.canvas_height,GUID_WICPixelFormat32bppBGRA,info.canvas_width*4,info.canvas_width*info.canvas_height*4,pixels,bitmap));
 }
 const double ratio=std::min(1.0,std::min(double(edge)/features.width,double(edge)/features.height));
 const UINT width=std::max(1U,UINT(features.width*ratio)),height=std::max(1U,UINT(features.height*ratio));
 std::vector<unsigned char> pixels(size_t(width)*height*4);
 decoded.config.options.use_scaling=1;decoded.config.options.scaled_width=width;decoded.config.options.scaled_height=height;decoded.config.options.use_threads=0;
 decoded.config.output.colorspace=MODE_BGRA;decoded.config.output.is_external_memory=1;decoded.config.output.u.RGBA.rgba=pixels.data();decoded.config.output.u.RGBA.stride=width*4;decoded.config.output.u.RGBA.size=pixels.size();
 if(WebPDecode(input.data(),input.size(),&decoded.config)!=VP8_STATUS_OK)return false;
 return SUCCEEDED(factory->CreateBitmapFromMemory(width,height,GUID_WICPixelFormat32bppBGRA,width*4,UINT(pixels.size()),pixels.data(),bitmap));
}

// Fixed binary stdin/stdout only; no paths, shell, network or output files.
int convertArtwork(){
 try{
  unsigned char inputHeader[8];if(!exactRead(GetStdHandle(STD_INPUT_HANDLE),inputHeader,8))return 80;
  const uint32_t size=u32(inputHeader),edge=u32(inputHeader+4);
  if(!size||size>16U*1024*1024||(edge!=256&&edge!=1024))return 80;
  std::vector<unsigned char> input(size);if(!exactRead(GetStdHandle(STD_INPUT_HANDLE),input.data(),size))return 80;
  unsigned char extra;DWORD got=0;if(ReadFile(GetStdHandle(STD_INPUT_HANDLE),&extra,1,&got,nullptr)&&got)return 80;
  Apartment apartment;if(FAILED(apartment.result))return 81;
  Com<IWICImagingFactory> factory;
  if(FAILED(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(factory.put()))))return 81;
  Com<IWICStream> stream;Com<IWICBitmapDecoder> decoder;Com<IWICBitmapFrameDecode> frame;
  const bool webp=input.size()>=12&&std::memcmp(input.data(),"RIFF",4)==0&&std::memcmp(input.data()+8,"WEBP",4)==0;
  Com<IWICBitmap> webpSource;IWICBitmapSource* source=nullptr;
  artwork_metadata::Exif metadata;artwork_metadata::ProfileSpace profileSpace=artwork_metadata::ProfileSpace::rgb;Com<IWICColorContext> sourceProfile;
  if(webp){if(!webpMetadata(factory.value,input,metadata,sourceProfile,profileSpace)||!webpBitmap(factory.value,input,edge,webpSource.put()))return 82;source=webpSource.value;}
  else{
   if(FAILED(factory->CreateStream(stream.put()))||FAILED(stream->InitializeFromMemory(input.data(),size))||FAILED(factory->CreateDecoderFromStream(stream.value,nullptr,WICDecodeMetadataCacheOnDemand,decoder.put())))return 82;
   GUID format{};if(FAILED(decoder->GetContainerFormat(&format))||!(format==GUID_ContainerFormatJpeg||format==GUID_ContainerFormatPng||format==GUID_ContainerFormatGif||format==GUID_ContainerFormatBmp))return 82;
   if(FAILED(decoder->GetFrame(0,frame.put())))return 82;source=frame.value;
   if(format==GUID_ContainerFormatJpeg&&!artwork_metadata::jpegExif(input.data(),input.size(),metadata))return 82;
   if(format==GUID_ContainerFormatPng&&!artwork_metadata::pngExif(input.data(),input.size(),metadata))return 82;
   if(!frameProfile(factory.value,frame.value,sourceProfile,profileSpace))return 82;
   if(metadata.embeddedIcc){WICColorContextType type=WICColorContextUninitialized;if(!sourceProfile.value||FAILED(sourceProfile->GetType(&type))||type!=WICColorContextProfile)return 82;}
  }
  UINT width=0,height=0;if(FAILED(source->GetSize(&width,&height))||!dimensions(width,height))return 82;
  if(!sourceProfile.value&&(metadata.colorSpace==1||metadata.colorSpace==2)){
   if(FAILED(factory->CreateColorContext(sourceProfile.put()))||FAILED(sourceProfile->InitializeFromExifColorSpace(metadata.colorSpace)))return 82;
  }
  // Separate rotation and mirroring make EXIF 5/7 independent of combined-option ordering.
  Com<IWICBitmapFlipRotator> rotation,mirror;WICBitmapTransformOptions turn=WICBitmapTransformRotate0,flip=WICBitmapTransformRotate0;
  switch(metadata.orientation){
   case 2:flip=WICBitmapTransformFlipHorizontal;break;
   case 3:turn=WICBitmapTransformRotate180;break;
   case 4:flip=WICBitmapTransformFlipVertical;break;
   case 5:turn=WICBitmapTransformRotate90;flip=WICBitmapTransformFlipHorizontal;break;
   case 6:turn=WICBitmapTransformRotate90;break;
   case 7:turn=WICBitmapTransformRotate270;flip=WICBitmapTransformFlipHorizontal;break;
   case 8:turn=WICBitmapTransformRotate270;break;
  }
  if(turn!=WICBitmapTransformRotate0){if(FAILED(factory->CreateBitmapFlipRotator(rotation.put()))||FAILED(rotation->Initialize(source,turn)))return 82;source=rotation.value;}
  if(flip!=WICBitmapTransformRotate0){if(FAILED(factory->CreateBitmapFlipRotator(mirror.put()))||FAILED(mirror->Initialize(source,flip)))return 82;source=mirror.value;}
  if(FAILED(source->GetSize(&width,&height))||!dimensions(width,height))return 82;
  WICPixelFormatGUID sourceFormat{};if(FAILED(source->GetPixelFormat(&sourceFormat)))return 82;
  const bool cmyk=sourceFormat==GUID_WICPixelFormat32bppCMYK||sourceFormat==GUID_WICPixelFormat64bppCMYK;
  if(cmyk&&(!sourceProfile.value||profileSpace!=artwork_metadata::ProfileSpace::cmyk)||!cmyk&&sourceProfile.value&&profileSpace==artwork_metadata::ProfileSpace::cmyk)return 82;
  const double ratio=std::min(1.0,std::min(double(edge)/width,double(edge)/height));
  const UINT targetWidth=std::max(1U,static_cast<UINT>(width*ratio)),targetHeight=std::max(1U,static_cast<UINT>(height*ratio));
  Com<IWICBitmapScaler> scaler;Com<IWICFormatConverter> rgba,converter;Com<IWICBitmap> flattened;
  if(FAILED(factory->CreateBitmapScaler(scaler.put()))||FAILED(scaler->Initialize(source,targetWidth,targetHeight,WICBitmapInterpolationModeFant))||FAILED(factory->CreateFormatConverter(rgba.put()))||FAILED(rgba->Initialize(scaler.value,GUID_WICPixelFormat32bppBGRA,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom)))return 82;
  std::vector<unsigned char> pixels(size_t(targetWidth)*targetHeight*4);
  if(FAILED(rgba->CopyPixels(nullptr,targetWidth*4,UINT(pixels.size()),pixels.data())))return 82;
  if(sourceProfile.value){
   Com<IWICColorContext> destination;Com<IWICFormatConverter> colorInput;Com<IWICColorTransform> transform;
   const WICPixelFormatGUID inputFormat=profileSpace==artwork_metadata::ProfileSpace::cmyk?GUID_WICPixelFormat32bppCMYK:profileSpace==artwork_metadata::ProfileSpace::gray?GUID_WICPixelFormat16bppGray:GUID_WICPixelFormat32bppBGRA;
   if(FAILED(factory->CreateColorContext(destination.put()))||FAILED(destination->InitializeFromExifColorSpace(1))||FAILED(factory->CreateFormatConverter(colorInput.put()))||FAILED(colorInput->Initialize(scaler.value,inputFormat,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom))||FAILED(factory->CreateColorTransformer(transform.put()))||FAILED(transform->Initialize(colorInput.value,sourceProfile.value,destination.value,GUID_WICPixelFormat32bppBGRA)))return 82;
   std::vector<unsigned char> converted(pixels.size());if(FAILED(transform->CopyPixels(nullptr,targetWidth*4,UINT(converted.size()),converted.data())))return 82;
   // Retain the original straight alpha, independent of the color engine's alpha policy.
   for(size_t i=3;i<converted.size();i+=4)converted[i]=pixels[i];pixels.swap(converted);
  }
  // Straight BGRA alpha is flattened against the app's fixed #10131a background.
  const unsigned background[3]={0x1a,0x13,0x10};
  for(size_t i=0;i<pixels.size();i+=4){const unsigned alpha=pixels[i+3];for(unsigned channel=0;channel<3;channel++)pixels[i+channel]=static_cast<unsigned char>((pixels[i+channel]*alpha+background[channel]*(255-alpha)+127)/255);pixels[i+3]=255;}
  if(FAILED(factory->CreateBitmapFromMemory(targetWidth,targetHeight,GUID_WICPixelFormat32bppBGRA,targetWidth*4,UINT(pixels.size()),pixels.data(),flattened.put()))||FAILED(factory->CreateFormatConverter(converter.put()))||FAILED(converter->Initialize(flattened.value,GUID_WICPixelFormat24bppBGR,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom)))return 82;
  Com<IStream> output;Com<IWICBitmapEncoder> encoder;Com<IWICBitmapFrameEncode> encoded;Com<IPropertyBag2> properties;
  if(FAILED(CreateStreamOnHGlobal(nullptr,TRUE,output.put()))||FAILED(factory->CreateEncoder(GUID_ContainerFormatJpeg,nullptr,encoder.put()))||FAILED(encoder->Initialize(output.value,WICBitmapEncoderNoCache))||FAILED(encoder->CreateNewFrame(encoded.put(),properties.put())))return 83;
  PROPBAG2 option{};option.pstrName=const_cast<wchar_t*>(L"ImageQuality");VARIANT quality;VariantInit(&quality);quality.vt=VT_R4;quality.fltVal=0.9f;
  if(FAILED(properties->Write(1,&option,&quality))||FAILED(encoded->Initialize(properties.value))||FAILED(encoded->SetSize(targetWidth,targetHeight)))return 83;
  WICPixelFormatGUID pixel=GUID_WICPixelFormat24bppBGR;
  if(FAILED(encoded->SetPixelFormat(&pixel))||pixel!=GUID_WICPixelFormat24bppBGR||FAILED(encoded->WriteSource(converter.value,nullptr))||FAILED(encoded->Commit())||FAILED(encoder->Commit()))return 83;
  STATSTG info{};if(FAILED(output->Stat(&info,STATFLAG_NONAME))||!info.cbSize.QuadPart||info.cbSize.QuadPart>2ULL*1024*1024)return 83;
  LARGE_INTEGER start{};if(FAILED(output->Seek(start,STREAM_SEEK_SET,nullptr)))return 83;
  std::vector<unsigned char> result(static_cast<size_t>(info.cbSize.QuadPart));ULONG read=0;
  if(FAILED(output->Read(result.data(),static_cast<ULONG>(result.size()),&read))||read!=result.size())return 83;
  unsigned char header[12];put32(header,static_cast<uint32_t>(result.size()));put32(header+4,targetWidth);put32(header+8,targetHeight);
  if(!exactWrite(GetStdHandle(STD_OUTPUT_HANDLE),header,12)||!exactWrite(GetStdHandle(STD_OUTPUT_HANDLE),result.data(),static_cast<DWORD>(result.size())))return 80;
  return 0;
 }catch(...){return 84;}
}
