#define NOMINMAX
#include <windows.h>
#include <roapi.h>
#include <windows.media.h>
#include <windows.storage.streams.h>
#include <systemmediatransportcontrolsinterop.h>
#include <shcore.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <wincrypt.h>
#include <wrl.h>
#include <wrl/wrappers/corewrappers.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <deque>
#include <mutex>
#include <thread>
#include <string>
#include <vector>
#include <stdexcept>
#include "../audio-host/vendor/json.hpp"
#include "../audio-host/release.hpp"
#include "../audio-host/parent-watch.hpp"

using json=nlohmann::json;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;
using Microsoft::WRL::Wrappers::HString;
using Microsoft::WRL::Wrappers::HStringReference;
namespace media=ABI::Windows::Media;
namespace streams=ABI::Windows::Storage::Streams;
namespace {
constexpr size_t maxFrame=1048576,maxCover=384*1024;
void check(HRESULT hr,const char* operation){if(FAILED(hr)){char text[160];sprintf_s(text,"%s (0x%08lx)",operation,static_cast<unsigned long>(hr));throw std::runtime_error(text);}}
bool uuid(const std::string& text){if(text.size()!=36)return false;for(size_t i=0;i<text.size();++i){const char c=text[i];if(i==8||i==13||i==18||i==23){if(c!='-')return false;}else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;}return true;}
HString wide(const std::string& text){
 if(text.size()>4096||text.find('\0')!=std::string::npos)throw std::runtime_error("Invalid metadata text");
 HString result;if(text.empty()){check(result.Set(L"",0),"HSTRING");return result;}
 const int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);if(!count)throw std::runtime_error("Invalid UTF-8 metadata");
 std::wstring value(count,L'\0');if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),&value[0],count)!=count)throw std::runtime_error("Invalid UTF-8 metadata");check(result.Set(value.data(),count),"HSTRING");return result;
}
struct Action{std::string context,action;json value=nullptr;};
struct Shared{
 std::atomic<bool> quit{false};std::mutex inputMutex,actionMutex;json latest;bool hasInput=false;
 std::string context;std::deque<Action> actions;
 void push(const char* action,json value=nullptr){
  // System callbacks never wait for UI work or write to a pipe.
  std::unique_lock<std::mutex> lock(actionMutex,std::try_to_lock);if(!lock.owns_lock()||context.empty()||quit)return;
  if(std::string(action)=="stop")actions.clear();else if(actions.size()>=8)return;
  actions.push_back({context,action,std::move(value)});
 }
};
bool readExact(Shared& shared,void* target,DWORD count){
 auto bytes=static_cast<unsigned char*>(target);DWORD offset=0;
 while(offset<count&&!shared.quit){
  DWORD available=0;if(!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),nullptr,0,nullptr,&available,nullptr))return false;
  if(!available){Sleep(25);continue;}
  DWORD read=0;if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),bytes+offset,(std::min)(count-offset,available),&read,nullptr)||!read)return false;offset+=read;
 }return offset==count;
}
void receive(Shared& shared,const std::string& nonce){
 uint64_t sequence=0;auto window=std::chrono::steady_clock::now();size_t bytes=0,frames=0;
 try{while(!shared.quit){
  unsigned char header[4];if(!readExact(shared,header,4))break;const uint32_t size=static_cast<uint32_t>(header[0])|(static_cast<uint32_t>(header[1])<<8)|(static_cast<uint32_t>(header[2])<<16)|(static_cast<uint32_t>(header[3])<<24);
  if(!size||size>maxFrame)break;
  const auto now=std::chrono::steady_clock::now();if(now-window>=std::chrono::seconds(5)){window=now;bytes=0;frames=0;}bytes+=size;if(++frames>64||bytes>8*maxFrame)break;
  std::string body(size,'\0');if(!readExact(shared,&body[0],size))break;auto value=json::parse(body);
  if(!value.is_object()||value.value("protocol",0)!=1||value.value("buildId","")!=aural_release::main_build_id||value.value("nonce","")!=nonce||!value.contains("sequence")||!value["sequence"].is_string())break;
  const auto number=value["sequence"].get<std::string>();if(number.empty()||number.size()>20||number.find_first_not_of("0123456789")!=std::string::npos)break;
  const auto next=std::stoull(number);if(sequence==UINT64_MAX||next!=sequence+1||std::to_string(next)!=number)break;sequence=next;
  if(value.value("kind","")=="shutdown"&&value.size()==5)break;
  if(value.value("kind","")!="snapshot"||value.size()!=23)break;
  std::lock_guard<std::mutex> lock(shared.inputMutex);shared.latest=std::move(value);shared.hasInput=true;
 }}catch(...){}shared.quit=true;
}
struct Session{
 HWND window=nullptr;bool apartment=false;Shared shared;std::thread input;
 ComPtr<media::ISystemMediaTransportControls> controls;ComPtr<media::ISystemMediaTransportControls2> controls2;
 ComPtr<media::ISystemMediaTransportControlsDisplayUpdater> updater;
 EventRegistrationToken button{},position{},repeat{},shuffle{};bool hasButton=false,hasPosition=false,hasRepeat=false,hasShuffle=false;
 ~Session(){
  shared.quit=true;if(input.joinable()){input.join();}
  if(controls){controls->put_IsEnabled(false);controls->put_PlaybackStatus(media::MediaPlaybackStatus_Closed);}
  if(hasButton)controls->remove_ButtonPressed(button);
  if(hasPosition)controls2->remove_PlaybackPositionChangeRequested(position);
  if(hasRepeat)controls2->remove_AutoRepeatModeChangeRequested(repeat);
  if(hasShuffle)controls2->remove_ShuffleEnabledChangeRequested(shuffle);
  if(updater){updater->ClearAll();updater->Update();}updater.Reset();controls2.Reset();controls.Reset();
  if(window)DestroyWindow(window);if(apartment)RoUninitialize();
 }
 void initialize(){
  check(RoInitialize(RO_INIT_MULTITHREADED),"Initialize WinRT");apartment=true;
  check(SetCurrentProcessExplicitAppUserModelID(L"dev.aural.music"),"Application identity");
  WNDCLASSW wc{};wc.lpfnWndProc=DefWindowProcW;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"AuralSystemMediaWindow";
  if(!RegisterClassW(&wc))throw std::runtime_error("Register system media window");
  // GetForWindow requires a top-level HWND owned by the calling process.
  // This helper must never use Electron's window handle or a message-only HWND.
  window=CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,wc.lpszClassName,L"Aural",WS_OVERLAPPED,0,0,0,0,nullptr,nullptr,wc.hInstance,nullptr);
  if(!window)throw std::runtime_error("Create system media window");
  ComPtr<ISystemMediaTransportControlsInterop> interop;
  check(RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Media_SystemMediaTransportControls).Get(),IID_PPV_ARGS(&interop)),"System media factory");
  check(interop->GetForWindow(window,IID_PPV_ARGS(&controls)),"System media window");check(controls.As(&controls2),"System media timeline");
  check(controls->get_DisplayUpdater(&updater),"System media display");check(updater->put_Type(media::MediaPlaybackType_Music),"Music display type");
  check(controls->put_IsEnabled(false),"Disable initial media session");
  check(controls->put_IsRecordEnabled(false),"Disable recording");check(controls->put_IsFastForwardEnabled(false),"Disable fast forward");check(controls->put_IsRewindEnabled(false),"Disable rewind");check(controls->put_IsChannelUpEnabled(false),"Disable channel up");check(controls->put_IsChannelDownEnabled(false),"Disable channel down");
  auto buttons=Callback<__FITypedEventHandler_2_Windows__CMedia__CSystemMediaTransportControls_Windows__CMedia__CSystemMediaTransportControlsButtonPressedEventArgs>([this](media::ISystemMediaTransportControls*,media::ISystemMediaTransportControlsButtonPressedEventArgs* args)->HRESULT{
   media::SystemMediaTransportControlsButton value;if(FAILED(args->get_Button(&value)))return S_OK;
   switch(value){case media::SystemMediaTransportControlsButton_Play:shared.push("play");break;case media::SystemMediaTransportControlsButton_Pause:shared.push("pause");break;case media::SystemMediaTransportControlsButton_Previous:shared.push("previous");break;case media::SystemMediaTransportControlsButton_Next:shared.push("next");break;case media::SystemMediaTransportControlsButton_Stop:shared.push("stop");break;default:break;}return S_OK;
  });check(controls->add_ButtonPressed(buttons.Get(),&button),"Media buttons");hasButton=true;
  auto positions=Callback<__FITypedEventHandler_2_Windows__CMedia__CSystemMediaTransportControls_Windows__CMedia__CPlaybackPositionChangeRequestedEventArgs>([this](media::ISystemMediaTransportControls*,media::IPlaybackPositionChangeRequestedEventArgs* args)->HRESULT{
   ABI::Windows::Foundation::TimeSpan value{};if(SUCCEEDED(args->get_RequestedPlaybackPosition(&value))&&value.Duration>=0)shared.push("seek",static_cast<double>(value.Duration)/10000000.0);return S_OK;
  });check(controls2->add_PlaybackPositionChangeRequested(positions.Get(),&position),"Media seek");hasPosition=true;
  auto repeats=Callback<__FITypedEventHandler_2_Windows__CMedia__CSystemMediaTransportControls_Windows__CMedia__CAutoRepeatModeChangeRequestedEventArgs>([this](media::ISystemMediaTransportControls*,media::IAutoRepeatModeChangeRequestedEventArgs* args)->HRESULT{
   media::MediaPlaybackAutoRepeatMode value;if(SUCCEEDED(args->get_RequestedAutoRepeatMode(&value)))switch(value){case media::MediaPlaybackAutoRepeatMode_None:shared.push("repeat","off");break;case media::MediaPlaybackAutoRepeatMode_Track:shared.push("repeat","one");break;case media::MediaPlaybackAutoRepeatMode_List:shared.push("repeat","all");break;default:break;}return S_OK;
  });check(controls2->add_AutoRepeatModeChangeRequested(repeats.Get(),&repeat),"Media repeat");hasRepeat=true;
  auto shuffles=Callback<__FITypedEventHandler_2_Windows__CMedia__CSystemMediaTransportControls_Windows__CMedia__CShuffleEnabledChangeRequestedEventArgs>([this](media::ISystemMediaTransportControls*,media::IShuffleEnabledChangeRequestedEventArgs* args)->HRESULT{
   boolean value=false;if(SUCCEEDED(args->get_RequestedShuffleEnabled(&value)))shared.push("shuffle",value!=0);return S_OK;
  });check(controls2->add_ShuffleEnabledChangeRequested(shuffles.Get(),&shuffle),"Media shuffle");hasShuffle=true;
 }
 void cover(const json& value){
  if(value.is_null()){check(updater->put_Thumbnail(nullptr),"Clear thumbnail");return;}
  if(!value.is_string())throw std::runtime_error("Invalid thumbnail");const auto text=value.get<std::string>();if(text.empty()||text.size()>maxCover*4/3+4)throw std::runtime_error("Thumbnail exceeds budget");
  DWORD count=0;if(!CryptStringToBinaryA(text.data(),static_cast<DWORD>(text.size()),CRYPT_STRING_BASE64|CRYPT_STRING_STRICT,nullptr,&count,nullptr,nullptr)||count<3||count>maxCover)throw std::runtime_error("Invalid thumbnail bytes");
  std::vector<unsigned char> bytes(count);if(!CryptStringToBinaryA(text.data(),static_cast<DWORD>(text.size()),CRYPT_STRING_BASE64|CRYPT_STRING_STRICT,bytes.data(),&count,nullptr,nullptr)||bytes[0]!=255||bytes[1]!=216||bytes[2]!=255)throw std::runtime_error("Invalid JPEG thumbnail");
  ComPtr<IStream> memory;memory.Attach(SHCreateMemStream(bytes.data(),count));if(!memory)throw std::runtime_error("Thumbnail memory stream");
  ComPtr<streams::IRandomAccessStream> random;check(CreateRandomAccessStreamOverStream(memory.Get(),BSOS_DEFAULT,IID_PPV_ARGS(&random)),"Thumbnail random stream");
  ComPtr<streams::IRandomAccessStreamReferenceStatics> factory;check(RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Storage_Streams_RandomAccessStreamReference).Get(),IID_PPV_ARGS(&factory)),"Thumbnail reference factory");
  ComPtr<streams::IRandomAccessStreamReference> reference;check(factory->CreateFromStream(random.Get(),&reference),"Thumbnail reference");check(updater->put_Thumbnail(reference.Get()),"Set thumbnail");
 }
 void apply(const json& value){
  const auto context=value.at("context").get<std::string>();if(!uuid(context))throw std::runtime_error("Invalid snapshot context");
  const auto item=value.at("itemId");if(!item.is_null()&&(!item.is_string()||item.get<std::string>().empty()||item.get<std::string>().size()>128))throw std::runtime_error("Invalid item identity");
  const auto state=value.at("state").get<std::string>();if(state!="playing"&&state!="paused"&&state!="idle"&&state!="preparing"&&state!="error")throw std::runtime_error("Invalid playback state");
  for(const auto key:{"canPlay","canPause","canPrevious","canNext","canStop","canSeek","shuffle"})if(!value.at(key).is_boolean())throw std::runtime_error("Invalid control capability");
  const auto mode=value.at("repeat").get<std::string>();if(mode!="off"&&mode!="one"&&mode!="all")throw std::runtime_error("Invalid repeat mode");
  const double at=value.at("positionSeconds").get<double>(),end=value.at("durationSeconds").is_null()?0:value.at("durationSeconds").get<double>();
  if(!std::isfinite(at)||!std::isfinite(end)||at<0||end<0||at>604800||end>604800)throw std::runtime_error("Invalid timeline");
  check(controls->put_IsEnabled(!item.is_null()),"Media session enabled");
  check(controls->put_IsPlayEnabled(value["canPlay"].get<bool>()),"Play enabled");check(controls->put_IsPauseEnabled(value["canPause"].get<bool>()),"Pause enabled");
  check(controls->put_IsNextEnabled(value["canNext"].get<bool>()),"Next enabled");check(controls->put_IsPreviousEnabled(value["canPrevious"].get<bool>()),"Previous enabled");check(controls->put_IsStopEnabled(value["canStop"].get<bool>()),"Stop enabled");
  check(controls->put_PlaybackStatus(item.is_null()?media::MediaPlaybackStatus_Closed:state=="playing"?media::MediaPlaybackStatus_Playing:state=="paused"?media::MediaPlaybackStatus_Paused:state=="preparing"?media::MediaPlaybackStatus_Changing:media::MediaPlaybackStatus_Stopped),"Playback status");
  ComPtr<media::IMusicDisplayProperties> music;check(updater->get_MusicProperties(&music),"Music properties");ComPtr<media::IMusicDisplayProperties2> music2;check(music.As(&music2),"Album properties");
  auto title=wide(value.at("title").get<std::string>()),artist=wide(value.at("artist").get<std::string>()),album=wide(value.at("album").get<std::string>()),albumArtist=wide(value.at("albumArtist").get<std::string>());
  check(music->put_Title(title.Get()),"Music title");check(music->put_Artist(artist.Get()),"Music artist");check(music->put_AlbumArtist(albumArtist.Get()),"Album artist");check(music2->put_AlbumTitle(album.Get()),"Album title");
  cover(value.at("cover"));check(updater->Update(),"Update music display");
  check(controls2->put_AutoRepeatMode(mode=="one"?media::MediaPlaybackAutoRepeatMode_Track:mode=="all"?media::MediaPlaybackAutoRepeatMode_List:media::MediaPlaybackAutoRepeatMode_None),"Repeat status");check(controls2->put_ShuffleEnabled(value["shuffle"].get<bool>()),"Shuffle status");
  ComPtr<IInspectable> instance;check(RoActivateInstance(HStringReference(RuntimeClass_Windows_Media_SystemMediaTransportControlsTimelineProperties).Get(),&instance),"Timeline activation");ComPtr<media::ISystemMediaTransportControlsTimelineProperties> timeline;check(instance.As(&timeline),"Timeline properties");
  ABI::Windows::Foundation::TimeSpan zero{0},duration{static_cast<INT64>(end*10000000)},positionValue{static_cast<INT64>((std::min)(at,end)*10000000)},seekEnd=value["canSeek"].get<bool>()?duration:zero;
  check(timeline->put_StartTime(zero),"Timeline start");check(timeline->put_EndTime(duration),"Timeline end");check(timeline->put_Position(positionValue),"Timeline position");check(timeline->put_MinSeekTime(zero),"Timeline minimum");check(timeline->put_MaxSeekTime(seekEnd),"Timeline maximum");check(controls2->UpdateTimelineProperties(timeline.Get()),"Update timeline");
  std::lock_guard<std::mutex> lock(shared.actionMutex);shared.context=context;
 }
};
bool emit(const std::string& nonce,uint64_t& sequence,const char* kind,const json& context=nullptr,const json& action=nullptr,const json& value=nullptr,const json& applied=nullptr,const json& message=nullptr){
 if(sequence==UINT64_MAX)return false;const auto body=json({{"protocol",1},{"buildId",aural_release::host_build_id},{"nonce",nonce},{"sequence",std::to_string(++sequence)},{"kind",kind},{"context",context},{"action",action},{"value",value},{"appliedSequence",applied},{"message",message}}).dump();if(body.size()>4096)return false;
 std::string frame(4,'\0');for(int i=0;i<4;++i)frame[i]=static_cast<char>(body.size()>>(i*8));frame+=body;DWORD offset=0;
 while(offset<frame.size()){DWORD written=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),frame.data()+offset,static_cast<DWORD>(frame.size()-offset),&written,nullptr)||!written)return false;offset+=written;}return true;
}
}
int wmain(int argc,wchar_t** argv){
 if(argc!=3)return 64;const std::wstring raw(argv[1]);std::string nonce;for(wchar_t c:raw){if(c>127)return 64;nonce.push_back(static_cast<char>(c));}if(!uuid(nonce))return 64;
 aural_devices::ParentWatch parent;if(!parent.init(argv[2]))return 70;uint64_t sequence=0;
 try{
  Session session;session.initialize();session.input=std::thread([&](){receive(session.shared,nonce);});if(!emit(nonce,sequence,"ready"))return 68;
  auto last=std::chrono::steady_clock::now();
  while(!session.shared.quit){
   MSG message;while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){if(message.message==WM_QUIT)session.shared.quit=true;TranslateMessage(&message);DispatchMessageW(&message);}
   json input;{std::lock_guard<std::mutex> lock(session.shared.inputMutex);if(session.shared.hasInput){input=std::move(session.shared.latest);session.shared.hasInput=false;}}
   if(!input.is_null()){session.apply(input);if(!emit(nonce,sequence,"applied",input["context"],nullptr,nullptr,input["sequence"]))return 68;}
   std::deque<Action> actions;{std::lock_guard<std::mutex> lock(session.shared.actionMutex);actions.swap(session.shared.actions);}
   for(const auto& action:actions)if(!emit(nonce,sequence,"action",action.context,action.action,action.value))return 68;
   const auto now=std::chrono::steady_clock::now();if(now-last>=std::chrono::seconds(2)){if(!emit(nonce,sequence,"heartbeat"))return 68;last=now;}Sleep(25);
  }return 0;
 }catch(const std::exception& error){emit(nonce,sequence,"error",nullptr,nullptr,nullptr,nullptr,std::string(error.what()).substr(0,1024));return 65;}
}
