// Offline format gold cases. This executable never loads ASIO or opens an audio device.
#include "dsd-reader.hpp"
#include "dsd-packer.hpp"
#include <iostream>
#include <stdexcept>
using namespace aural_dsd;
static void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
static RawBlock block(uint64_t tick,uint32_t channels,std::vector<uint8_t> bytes,uint64_t bits){RawBlock value;value.bitRate=2822400;value.channels=channels;value.startTick=tick;value.byteFrames=uint32_t(bytes.size()/channels);value.validBitsPerChannel=bits;value.bytes=std::move(bytes);return value;}
struct Fixture {
    wchar_t path[MAX_PATH]{};HANDLE file=INVALID_HANDLE_VALUE;
    Fixture(){wchar_t folder[MAX_PATH]{};require(GetTempPathW(MAX_PATH,folder)>0,"temporary folder");require(GetTempFileNameW(folder,L"ads",0,path)!=0,"temporary fixture");file=CreateFileW(path,GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_TEMPORARY,nullptr);require(file!=INVALID_HANDLE_VALUE,"fixture open");}
    ~Fixture(){if(file!=INVALID_HANDLE_VALUE)CloseHandle(file);if(path[0])DeleteFileW(path);}
};
static void put32(std::vector<uint8_t>& bytes,size_t offset,uint32_t value){for(unsigned i=0;i<4;++i)bytes[offset+i]=uint8_t(value>>(8*i));}
static void put64(std::vector<uint8_t>& bytes,size_t offset,uint64_t value){for(unsigned i=0;i<8;++i)bytes[offset+i]=uint8_t(value>>(8*i));}
int main(){try{
    const auto input=block(0,2,{0x80,0x01,0x40,0x02,0x20,0x04,0x10,0x08},32);TransportBlock output;
    require(packNative(input,NativeFormat::msbFirst,output)&&output.planes==std::vector<std::vector<uint8_t>>{{0x80,0x40,0x20,0x10},{0x01,0x02,0x04,0x08}},"native MSB planes");
    require(packNative(input,NativeFormat::lsbFirst,output)&&output.planes==std::vector<std::vector<uint8_t>>{{0x01,0x02,0x04,0x08},{0x80,0x40,0x20,0x10}},"native LSB planes");
    DopPacker packer;const std::vector<uint8_t> dop={0x40,0x80,0x05,0x02,0x01,0x05,0x10,0x20,0xfa,0x08,0x04,0xfa};
    require(packer.reset(2822400,2,0)&&packer.encode(input,true,output)&&output.interleaved==dop&&output.validSourceBitsPerChannel==32,"DoP chronology/channel marker");
    require(packer.reset(2822400,2,0,DopFormat::s32leLeftAligned24)&&packer.encode(input,true,output)&&output.interleaved==std::vector<uint8_t>{0,0x40,0x80,0x05,0,0x02,0x01,0x05,0,0x10,0x20,0xfa,0,0x08,0x04,0xfa},"DoP left-aligned 32-bit storage");
    const auto first=block(0,2,{0x80,0x01},8),second=block(8,2,{0x40,0x02,0x20,0x04,0x10,0x08},24);
    require(packer.reset(2822400,2,0)&&packer.encode(first,false,output)&&output.frames==0&&packer.encode(second,true,output)&&output.interleaved==dop&&output.validSourceBitsPerChannel==32,"DoP cross-block byte carry");
    require(packer.reset(2822400,2,0)&&packer.encode(first,false,output)&&packer.silence(1,output)&&output.interleaved==std::vector<uint8_t>{0x69,0x69,0x05,0x69,0x69,0x05}&&output.validSourceBitsPerChannel==0,"DoP underrun silence preserves pending source");
    require(packer.encode(second,true,output)&&output.interleaved==std::vector<uint8_t>{0x40,0x80,0xfa,0x02,0x01,0xfa,0x10,0x20,0x05,0x08,0x04,0x05},"DoP marker continuity after silence");
    const auto tail=block(0,1,{0xa0},3);
    require(packer.reset(2822400,1,0)&&!packer.encode(tail,false,output)&&packer.encode(tail,true,output)&&output.interleaved==std::vector<uint8_t>{0x69,0xa9,0x05}&&output.validSourceBitsPerChannel==3,"partial bit tail and silence phase");
    require(!packer.encode(block(3,1,{},0),true,output),"duplicate final block rejected");
    require(nativeSilence(2822400,2,2,NativeFormat::lsbFirst,output)&&output.planes==std::vector<std::vector<uint8_t>>{{0x96,0x96},{0x96,0x96}}&&output.protocolSilence&&output.validSourceBitsPerChannel==0,"native protocol silence");
    Fixture fixture;std::vector<uint8_t> dsf(100,0);std::memcpy(dsf.data(),"DSD ",4);put64(dsf,4,28);put64(dsf,12,100);std::memcpy(dsf.data()+28,"fmt ",4);put64(dsf,32,52);put32(dsf,40,1);put32(dsf,48,2);put32(dsf,52,2);put32(dsf,56,2822400);put32(dsf,60,1);put64(dsf,64,13);put32(dsf,72,4);std::memcpy(dsf.data()+80,"data",4);put64(dsf,84,20);const uint8_t physical[]={1,2,0xaa,0xaa,0x80,0x40,0xbb,0xbb};std::memcpy(dsf.data()+92,physical,8);DWORD written=0;require(WriteFile(fixture.file,dsf.data(),DWORD(dsf.size()),&written,nullptr)&&written==dsf.size(),"fixture write");
    Reader reader;RawBlock read;
    require(reader.openHandle(fixture.file)==ReadStatus::success&&reader.read(2,read)==ReadStatus::success&&read.validBitsPerChannel==13&&read.bytes==std::vector<uint8_t>{0x80,0x01,0x41,0x01}&&reader.cursorTick()==13,"DSF planar LSB, padding and partial tail");
    require(reader.seekTick(3)==ReadStatus::success&&reader.read(2,read)==ReadStatus::success&&read.validBitsPerChannel==10&&read.bytes==std::vector<uint8_t>{0x02,0x08,0x0b,0x0b}&&reader.read(2,read)==ReadStatus::end,"DSF unaligned tick seek and EOF");
    require(reader.seekTick(14)==ReadStatus::invalid,"source tick range");
    std::cout<<"{\"cases\":13,\"devicesOpened\":0,\"asioLoaded\":false}\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 2;}}
