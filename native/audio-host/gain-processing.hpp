#pragma once
#include "vendor/json.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
namespace aural_gain {
using Json=nlohmann::json;
struct Plan {Json description;bool enabled=false,clip=true;double scale=1;};
inline Json defaults(){return {{"volumeDb",0},{"muted",false},{"replayGain","off"},{"preampDb",0},{"preventClipping",true},{"opusPolicy","r128"},{"opusTargetLUFS",-23}};}
inline bool finite(const Json& value,double minimum,double maximum){return value.is_number()&&std::isfinite(value.get<double>())&&value.get<double>()>=minimum&&value.get<double>()<=maximum;}
inline Plan make(const Json& settings,const Json& scannedTags,const Json& opus=nullptr){
 if(!settings.is_object()||settings.size()!=7||!settings.contains("volumeDb")||!finite(settings.at("volumeDb"),-60,0)||!settings.contains("preampDb")||!finite(settings.at("preampDb"),-12,12)||!settings.contains("muted")||!settings.at("muted").is_boolean()||!settings.contains("preventClipping")||!settings.at("preventClipping").is_boolean()||!settings.contains("replayGain")||!settings.at("replayGain").is_string()||!settings.contains("opusPolicy")||!settings.at("opusPolicy").is_string()||!settings.contains("opusTargetLUFS")||!settings.at("opusTargetLUFS").is_number_integer())throw std::runtime_error("invalid gain settings");
 const auto requested=settings.at("replayGain").get<std::string>();
 if(requested!="off"&&requested!="track"&&requested!="album")throw std::runtime_error("invalid ReplayGain mode");
 if(settings.at("opusTargetLUFS")!=-23&&settings.at("opusTargetLUFS")!=-18)throw std::runtime_error("invalid Opus target");
 const auto policy=settings.at("opusPolicy").get<std::string>();const auto target=settings.at("opusTargetLUFS").get<int>();
 if((policy!="r128"&&policy!="header-only"&&policy!="legacy-before-header"&&policy!="legacy-after-header")||(target!=-23&&target!=-18))throw std::runtime_error("invalid Opus gain policy");
 const bool isOpus=!opus.is_null();const Json tags=isOpus?opus.at("legacyTags"):scannedTags;
 if(!tags.is_null()){
  if(!tags.is_object()||tags.size()!=5||!tags.contains("source")||!tags.at("source").is_string()||(tags.at("source")!="file-tags"&&tags.at("source")!="cue"))throw std::runtime_error("invalid ReplayGain source");
  for(const auto* key:{"trackGainDb","albumGainDb","trackPeak","albumPeak"}){
   if(!tags.contains(key))throw std::runtime_error("missing ReplayGain field");const auto& value=tags.at(key);
   const bool peak=std::string(key).find("Peak")!=std::string::npos;
   if(!value.is_null()&&(!finite(value,peak?0:-60,peak?64:60)||(peak&&value.get<double>()==0)))throw std::runtime_error("invalid ReplayGain value");
  }
 }
 std::string selected="none",basis=isOpus?"opus-header-only":"none";double rg=0,reference=0;Json peak=nullptr;
 const double header=isOpus?opus.at("headerGainQ78").get<int>()/256.0:0;
 if(isOpus&&requested!="off"&&policy=="r128"){
  basis="opus-r128";
  if(requested=="album"&&!opus.at("r128AlbumQ78").is_null()){selected="album";rg=opus.at("r128AlbumQ78").get<int>()/256.0;}
  else if(!opus.at("r128TrackQ78").is_null()){selected="track";rg=opus.at("r128TrackQ78").get<int>()/256.0;}
  if(selected!="none")reference=target+23;
 }else if(requested!="off"&&(!isOpus||policy!="header-only")&&!tags.is_null()){
  basis=isOpus?policy=="legacy-before-header"?"opus-legacy-before-header":"opus-legacy-after-header":"file-replaygain";
  if(requested=="album"&&!tags.at("albumGainDb").is_null()){selected="album";rg=tags.at("albumGainDb").get<double>();peak=tags.at("albumPeak");}
  else if(!tags.at("trackGainDb").is_null()){selected="track";rg=tags.at("trackGainDb").get<double>();peak=tags.at("trackPeak");}
  if(isOpus&&policy=="legacy-before-header"&&!peak.is_null())peak=peak.get<double>()*std::pow(10.0,header/20);
 }
 const auto volume=settings.at("volumeDb").get<double>();const bool muted=settings.at("muted").get<bool>(),clip=settings.at("preventClipping").get<bool>();
 const double normalization=selected=="none"?0:rg+reference-(basis=="opus-legacy-before-header"?header:0);
 const double requestedDb=volume+(selected=="none"?0:normalization+settings.at("preampDb").get<double>());
 const double effectiveDb=clip?std::min(requestedDb,-20*std::log10(peak.is_null()?1:peak.get<double>())):requestedDb;
 Plan plan;plan.enabled=volume!=0||muted||requested!="off";plan.clip=clip;plan.scale=muted?0:std::pow(10.0,effectiveDb/20);
 plan.description={{"version",3},{"application","callback-linear-envelope"},{"rampMs",20},{"settings",settings},{"tags",tags},{"enabled",plan.enabled},{"selection",selected},{"reason",requested=="off"?"disabled":isOpus&&policy=="header-only"?"header-only":selected=="none"?basis=="opus-r128"?"missing-r128":"missing-tags":selected!=requested?"album-fallback-track":"selected"},{"peak",peak},{"requestedGainDb",requestedDb},{"effectiveGainDb",effectiveDb},{"linearGain",plan.scale},{"peakLimited",effectiveDb<requestedDb},{"peakEvidence",peak.is_null()?"assumed-full-scale":"tag"},{"samplePolicy",clip?"hard-clip":"preserve-float"},{"invalidSamplePolicy","zero"},{"dither","none"},{"hardwareVerified",false},{"codecGain",opus},{"gainBasis",basis},{"codecGainDb",header},{"normalizationGainDb",normalization},{"referenceOffsetDb",reference},{"totalRequestedGainDb",header+requestedDb},{"totalEffectiveGainDb",header+effectiveDb}};
 return plan;
}
// Static reference transform. Live playback uses the callback envelope in live-gain.hpp.
inline void apply(uint8_t* bytes,uint64_t frames,uint32_t channels,const Plan& plan,std::atomic<uint64_t>& clipped,std::atomic<uint64_t>& invalid){
 if(!plan.enabled)return;uint64_t clipCount=0,invalidCount=0;
 for(uint64_t sample=0;sample<frames*channels;++sample){
  float input;std::memcpy(&input,bytes+sample*sizeof(float),sizeof(float));double value=0;
  if(!std::isfinite(input)){++invalidCount;}else value=double(input)*plan.scale;
  if(plan.clip&&(value>1||value<-1)){++clipCount;value=std::max(-1.0,std::min(1.0,value));}
  if(!std::isfinite(value)||std::abs(value)>std::numeric_limits<float>::max()){++invalidCount;value=0;}
  const float output=static_cast<float>(value);std::memcpy(bytes+sample*sizeof(float),&output,sizeof(float));
 }
 clipped.fetch_add(clipCount,std::memory_order_relaxed);invalid.fetch_add(invalidCount,std::memory_order_relaxed);
}
}
