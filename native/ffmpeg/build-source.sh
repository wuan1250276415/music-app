#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/build/source/FFmpeg-FFmpeg-1041abd"
export VSLANG=1033
if [[ "${1:-}" != "--compile-only" ]]; then
./configure --toolchain=msvc --cc=clang-cl.exe --host-cc=clang-cl.exe --ld=../../../mslink.sh --host-ld=../../../mslink.sh \
  --arch=x86_64 --target-os=win64 --prefix=../../install \
  --disable-autodetect --disable-everything --disable-programs --disable-doc \
  --disable-debug --disable-network --disable-x86asm --disable-static --enable-shared \
  --disable-avdevice --disable-avfilter --disable-swscale --enable-small \
  --enable-avcodec --enable-avformat --enable-swresample \
  --enable-decoder=aac,alac,vorbis,opus,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar --enable-demuxer=aac,mov,ogg,dsf,iff \
  --enable-parser=aac,vorbis,opus --extra-cflags=-MT
fi
gnumake.exe -f Makefile -f ../../../dependencies.mak -j8 SHELL=sh.exe
gnumake.exe -f Makefile -f ../../../dependencies.mak SHELL=sh.exe install
