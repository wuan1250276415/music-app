#pragma once
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// This API belongs only in the disposable native audio process. Control methods
// must run on its owning STA thread; the render target must outlive clean close.
namespace aural_asio {
struct DriverIdentity { std::string registryName, clsid, description; };
struct Catalogue {
    std::vector<DriverIdentity> drivers;
    uint32_t registryStatus = 0, skipped = 0;
    bool truncated = false;
};
Catalogue enumerateDrivers(); // Registry only; never instantiates a driver.

enum class PcmFormat { s16, s24, s32, f32, f64 };
struct SourceFormat {
    PcmFormat format = PcmFormat::f32;
    uint32_t sampleRate = 0, channels = 0, validBits = 0;
    // Signed integers are little endian and left aligned in their container.
};
struct Configuration {
    SourceFormat source;
    std::vector<int32_t> outputChannels; // Source ordinal -> exact ASIO output.
    uint32_t bufferFrames = 0; // Zero explicitly selects the driver's preferred.
    bool allowConversion = false;
};
enum class DsdTransport { nativeDsd, dop };
struct DsdConfiguration {
    DsdTransport transport = DsdTransport::nativeDsd;
    uint32_t bitRate = 0, channels = 0, bufferFrames = 0;
    uint64_t firstSourceTick = 0;
    std::vector<int32_t> outputChannels;
    bool dopUserConfigured = false; // Exact driver/DAC profile must be approved by the caller.
};
struct RenderObservation {
    uint32_t frames = 0, musicFrames = 0;
    int32_t half = 0;
    bool clockValid = false;
    uint64_t samplePosition = 0, systemTimeNs = 0;
    uint64_t sourceBits = 0; // DSD only; excludes protocol padding and quiet payload.
};
struct RenderTarget {
    void* context = nullptr;
    uint32_t (*read)(void*, void* interleaved, uint32_t frames) noexcept = nullptr;
    void (*published)(void*, const RenderObservation&) noexcept = nullptr;
    // A bounded, non-blocking ring consumer only. No allocation, locks, file I/O,
    // decoder calls or IPC. published is a bounded metadata-ring producer only.
};
struct DsdReadResult {
    uint32_t byteFrames = 0;
    uint64_t validBitsPerChannel = 0;
    bool terminal = false;
};
struct DsdRenderTarget {
    void* context = nullptr;
    DsdReadResult (*read)(void*, uint8_t* normalizedInterleaved, uint32_t byteFrames) noexcept = nullptr;
    void (*published)(void*, const RenderObservation&) noexcept = nullptr;
    // Source ordinal interleaving; oldest bit is bit 7. Only a bounded ring
    // consumer. Nonterminal DoP reads must consume complete pairs of bytes.
};
struct ChannelInfo {
    int32_t index = 0, sampleType = 0, group = 0;
    std::string name;
    uint32_t containerBytes = 0, validBits = 0;
    bool floating = false, bigEndian = false, rightAligned = false;
};
struct DriverCapabilities {
    DriverIdentity identity;
    std::string driverName;
    int32_t driverVersion = 0, inputChannels = 0, outputChannels = 0;
    int32_t minimumFrames = 0, maximumFrames = 0, preferredFrames = 0, granularity = 0;
    std::vector<ChannelInfo> channels;
    double currentSampleRate = 0;
    bool sampleRateKnown = false, channelsTruncated = false, latencyKnown = false;
    uint32_t inputLatency = 0, outputLatency = 0;
    std::string ioMode = "unreported";
    struct ModeSupport { int32_t requested = 0, returned = -1, error = 0; };
    struct RateSupport { uint32_t rate = 0; int32_t error = 0; };
    std::vector<ModeSupport> ioFormats;
    std::vector<RateSupport> sampleRates;
    // Initialized-driver observations only. No buffers, rate changes or start.
};
struct PreparedInfo {
    DriverIdentity identity;
    std::string driverName;
    int32_t driverVersion = 0;
    uint32_t sampleRate = 0, bufferFrames = 0, callbackScratchBytes = 0;
    int32_t minimumFrames = 0, maximumFrames = 0, preferredFrames = 0, granularity = 0;
    int32_t inputChannels = 0, outputChannels = 0;
    std::vector<ChannelInfo> channels;
    bool numericConversion = false, exactPackingCandidate = false;
    bool pcmModeReported = false, outputReadySupported = false, latencyKnown = false;
    bool deferredWorkerMmcss = false;
    uint32_t inputLatency = 0, outputLatency = 0;
    uint64_t observedLatencyRevision = 0;
    bool dsdBitstream = false, nativeDsdModeReported = false, dopUserConfigured = false;
    uint32_t dsdBitRate = 0, dsdByteFramesPerBuffer = 0;
    // Native bufferFrames/ASIO position/latencies are bit-samples. DoP uses
    // carrier PCM frames. Neither number is a raw byte-frame count.
};
enum Event : uint32_t {
    resetRequested = 1u, resyncRequested = 2u, bufferSizeChanged = 4u,
    sampleRateChanged = 8u, clockChanged = 16u, latenciesChanged = 32u,
    driverOverload = 64u, invalidCallback = 128u, renderContractViolation = 256u,
    outputReadyFailed = 512u, ownerQuit = 1024u, nonzeroIntegerPadding = 2048u
};
constexpr uint32_t fatalEvents = resetRequested | resyncRequested | bufferSizeChanged |
    sampleRateChanged | clockChanged | invalidCallback | renderContractViolation |
    outputReadyFailed | ownerQuit | nonzeroIntegerPadding;
struct Snapshot {
    uint64_t callbacks = 0, queuedFrames = 0, musicFrames = 0, underrunFrames = 0;
    uint64_t saturatedSamples = 0, nonfiniteSamples = 0, readySignals = 0, deferredCallbacks = 0;
    uint64_t discardedBuffers = 0, discardedMusicFrames = 0;
    uint64_t publishedDsdBits = 0;
    uint64_t samplePosition = 0, systemTimeNs = 0, clockRevision = 0;
    uint64_t latencyRevision = 0;
    uint32_t events = 0;
    bool clockValid = false, countersValid = false, running = false;
    // queuedFrames counts filled host buffers, NOT presented/played frames.
    // ASIO callback position is evidence only; output-latency/tail mapping must
    // be integrated by the transport before it becomes a presentation clock.
};
struct State;
class Engine final {
public:
    Engine();
    ~Engine() noexcept;
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;
    void open(const DriverIdentity&); // One driver lifecycle per native process.
    DriverIdentity identity() const; // Loaded registry identity; no capability calls.
    int32_t driverVersion() const; // Initialized version; no new driver query.
    DriverCapabilities inspect(); // Before prepare; no format negotiation.
    const PreparedInfo& prepare(const Configuration&, RenderTarget);
    const PreparedInfo& prepareDsd(const DsdConfiguration&, DsdRenderTarget);
    void start(); // One start attempt; prime half B with silence, no source read.
    void stop();  // Ends this session; seek/resume/reopen need a new plan/ring.
    void controlPanel(); // Before prepare; pump messages on the owning STA.
    void pumpMessages();
    bool refreshLatencies();
    Snapshot snapshot() const noexcept;
    // False means native-process retirement is mandatory. The engine preserves
    // uncertain driver/buffer state; its destructor terminates instead of UAF.
    bool close() noexcept;
private:
    const PreparedInfo& prepareOutput();
    std::unique_ptr<State> state_;
};
}
