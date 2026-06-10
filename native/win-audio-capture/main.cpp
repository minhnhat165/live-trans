// live-trans-capture — Windows system-audio loopback helper.
//
// The Windows analogue of the macOS `audiotee` binary. It captures the whole system
// audio mix EXCEPT a given process tree (our own Electron app), using the WASAPI
// process-loopback API (ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
// with PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE). Excluding our own tree removes the
// translated playback from the capture, which is what prevents the feedback/echo loop —
// the exact same property the macOS path gets by excluding the audio.mojom.AudioService PID.
//
// Output contract (kept identical to audiotee so the main process can treat them the same):
//   - stdout: raw little-endian 16-bit / mono PCM at the requested sample rate (default 16 kHz).
//             The main process re-frames this byte stream into 100 ms frames itself.
//   - stderr: one JSON object per line. Errors are {"message_type":"error","data":{"message":...}}.
//
// Args (audiotee-compatible where it matters):
//   --sample-rate <hz>            target PCM rate (default 16000)
//   --chunk-duration <seconds>    accepted but ignored (main re-frames); kept for arg parity
//   --exclude-process-tree <pid>  capture everything EXCEPT this process and its descendants
//   --include-process-tree <pid>  capture ONLY this process and its descendants (debugging)
//
// Requires Windows 10 build 20348+ / Windows 11 (the process-loopback activation type).

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>

#include <io.h>
#include <fcntl.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;

namespace {

std::atomic<bool> g_running{true};

void jsonLog(const char* type, const std::string& message) {
  // Minimal JSON escaping — our messages only ever contain ASCII / quotes / backslashes.
  std::string esc;
  esc.reserve(message.size() + 8);
  for (char c : message) {
    if (c == '"' || c == '\\') esc.push_back('\\');
    esc.push_back(c);
  }
  fprintf(stderr, "{\"message_type\":\"%s\",\"data\":{\"message\":\"%s\"}}\n", type, esc.c_str());
  fflush(stderr);
}

void logInfo(const std::string& m) { jsonLog("log", m); }
void logError(const std::string& m) { jsonLog("error", m); }

std::string hrToString(HRESULT hr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

BOOL WINAPI ConsoleHandler(DWORD signal) {
  if (signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT || signal == CTRL_CLOSE_EVENT) {
    g_running = false;
    return TRUE;
  }
  return FALSE;
}

// Exits the capture loop when the parent closes our stdin (i.e. the Electron process went
// away or called proc.kill()), so we never become an orphaned audio tap.
DWORD WINAPI StdinWatcher(LPVOID) {
  char buf[256];
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(in, buf, sizeof(buf), &read, nullptr) || read == 0) {
      g_running = false;
      return 0;
    }
  }
}

// Completion handler for ActivateAudioInterfaceAsync. The activation is asynchronous; this
// fires on an MTA thread when the IAudioClient is ready (or has failed).
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = nullptr;
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrActivate = E_FAIL;
    ComPtr<IUnknown> unknown;
    HRESULT hr = op->GetActivateResult(&hrActivate, &unknown);
    if (SUCCEEDED(hr) && SUCCEEDED(hrActivate)) {
      result = unknown.As(&client);
    } else {
      result = SUCCEEDED(hr) ? hrActivate : hr;
    }
    SetEvent(done);
    return S_OK;
  }
};

struct Options {
  UINT32 sampleRate = 16000;
  DWORD pid = 0;
  bool exclude = true;  // exclude-target-tree by default (the no-feedback mode)
  bool hasPid = false;
};

bool parseArgs(int argc, wchar_t** argv, Options& opt) {
  for (int i = 1; i < argc; i++) {
    std::wstring a = argv[i];
    auto next = [&](const wchar_t** out) -> bool {
      if (i + 1 >= argc) return false;
      *out = argv[++i];
      return true;
    };
    const wchar_t* val = nullptr;
    if (a == L"--sample-rate") {
      if (!next(&val)) return false;
      opt.sampleRate = static_cast<UINT32>(_wtoi(val));
    } else if (a == L"--chunk-duration") {
      if (!next(&val)) return false;  // accepted for parity, ignored
    } else if (a == L"--exclude-process-tree") {
      if (!next(&val)) return false;
      opt.pid = static_cast<DWORD>(_wtoi(val));
      opt.exclude = true;
      opt.hasPid = true;
    } else if (a == L"--include-process-tree") {
      if (!next(&val)) return false;
      opt.pid = static_cast<DWORD>(_wtoi(val));
      opt.exclude = false;
      opt.hasPid = true;
    }
  }
  return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options opt;
  if (!parseArgs(argc, argv, opt)) {
    logError("invalid arguments");
    return 2;
  }
  if (opt.sampleRate == 0) opt.sampleRate = 16000;

  // stdout must be binary so PCM bytes are not mangled by CRLF translation.
  _setmode(_fileno(stdout), _O_BINARY);
  SetConsoleCtrlHandler(ConsoleHandler, TRUE);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    logError("CoInitializeEx failed " + hrToString(hr));
    return 1;
  }

  // --- Activate a process-loopback audio client -------------------------------------------
  AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
  activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activationParams.ProcessLoopbackParams.TargetProcessId = opt.pid;
  activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
      opt.exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                  : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT prop = {};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(activationParams);
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

  auto handler = Make<ActivationHandler>();
  handler->done = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  if (!handler->done) {
    logError("CreateEvent (activation) failed");
    return 1;
  }

  ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOp;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
                                   &prop, handler.Get(), &asyncOp);
  if (FAILED(hr)) {
    logError("ActivateAudioInterfaceAsync failed " + hrToString(hr) +
             " (process loopback needs Windows 10 build 20348+ / Windows 11)");
    return 1;
  }
  WaitForSingleObject(handler->done, INFINITE);
  if (FAILED(handler->result) || !handler->client) {
    logError("Failed to activate process-loopback capture " + hrToString(handler->result));
    return 1;
  }
  ComPtr<IAudioClient> audioClient = handler->client;

  // --- Initialize at 16-bit / mono / requested rate ---------------------------------------
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 1;
  format.nSamplesPerSec = opt.sampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  // 200 ms engine buffer. AUTOCONVERTPCM + SRC_DEFAULT_QUALITY let the audio engine resample
  // the 48 kHz-ish mix down to our requested 16 kHz mono. Some builds reject those flags on a
  // process-loopback stream, so fall back to a plain init if the first attempt fails.
  const REFERENCE_TIME bufferDuration = 200 * 10000;  // hns
  const DWORD baseFlags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  hr = audioClient->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      baseFlags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      bufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) {
    hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, baseFlags, bufferDuration, 0, &format,
                                 nullptr);
  }
  if (FAILED(hr)) {
    logError("IAudioClient::Initialize failed " + hrToString(hr));
    return 1;
  }

  HANDLE sampleReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  if (!sampleReady) {
    logError("CreateEvent (sample) failed");
    return 1;
  }
  hr = audioClient->SetEventHandle(sampleReady);
  if (FAILED(hr)) {
    logError("SetEventHandle failed " + hrToString(hr));
    return 1;
  }

  ComPtr<IAudioCaptureClient> captureClient;
  hr = audioClient->GetService(IID_PPV_ARGS(&captureClient));
  if (FAILED(hr)) {
    logError("GetService(IAudioCaptureClient) failed " + hrToString(hr));
    return 1;
  }

  hr = audioClient->Start();
  if (FAILED(hr)) {
    logError("IAudioClient::Start failed " + hrToString(hr));
    return 1;
  }

  logInfo("capturing");

  CreateThread(nullptr, 0, StdinWatcher, nullptr, 0, nullptr);

  const UINT32 blockAlign = format.nBlockAlign;
  std::vector<BYTE> silence;

  // --- Capture loop ------------------------------------------------------------------------
  while (g_running.load()) {
    DWORD wait = WaitForSingleObject(sampleReady, 200);
    if (wait == WAIT_TIMEOUT) continue;
    if (wait != WAIT_OBJECT_0) break;

    UINT32 packetFrames = 0;
    hr = captureClient->GetNextPacketSize(&packetFrames);
    while (SUCCEEDED(hr) && packetFrames > 0 && g_running.load()) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = captureClient->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      const size_t bytes = static_cast<size_t>(frames) * blockAlign;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        if (silence.size() < bytes) silence.resize(bytes, 0);
        fwrite(silence.data(), 1, bytes, stdout);
      } else if (data && bytes) {
        fwrite(data, 1, bytes, stdout);
      }
      fflush(stdout);

      captureClient->ReleaseBuffer(frames);
      hr = captureClient->GetNextPacketSize(&packetFrames);
    }
  }

  audioClient->Stop();
  CoUninitialize();
  return 0;
}
