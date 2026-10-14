#pragma once
#include "vendor/json.hpp"
#include <cmath>
#include <stdexcept>
namespace aural_pipeline {
using Json=nlohmann::json;
inline const char* format(ma_format v){switch(v){case ma_format_u8:return "u8";case ma_format_s16:return "s16";case ma_format_s24:return "s24";case ma_format_s32:return "s32";case ma_format_f32:return "f32";default:throw std::runtime_error("unsupported pipeline PCM format");}}
inline Json report(const ma_data_converter& c){
 const char* paths[]={"passthrough","format-only","channels-only","resample-only","resample-first","channels-first"};
 if(unsigned(c.executionPath)>=6||c.channelsIn<1||c.channelsIn>16||c.channelsOut<1||c.channelsOut>16||!c.sampleRateIn||!c.sampleRateOut)throw std::runtime_error("invalid pipeline converter");
 const char* dither=c.ditherMode==ma_dither_mode_none?"none":c.ditherMode==ma_dither_mode_rectangle?"rectangular":c.ditherMode==ma_dither_mode_triangle?"triangular":nullptr;
 if(!dither||c.hasResampler&&c.resampler.pBackendVTable!=&g_ma_linear_resampler_vtable)throw std::runtime_error("unreported pipeline algorithm");
 Json input=nullptr,output=nullptr,shuffle=nullptr,weights=nullptr,representation=nullptr;const char* channelPath="none",*channelMode="none";
 if(c.hasChannelConverter){
  const auto& m=c.channelConverter;const char* channelPaths[]={"none","passthrough","mono-out","mono-in","shuffle","weights"};
  if(unsigned(m.conversionPath)>=6||m.conversionPath==ma_channel_conversion_path_unknown||!m.pChannelMapIn||!m.pChannelMapOut||m.channelsIn!=c.channelsIn||m.channelsOut!=c.channelsOut)throw std::runtime_error("invalid channel pipeline");
  channelPath=channelPaths[m.conversionPath];channelMode=m.mixingMode==ma_channel_mix_mode_rectangular?"rectangular":m.mixingMode==ma_channel_mix_mode_simple?"simple":m.mixingMode==ma_channel_mix_mode_custom_weights?"custom":nullptr;
  if(!channelMode)throw std::runtime_error("invalid channel mixing mode");input=Json::array();output=Json::array();for(unsigned i=0;i<c.channelsIn;++i)input.push_back(m.pChannelMapIn[i]);for(unsigned i=0;i<c.channelsOut;++i)output.push_back(m.pChannelMapOut[i]);
  if(m.conversionPath==ma_channel_conversion_path_shuffle){if(!m.pShuffleTable)throw std::runtime_error("missing channel shuffle");shuffle=Json::array();for(unsigned i=0;i<c.channelsOut;++i)shuffle.push_back(m.pShuffleTable[i]);}
  if(m.conversionPath==ma_channel_conversion_path_weights){
   const bool floating=m.format==ma_format_f32;if(!floating&&m.format!=ma_format_s16)throw std::runtime_error("unsupported mix weights");representation=floating?"f32":"s16-fixed";weights=Json::array();
   for(unsigned i=0;i<c.channelsIn;++i){Json row=Json::array();for(unsigned j=0;j<c.channelsOut;++j){if(floating){if(!m.weights.f32||!m.weights.f32[i]||!std::isfinite(m.weights.f32[i][j]))throw std::runtime_error("invalid float mix weight");row.push_back(m.weights.f32[i][j]);}else{if(!m.weights.s16||!m.weights.s16[i])throw std::runtime_error("invalid integer mix weight");row.push_back(m.weights.s16[i][j]);}}weights.push_back(std::move(row));}
  }
 }
 return {{"version",1},{"formatIn",format(c.formatIn)},{"formatOut",format(c.formatOut)},{"channelsIn",c.channelsIn},{"channelsOut",c.channelsOut},{"sampleRateIn",c.sampleRateIn},{"sampleRateOut",c.sampleRateOut},{"executionPath",paths[c.executionPath]},{"passthrough",bool(c.isPassthrough)},{"preFormat",bool(c.hasPreFormatConversion)},{"postFormat",bool(c.hasPostFormatConversion)},{"channelConversion",bool(c.hasChannelConverter)},{"resampling",bool(c.hasResampler)},{"dither",dither},{"resampler",c.hasResampler?"linear":"none"},{"inputLatencyFrames",std::to_string(ma_data_converter_get_input_latency(&c))},{"outputLatencyFrames",std::to_string(ma_data_converter_get_output_latency(&c))},{"channelPath",channelPath},{"channelMode",channelMode},{"inputMap",input},{"outputMap",output},{"shuffle",shuffle},{"weights",weights},{"weightRepresentation",representation}};
}
inline Json canonicalOutput(const Json& raw){Json result=Json::object();for(const char* key:{"backend","deviceId","deviceName","mode","format","deviceFormat","sampleRate","deviceSampleRate","channels","deviceChannels","adapterConversion","allowConversion","applicationIntegerPath","hardwareVerified"})result[key]=raw.at(key);return result;}
inline Json make(const Json& source,const Json& output,const Json& converter,const Json& gain,const Json& span,const Json& buffers){
 const bool resampled=converter.at("resampling").get<bool>(),converted=!converter.at("passthrough").get<bool>(),processed=gain.at("enabled").get<bool>(),integer=output.at("applicationIntegerPath").get<bool>(),shared=output.at("mode")=="shared";
 const bool dsd=!source.at("dsdConversion").is_null(),head=!source.at("opusGain").is_null()&&source.at("opusGain").at("headerGainQ78")!=0;
 const auto& media=source.at("media");const std::string encoding=media.at("encoding").get<std::string>(),decoderConversion=media.at("decoderConversion").get<std::string>();
 const unsigned bits=media.at("validBits").is_null()?0:media.at("validBits").get<unsigned>();
 const bool integerReduced=decoderConversion=="integer-output"&&bits>(source.at("format")=="s16"?16u:32u);
 const bool decodedConversion=decoderConversion=="integer-to-float"||integerReduced||decoderConversion=="float-output"&&bits>32;
 const char* quality=dsd?"dsd-converted":encoding=="pcm-integer"||encoding=="pcm-float"||encoding=="lossless-integer"?"lossless":encoding=="lossy"?"lossy":"unknown";
 Json stages=Json::array({"decode"});if(dsd)stages.push_back("dsd-lowpass-and-src");if(!source.at("opusGain").is_null())stages.push_back("opus-header-gain");stages.push_back(processed?"gain-envelope":"gain-bypass");
 if(converter.at("preFormat")==true)stages.push_back("pre-format-conversion");
 const auto channels=[&](){if(converter.at("channelConversion")==true)stages.push_back("channel-conversion");};const auto src=[&](){if(resampled)stages.push_back("linear-src");};
 if(converter.at("executionPath")=="resample-first"){src();channels();}else{channels();src();}
 if(converter.at("postFormat")==true)stages.push_back("post-format-conversion");stages.push_back("wasapi-submit");if(shared)stages.push_back("windows-shared-engine");
 Json warnings=Json::array({"hardware-unverified","decoder-format-transform-unverified"});if(!bits)warnings.push_back("source-valid-bits-unknown");if(decoderConversion=="integer-to-float"&&bits>24)warnings.push_back("integer-to-float-precision");if(integerReduced)warnings.push_back("integer-output-precision");if(decoderConversion=="float-output"&&bits>32)warnings.push_back("float-precision-reduction");if(shared)warnings.push_back("windows-shared-engine");if(resampled)warnings.push_back("src-delay-and-quality-unverified");if(dsd)warnings.push_back("dsd-filter-unverified");if(converter.at("formatOut")!="f32"&&converter.at("dither")=="none"&&converted)warnings.push_back("integer-output-without-dither");
 return {{"version",2},{"transport","pcm"},{"source",source},{"output",output},{"conversion",converter},{"gain",gain},{"span",span},{"buffers",buffers},{"path",integer?"integer-candidate":processed?"float-processing":"float-unity"},{"stages",stages},{"clockPolicy",resampled?"converter-delay-estimate":"frame-preserving"},{"tailPolicy",resampled?"linear-src-100ms":"no-resampler"},{"encodedQuality",quality},{"sampleStatus",processed||dsd||head?"processing":converted||decodedConversion?"conversion":integer?"integer-candidate":"unity-float-unverified"},{"warnings",warnings},{"hardwareVerified",false},{"bitPerfectVerified",false}};
}
}
