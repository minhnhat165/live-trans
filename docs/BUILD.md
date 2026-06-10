# Building & releasing a signed macOS app

This produces a **universal `.dmg`** (Intel + Apple Silicon) that is code-signed and
notarized — users can download it, drag it to Applications, and open it with no Gatekeeper
warning.

Packaging is driven by [electron-builder](https://electron.build); config lives in
[`electron-builder.yml`](../electron-builder.yml) and entitlements in
[`build/entitlements.mac.plist`](../build/entitlements.mac.plist).

## Prerequisites (one-time)

You need a paid **Apple Developer Program** membership ($99/yr).

1. **Developer ID Application certificate** in your login Keychain.
    - Xcode → **Settings → Accounts** → select your team → **Manage Certificates…**
    - Click **+** → **Developer ID Application**. (Or create it on
      [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates/list).)
    - Verify it's installed:
        ```bash
        security find-identity -p codesigning -v | grep "Developer ID Application"
        ```

2. **App-specific password** for notarization.
    - [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security → App-Specific
      Passwords** → generate one (e.g. labelled `notarize`). Copy it (`xxxx-xxxx-xxxx-xxxx`).

3. **Team ID** — find it at
   [developer.apple.com/account → Membership details](https://developer.apple.com/account)
   (a 10-char string like `AB12CD34EF`).

## Build a signed + notarized DMG

Set the three credentials in your shell, then run the build:

```bash
export APPLE_ID="yourappledeveloperaccount@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="yourteamid"

bun run dist:mac
```

electron-builder will: build the app → sign it (hardened runtime + entitlements) → sign the
bundled `audiotee` binary → upload to Apple for notarization → staple the ticket. This takes a
few minutes (notarization waits on Apple's servers).

Output: `release/live-trans-<version>-universal.dmg`.

Verify it's properly signed & notarized:

```bash
spctl -a -vvv -t install "release/live-trans-$(node -p "require('./package.json').version")-universal.dmg"
# → "source=Notarized Developer ID"  means good.
```

## Test the unsigned build (no certificate needed)

To check packaging without signing — fast, arm64-only `.app` in `release/mac-arm64/`:

```bash
bun run pack:mac
open release/mac-arm64/live-trans.app
```

## Distribute

Upload the `.dmg` to a **GitHub Release**:

```bash
gh release create v0.1.0 \
  "release/live-trans-0.1.0-universal.dmg" \
  --title "live-trans 0.1.0" \
  --notes "Real-time system-audio translator powered by Gemini 3.5 Live Translate."
```

Then link that release in the README and your launch tweet.

## Building a Windows installer

The Windows build mirrors macOS but swaps the audio backend: instead of the `audiotee` Swift
binary it ships **`live-trans-capture.exe`**, our own WASAPI process-loopback helper
([`native/win-audio-capture`](../native/win-audio-capture)). It captures the system mix while
excluding our own process tree — the same no-feedback property the macOS tap gets by excluding the
audio-service PID.

> Run these on a **Windows 10 build 20348+ / Windows 11** machine. The process-loopback API is not
> available on older Windows, and the helper can only be compiled and tested there.

### Prerequisites (one-time)

- **Visual Studio 2022** (or Build Tools for VS 2022) with the **Desktop development with C++**
  workload — provides MSVC + the Windows SDK.
- **CMake** (bundled with VS, or install standalone and add to `PATH`).
- Node + **bun** and the repo deps (`bun install`).

### Build

```powershell
# 1) Compile the native capture helper (CMake → build/Release/live-trans-capture.exe)
bun run build:win-helper

# 2) Build the app + package an NSIS installer (dist:win wraps both steps + electron-builder)
bun run dist:win
```

`dist:win` runs `build:win-helper` → `electron-vite build` → `electron-builder --win`. The helper
exe is copied into the installer as an extra resource (`resources/win-audio-capture/`), where the
main process resolves it at runtime via `process.resourcesPath`.

Output: `release/live-trans Setup <version>.exe`.

To smoke-test packaging without building the installer (unpacked app in `release/win-unpacked/`):

```powershell
bun run pack:win
./release/win-unpacked/live-trans.exe
```

### Code signing (optional)

The installer is unsigned by default, so SmartScreen will warn on first run. To sign, set
`CSC_LINK` (path/base64 of a `.pfx`) and `CSC_KEY_PASSWORD` in the environment before `dist:win`;
electron-builder signs both the app and the installer automatically.

## Optional polish

- **App icon** — `build/icon.icns` (white headphones on a teal squircle, matching the
  in-app logo). electron-builder picks it up automatically. To regenerate after tweaking
  the design, edit [`scripts/make_icon.py`](../scripts/make_icon.py) and run:
    ```bash
    python3 -m venv /tmp/iconvenv && /tmp/iconvenv/bin/pip install Pillow
    /tmp/iconvenv/bin/python scripts/make_icon.py          # -> build/icon-1024.png
    # then rebuild the .icns (see scripts/make_icon.py header / git history for the sips loop)
    ```
- **Auto-update** — add `electron-updater` + a `publish` block later if you want in-app updates.
