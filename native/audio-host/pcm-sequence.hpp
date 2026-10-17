#pragma once
#include "ffmpeg-decoder.hpp"
#include <memory>
#include <set>

namespace aural_sequence {
// Producer/control-thread component. No method is audio-callback safe.
// The plan is immutable after open; all coordinates are exact decoded PCM frames.
// Codec delay/padding belongs to AuralPcmDecoder alone. Never trim it here again.
struct Source {
 std::string entryId;
 std::wstring path;
 uint64_t start=0,end=0;
 nlohmann::json expectedBinding=nullptr;
};
struct Span {
 uint64_t begin=0,end=0;
 nlohmann::json evidence=nullptr;
};
struct Position {size_t segment=0;uint64_t itemFrame=0,sourceFrame=0;bool atEnd=false;};
class PcmSequence {
 static constexpr uint64_t maxFrame=9007199254740991ULL;
 std::vector<Source> sources_;
 std::vector<Span> spans_;
 std::unique_ptr<AuralPcmDecoder> current_,upcoming_;
 size_t index_=0,upcomingIndex_=0;
 uint64_t position_=0,sourcePosition_=0,total_=0;
 ma_format wanted_=ma_format_f32,format_=ma_format_unknown;
 bool preferInteger_=false;
 uint32_t rate_=0,channels_=0,bytesPerFrame_=0;
 std::vector<ma_channel> channelMap_;
 std::atomic<bool>* cancel_=nullptr;
 ma_result fault_=MA_SUCCESS;
 std::string failure_;
 uint64_t opens_=0,sharedTransitions_=0;

 bool cancelled()const{return cancel_&&cancel_->load(std::memory_order_acquire);}
 bool adjacent(size_t first,size_t second)const{
  return second==first+1&&sources_[first].path==sources_[second].path&&sources_[first].end==sources_[second].start;
 }
 ma_result fail(ma_result result,const char* message){fault_=result;failure_=message;return result;}
 ma_result describe(size_t index,AuralPcmDecoder& decoder){
  const auto binding=decoder.fileBinding();
  const auto& expected=sources_[index].expectedBinding;
  if(!expected.is_null()&&binding!=expected)return fail(MA_INVALID_DATA,"source file binding changed");
  if(!spans_[index].evidence.is_null()&&spans_[index].evidence.at("fileBinding")!=binding)
   return fail(MA_INVALID_DATA,"previously opened source file changed");
  spans_[index].evidence={{"backend",decoder.backend},{"codec",decoder.codecName},{"container",decoder.containerEvidence()},
   {"source",decoder.sourceEvidence()},{"fileBinding",binding},{"opusGain",decoder.opusGain.describe()}};
  return MA_SUCCESS;
 }
 ma_result openAt(size_t index,std::unique_ptr<AuralPcmDecoder>& slot){
  if(cancelled())return fail(MA_CANCELLED,"sequence cancelled");
  auto decoder=std::make_unique<AuralPcmDecoder>();
  const auto result=decoder->init(sources_[index].path,wanted_,preferInteger_,cancel_,false);
  if(result!=MA_SUCCESS)return fail(result,"sequence source could not be opened");
  ++opens_;
  if(decoder->dsd.bitRate)return fail(MA_FORMAT_NOT_SUPPORTED,"DSD requires a separate transition plan");
  const auto actualMap=decoder->pcmChannelMap();
  if(actualMap.size()!=decoder->outputChannels||std::any_of(actualMap.begin(),actualMap.end(),[](ma_channel c){return c==MA_CHANNEL_NONE;}))
   return fail(MA_FORMAT_NOT_SUPPORTED,"sequence channel layout is unknown");
  if(format_==ma_format_unknown){
   format_=decoder->outputFormat;channels_=decoder->outputChannels;rate_=decoder->outputSampleRate;channelMap_=actualMap;
   if(!channels_||channels_>16||rate_<1001||rate_>1536000||!ma_get_bytes_per_sample(format_))
    return fail(MA_FORMAT_NOT_SUPPORTED,"sequence output format is unsupported");
   bytesPerFrame_=channels_*ma_get_bytes_per_sample(format_);
  }else if(format_!=decoder->outputFormat||channels_!=decoder->outputChannels||rate_!=decoder->outputSampleRate||channelMap_!=actualMap){
   return fail(MA_FORMAT_NOT_SUPPORTED,"sequence output requires a device reconfiguration");
  }
  if(describe(index,*decoder)!=MA_SUCCESS)return fault_;
  if(sources_[index].start&&decoder->seek(sources_[index].start)!=MA_SUCCESS)return fail(MA_BAD_SEEK,"sequence source start could not be reached");
  if(cancelled())return fail(MA_CANCELLED,"sequence cancelled");
  slot=std::move(decoder);return MA_SUCCESS;
 }
 // Skip contiguous CUE spans: they must keep the current decoder and file object.
 ma_result preopen(){
  size_t next=index_+1;while(next<sources_.size()&&adjacent(next-1,next))++next;
  if(next==sources_.size()){upcoming_.reset();upcomingIndex_=next;return MA_SUCCESS;}
  if(upcoming_&&upcomingIndex_==next)return MA_SUCCESS;
  upcoming_.reset();upcomingIndex_=next;return openAt(next,upcoming_);
 }
 ma_result cross(){
  const size_t next=index_+1;if(next>=sources_.size())return MA_AT_END;
  if(cancelled())return fail(MA_CANCELLED,"sequence cancelled");
  if(adjacent(index_,next)){
   if(current_->validateSource()!=MA_SUCCESS)return fail(MA_INVALID_DATA,"CUE image changed");
   if(describe(next,*current_)!=MA_SUCCESS)return fault_;
   ++sharedTransitions_;
  }else{
   if(!upcoming_||upcomingIndex_!=next)return fail(MA_INVALID_OPERATION,"next source was not preopened");
   if(upcoming_->validateSource()!=MA_SUCCESS)return fail(MA_INVALID_DATA,"preopened source changed");
   current_=std::move(upcoming_);sourcePosition_=sources_[next].start;
  }
  index_=next;
  // I/O remains on the producer. The host must account for preopen latency and
  // measured ring headroom; this core does not promise a device will never starve.
  return preopen();
 }
public:
 PcmSequence()=default;
 PcmSequence(const PcmSequence&)=delete;PcmSequence& operator=(const PcmSequence&)=delete;
 void close(){
  current_.reset();upcoming_.reset();sources_.clear();spans_.clear();index_=upcomingIndex_=0;
  position_=sourcePosition_=total_=opens_=sharedTransitions_=0;format_=ma_format_unknown;rate_=channels_=bytesPerFrame_=0;
  channelMap_.clear();cancel_=nullptr;fault_=MA_SUCCESS;failure_.clear();
 }
 ma_result open(std::vector<Source> sources,ma_format wanted,bool preferInteger,std::atomic<bool>* cancel){
  close();cancel_=cancel;wanted_=wanted;preferInteger_=preferInteger;
  if(sources.empty()||sources.size()>500)return fail(MA_INVALID_ARGS,"sequence requires 1 to 500 entries");
  std::set<std::string> ids;size_t pathChars=0;
  for(const auto& source:sources){
   pathChars+=source.path.size();
   if(source.entryId.empty()||source.entryId.size()>128||source.entryId.find_first_of("\r\n\0",0,3)!=std::string::npos||!ids.insert(source.entryId).second||
      source.path.empty()||source.path.size()>32767||pathChars>524288||source.start>=source.end||source.end>maxFrame||source.end-source.start>maxFrame-total_)
    return fail(MA_INVALID_ARGS,"invalid or oversized exact sequence plan");
   spans_.push_back({total_,total_+source.end-source.start,nullptr});total_=spans_.back().end;
  }
  sources_=std::move(sources);
  auto result=openAt(0,current_);
  if(result==MA_SUCCESS){sourcePosition_=sources_[0].start;result=preopen();}
  if(result!=MA_SUCCESS){current_.reset();upcoming_.reset();}return result;
 }
 ma_result read(void* output,ma_uint64 frames,ma_uint64* got){
  if(!got)return MA_INVALID_ARGS;*got=0;
  if(fault_!=MA_SUCCESS)return fault_;
  if(!current_||!output||!frames||frames>1048576/bytesPerFrame_)return fail(MA_INVALID_ARGS,"invalid sequence read size");
  if(cancelled())return fail(MA_CANCELLED,"sequence cancelled");
  while(*got<frames&&position_<total_){
   if(sourcePosition_==sources_[index_].end){const auto result=cross();if(result!=MA_SUCCESS)return result;}
   const uint64_t count=std::min<uint64_t>(frames-*got,sources_[index_].end-sourcePosition_);
   ma_uint64 actual=0;const auto result=current_->read(static_cast<uint8_t*>(output)+*got*bytesPerFrame_,count,&actual);
   if(actual>count)return fail(MA_INVALID_DATA,"decoder exceeded the exact span");
   *got+=actual;position_+=actual;sourcePosition_+=actual;
   if(result!=MA_SUCCESS&&result!=MA_AT_END)return fail(result,"sequence decode failed");
   if(actual<count)return fail(MA_INVALID_FILE,"source ended before its exact span");
   if(cancelled())return fail(MA_CANCELLED,"sequence cancelled");
  }
  return position_==total_?MA_AT_END:MA_SUCCESS;
 }
 // Stop/join the producer before seeking. Reopening a previously visited file
 // must match its original physical file binding; a path alone cannot replace it.
 ma_result seek(uint64_t frame){
  if(fault_!=MA_SUCCESS)return fault_;
  if(!current_||frame>=total_)return MA_BAD_SEEK;
  if(cancelled())return fail(MA_CANCELLED,"sequence cancelled");
  const auto it=std::upper_bound(spans_.begin(),spans_.end(),frame,[](uint64_t value,const Span& span){return value<span.end;});
  const size_t target=size_t(it-spans_.begin());
  if(target>=sources_.size())return fail(MA_BAD_SEEK,"sequence seek outside plan");
  if(sources_[target].path!=sources_[index_].path){
   // Release upcoming first, keeping at most two live decoders throughout seek.
   upcoming_.reset();std::unique_ptr<AuralPcmDecoder> replacement;
   if(openAt(target,replacement)!=MA_SUCCESS)return fault_;current_=std::move(replacement);
  }else if(describe(target,*current_)!=MA_SUCCESS)return fault_;
  const auto sourceFrame=sources_[target].start+frame-spans_[target].begin;
  if(current_->seek(sourceFrame)!=MA_SUCCESS)return fail(MA_BAD_SEEK,"sequence seek failed");
  index_=target;position_=frame;sourcePosition_=sourceFrame;upcoming_.reset();return preopen();
 }
 uint64_t position()const{return position_;}uint64_t length()const{return total_;}
 // Scalar lookup over immutable bounds; no decoder I/O or producer index is
 // involved. A host maps its presented/consumed clock here, never decode-ahead.
 // Unlike other methods, this lookup is callback-safe while open/close/seek
 // mutations are excluded by the host's stopped-device lifetime contract.
 bool locate(uint64_t frame,Position& out)const noexcept{
  out={};if(sources_.empty()||frame>total_)return false;
  const size_t index=frame==total_?sources_.size()-1:size_t(std::upper_bound(spans_.begin(),spans_.end(),frame,
   [](uint64_t value,const Span& span){return value<span.end;})-spans_.begin());
  if(index>=sources_.size())return false;
  out={index,frame-spans_[index].begin,sources_[index].start+frame-spans_[index].begin,frame==total_};return true;
 }
 uint32_t sampleRate()const{return rate_;}uint32_t channels()const{return channels_;}
 uint32_t bytesPerFrame()const{return bytesPerFrame_;}ma_format format()const{return format_;}
 size_t segment()const{return index_;}size_t liveDecoders()const{return size_t(bool(current_))+size_t(bool(upcoming_));}
 uint64_t openedDecoders()const{return opens_;}uint64_t sharedTransitions()const{return sharedTransitions_;}
 const std::vector<Span>& spans()const{return spans_;}const std::string& failure()const{return failure_;}
};
}
