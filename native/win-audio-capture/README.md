# live-trans-capture (Windows system-audio helper)

The Windows analogue of the macOS [`audiotee`](https://www.npmjs.com/package/audiotee) binary.
It captures the whole system audio mix **except our own Electron process tree** using the WASAPI
process-loopback API, so the model never hears the translated audio we play back (no feedback loop).

The main process spawns it and reads the same contract as audiotee:

- **stdout** — raw little-endian 16-bit / mono PCM at the requested rate (default 16 kHz).
- **stderr** — one JSON object per line; errors are `{"message_type":"error","data":{"message":…}}`.

```
live-trans-capture.exe --sample-rate 16000 --chunk-duration 0.1 --exclude-process-tree <electron-main-pid>
```

`--exclude-process-tree <pid>` captures everything except that process and its descendants — pass
Electron's **main** process id and the whole app (renderer, gpu, audio service) is excluded.

## Requirements

- **Windows 10 build 20348+ / Windows 11** — the process-loopback activation type
  (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) is not available on older builds.
- Visual Studio 2022 (or Build Tools) with the **Desktop development with C++** workload, and CMake.

## Build

From this directory, on a Windows machine:

```powershell
cmake -S . -B build -A x64
cmake --build build --config Release
```

The binary lands at `build/Release/live-trans-capture.exe`. That is the path the dev app and
`electron-builder` (via `extraResources` in `electron-builder.yml`) both look for — see
[`docs/BUILD.md`](../../docs/BUILD.md).

For an ARM64 Windows build, pass `-A ARM64` instead of `-A x64`.

## Quick manual test

Play some audio (e.g. a YouTube video), then dump 3 seconds of capture to a WAV-less raw file and
inspect its size (should be ~`sample-rate * 2` bytes/sec, i.e. ~96 KB for 3 s at 16 kHz):

```powershell
# exclude PID 0 = exclude nothing → captures the full system mix
build/Release/live-trans-capture.exe --exclude-process-tree 0 > out.pcm
# Ctrl+C after a few seconds, then check the size:
(Get-Item out.pcm).Length
```

Import `out.pcm` into Audacity as *Raw Data* (Signed 16-bit PCM, 1 channel, 16000 Hz) to listen.
