#pragma once
#include <cstdint>
struct AuralClockReading {bool available=false,precise=false;uint64_t frequency=0,position=0,qpc100ns=0;int32_t result=0;};
void* auralClockOpen(void* client);
AuralClockReading auralClockRead(void* handle);
void auralClockClose(void* handle);
// Used on the WASAPI worker after Stop and before Reset. All service operations
// for this temporary reading stay on that worker; no control-thread handle crosses.
AuralClockReading auralClockReadOnce(void* client);
struct AuralPaddingReading {bool available=false;uint32_t frames=0;int32_t result=0;};
AuralPaddingReading auralPaddingRead(void* client);
