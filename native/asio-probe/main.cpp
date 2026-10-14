#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include "vendor/iasiodrv.h"
#include "../audio-host/vendor/json.hpp"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

struct SilenceState {
    ASIOBufferInfo buffers[2]{};
    size_t bytes[2]{};
    std::atomic<bool> active{false};
    std::atomic<uint64_t> callbacks{0};
    std::atomic<bool> resetRequested{false};
};
static SilenceState silence;

static void bufferSwitch(long half, ASIOBool) {
    if (!silence.active.load(std::memory_order_relaxed) || (half != 0 && half != 1)) return;
    for (int channel = 0; channel < 2; ++channel)
        if (silence.buffers[channel].buffers[half])
            std::memset(silence.buffers[channel].buffers[half], 0, silence.bytes[channel]);
    silence.callbacks.fetch_add(1, std::memory_order_relaxed);
}
static void sampleRateChanged(ASIOSampleRate) {}
static long asioMessage(long selector, long value, void*, double*) {
    if (selector == kAsioSelectorSupported)
        return value == kAsioEngineVersion ? 1 : 0;
    if (selector == kAsioEngineVersion) return 2;
    if (selector == kAsioResetRequest || selector == kAsioBufferSizeChange) {
        silence.resetRequested.store(true, std::memory_order_relaxed);
        return 0; // The probe records but does not promise a live reset/reopen.
    }
    return 0;
}
static ASIOTime* bufferSwitchTimeInfo(ASIOTime*, long half, ASIOBool direct) {
    bufferSwitch(half, direct);
    return nullptr;
}
static size_t pcmBytes(ASIOSampleType type) {
    switch (type) {
    case ASIOSTInt16LSB: case ASIOSTInt16MSB: return 2;
    case ASIOSTInt24LSB: case ASIOSTInt24MSB: return 3;
    case ASIOSTFloat64LSB: case ASIOSTFloat64MSB: return 8;
    case ASIOSTInt32LSB: case ASIOSTInt32MSB:
    case ASIOSTFloat32LSB: case ASIOSTFloat32MSB:
    case ASIOSTInt32LSB16: case ASIOSTInt32LSB18: case ASIOSTInt32LSB20: case ASIOSTInt32LSB24:
    case ASIOSTInt32MSB16: case ASIOSTInt32MSB18: case ASIOSTInt32MSB20: case ASIOSTInt32MSB24:
        return 4;
    default: return 0; // Reject DSD and unknown layouts in the PCM silence probe.
    }
}

struct DriverEntry {
    std::wstring registryName;
    std::wstring clsid;
    std::wstring description;
};

static std::string utf8(const std::wstring& source) {
    if (source.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, source.data(),
                                         static_cast<int>(source.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, source.data(),
                        static_cast<int>(source.size()), result.data(), size, nullptr, nullptr);
    return result;
}

static std::wstring registryString(HKEY key, const wchar_t* name) {
    DWORD bytes = 0;
    if (RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ, nullptr, nullptr, &bytes) != ERROR_SUCCESS ||
        bytes < sizeof(wchar_t) || bytes > 8192) return {};
    std::wstring result(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ, nullptr, result.data(), &bytes) != ERROR_SUCCESS) return {};
    result.resize(wcsnlen_s(result.c_str(), result.size()));
    return result;
}

static std::vector<DriverEntry> listDrivers() {
    HKEY root = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0,
                      KEY_READ | KEY_WOW64_64KEY, &root) != ERROR_SUCCESS) return {};
    std::vector<DriverEntry> result;
    for (DWORD index = 0;; ++index) {
        wchar_t name[512]{};
        DWORD length = 512;
        const LONG status = RegEnumKeyExW(root, index, name, &length, nullptr, nullptr, nullptr, nullptr);
        if (status == ERROR_NO_MORE_ITEMS) break;
        if (status != ERROR_SUCCESS) continue;
        HKEY driver = nullptr;
        if (RegOpenKeyExW(root, name, 0, KEY_READ, &driver) != ERROR_SUCCESS) continue;
        DriverEntry entry{std::wstring(name, length), registryString(driver, L"CLSID"),
                          registryString(driver, L"Description")};
        RegCloseKey(driver);
        if (!entry.clsid.empty()) result.push_back(std::move(entry));
    }
    RegCloseKey(root);
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) {
        return a.registryName < b.registryName;
    });
    return result;
}

static json identity(const DriverEntry& entry) {
    return {{"registryName", utf8(entry.registryName)}, {"clsid", utf8(entry.clsid)},
            {"description", utf8(entry.description)}};
}

static int inspect(const DriverEntry& entry, bool playSilence) {
    json result = identity(entry);
    result["operation"] = playSilence ? "silence" : "inspect";
    result["playbackStarted"] = false;
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) {
        result["error"] = "COM initialization failed";
        result["hresult"] = static_cast<unsigned long>(initialized);
        std::cout << result.dump() << std::endl;
        return 2;
    }
    CLSID clsid{};
    HRESULT status = CLSIDFromString(entry.clsid.c_str(), &clsid);
    IASIO* driver = nullptr;
    if (SUCCEEDED(status)) status = CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER,
                                                     clsid, reinterpret_cast<void**>(&driver));
    if (FAILED(status) || !driver) {
        result["error"] = "ASIO driver could not be instantiated";
        result["hresult"] = static_cast<unsigned long>(status);
        CoUninitialize();
        std::cout << result.dump() << std::endl;
        return 2;
    }
    char name[256]{};
    driver->getDriverName(name);
    result["driverName"] = std::string(name, strnlen_s(name, sizeof(name)));
    result["driverVersion"] = driver->getDriverVersion();
    HWND owner = CreateWindowExW(0, L"STATIC", L"Aural ASIO probe", WS_OVERLAPPED,
                                 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    result["sysRef"] = owner ? "owned-hidden-window" : "desktop-window-fallback";
    if (!driver->init(owner ? owner : GetDesktopWindow())) {
        char error[256]{};
        driver->getErrorMessage(error);
        result["error"] = "ASIO init rejected";
        result["driverError"] = std::string(error, strnlen_s(error, sizeof(error)));
        driver->Release();
        if (owner) DestroyWindow(owner);
        CoUninitialize();
        std::cout << result.dump() << std::endl;
        return 2;
    }
    result["initialized"] = true;
    long inputs = 0, outputs = 0;
    const ASIOError channelStatus = driver->getChannels(&inputs, &outputs);
    result["channelsStatus"] = channelStatus;
    if (channelStatus == ASE_OK) {
        result["inputChannels"] = inputs;
        result["outputChannels"] = outputs;
        json channels = json::array();
        for (long index = 0; index < std::min<long>(outputs, 2); ++index) {
            ASIOChannelInfo info{};
            info.channel = index;
            info.isInput = ASIOFalse;
            const ASIOError code = driver->getChannelInfo(&info);
            channels.push_back({{"index", index}, {"status", code},
                                {"sampleType", code == ASE_OK ? json(static_cast<int>(info.type)) : json(nullptr)},
                                {"name", code == ASE_OK ? json(std::string(info.name, strnlen_s(info.name, sizeof(info.name)))) : json(nullptr)}});
        }
        result["firstOutputChannels"] = channels;
    }
    long minimum = 0, maximum = 0, preferred = 0, granularity = 0;
    const ASIOError bufferStatus = driver->getBufferSize(&minimum, &maximum, &preferred, &granularity);
    result["bufferStatus"] = bufferStatus;
    if (bufferStatus == ASE_OK) {
        result["bufferFrames"] = {{"min", minimum}, {"max", maximum},
                                   {"preferred", preferred}, {"granularity", granularity}};
    }
    ASIOSampleRate current = 0;
    const ASIOError rateStatus = driver->getSampleRate(&current);
    result["sampleRateStatus"] = rateStatus;
    if (rateStatus == ASE_OK) result["currentSampleRate"] = current;
    json rateSupport = json::object();
    for (const int rate : {44100, 48000, 96000, 192000})
        rateSupport[std::to_string(rate)] = driver->canSampleRate(rate) == ASE_OK;
    result["canSampleRate"] = rateSupport;
    int exitCode = 0;
    if (playSilence) {
        if (channelStatus != ASE_OK || outputs < 2 || bufferStatus != ASE_OK || preferred < 32 || preferred > 32768) {
            result["error"] = "driver lacks usable stereo PCM buffers";
            exitCode = 2;
        } else {
            bool valid = true;
            for (int channel = 0; channel < 2; ++channel) {
                ASIOChannelInfo info{};
                info.channel = channel;
                info.isInput = ASIOFalse;
                if (driver->getChannelInfo(&info) != ASE_OK) { valid = false; break; }
                const size_t width = pcmBytes(info.type);
                if (!width) { valid = false; break; }
                silence.buffers[channel].isInput = ASIOFalse;
                silence.buffers[channel].channelNum = channel;
                silence.bytes[channel] = static_cast<size_t>(preferred) * width;
            }
            if (!valid) {
                result["error"] = "output channels are not supported PCM types";
                exitCode = 2;
            } else {
                ASIOCallbacks callbacks{bufferSwitch, sampleRateChanged, asioMessage, bufferSwitchTimeInfo};
                const ASIOError createStatus = driver->createBuffers(silence.buffers, 2, preferred, &callbacks);
                result["createBuffersStatus"] = createStatus;
                if (createStatus != ASE_OK) {
                    result["error"] = "ASIO createBuffers failed";
                    exitCode = 2;
                } else {
                    for (int channel = 0; channel < 2; ++channel)
                        for (int half = 0; half < 2; ++half)
                            if (silence.buffers[channel].buffers[half])
                                std::memset(silence.buffers[channel].buffers[half], 0, silence.bytes[channel]);
                    silence.callbacks = 0;
                    silence.resetRequested = false;
                    silence.active = true;
                    const ASIOError startStatus = driver->start();
                    result["startStatus"] = startStatus;
                    if (startStatus == ASE_OK) {
                        result["playbackStarted"] = true;
                        Sleep(500);
                        result["stopStatus"] = driver->stop();
                        result["callbackCount"] = silence.callbacks.load();
                        result["resetRequested"] = silence.resetRequested.load();
                        if (result["stopStatus"] != ASE_OK || result["callbackCount"] == 0) {
                            result["error"] = "ASIO stream did not stop cleanly or produced no callbacks";
                            exitCode = 2;
                        }
                    } else {
                        result["error"] = "ASIO start failed";
                        exitCode = 2;
                    }
                    silence.active = false;
                    result["disposeBuffersStatus"] = driver->disposeBuffers();
                    if (result["disposeBuffersStatus"] != ASE_OK) exitCode = 2;
                }
            }
        }
    }
    driver->Release();
    if (owner) DestroyWindow(owner);
    CoUninitialize();
    std::cout << result.dump() << std::endl;
    return exitCode;
}

int wmain(int argc, wchar_t** argv) {
    const auto drivers = listDrivers();
    if (argc == 1 || (argc == 2 && std::wcscmp(argv[1], L"--list") == 0)) {
        json rows = json::array();
        for (const auto& entry : drivers) rows.push_back(identity(entry));
        std::cout << json({{"operation", "list"}, {"drivers", rows}}).dump() << std::endl;
        return 0;
    }
    if (argc == 3 && (std::wcscmp(argv[1], L"--inspect") == 0 ||
                      std::wcscmp(argv[1], L"--silence") == 0)) {
        const auto found = std::find_if(drivers.begin(), drivers.end(), [&](const DriverEntry& entry) {
            return entry.registryName == argv[2];
        });
        if (found != drivers.end()) return inspect(*found, std::wcscmp(argv[1], L"--silence") == 0);
        std::cout << json({{"operation", "inspect"}, {"error", "driver not found"},
                           {"registryName", utf8(argv[2])}}).dump() << std::endl;
        return 2;
    }
    std::cout << json({{"error", "usage: asio-probe [--list | --inspect NAME | --silence NAME]"}}).dump() << std::endl;
    return 2;
}
