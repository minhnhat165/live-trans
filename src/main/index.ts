import { app, BrowserWindow, ipcMain, safeStorage, shell, systemPreferences } from 'electron'
import { join, dirname } from 'node:path'
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import Store from 'electron-store'

type Persisted = {
  apiKeyEnc?: string // base64 of safeStorage-encrypted API key
  totalCostUsd: number
  targetLang: string
  echoTargetLanguage: boolean
  outputDeviceId: string
}

const store = new Store<Persisted>({
  defaults: {
    totalCostUsd: 0,
    targetLang: 'en',
    echoTargetLanguage: false,
    outputDeviceId: 'default'
  }
})

function getApiKey(): string {
  const enc = store.get('apiKeyEnc')
  if (!enc) return ''
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

function setApiKey(key: string): boolean {
  if (!key) {
    store.delete('apiKeyEnc')
    return true
  }
  if (!safeStorage.isEncryptionAvailable()) return false
  const enc = safeStorage.encryptString(key).toString('base64')
  store.set('apiKeyEnc', enc)
  return true
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- System audio capture via AudioTee (Core Audio process tap) ----
// We capture the WHOLE system output EXCEPT our own Electron process tree, so the model
// never hears the translated audio we play back (that was the feedback/looping cause).
let audioProc: ChildProcessWithoutNullStreams | null = null
let pcmLeftover: Buffer<ArrayBufferLike> = Buffer.alloc(0)
const FRAME_BYTES = 3200 // 100ms @ 16kHz, 16-bit mono

function audioteeBinaryPath(): string {
  // Resolve the prebuilt Swift binary shipped inside the audiotee package.
  const dist = require.resolve('audiotee')
  const path = join(dirname(dist), '..', 'bin', 'audiotee')
  // In a packaged build the binary is asarUnpack'd; require.resolve still reports the
  // path inside app.asar, so redirect to the unpacked copy we can actually exec.
  return app.isPackaged ? path.replace('app.asar', 'app.asar.unpacked') : path
}

// PIDs in our own process subtree (descendants of the main process).
function processSubtree(root: number): Set<number> {
  const set = new Set<number>([root])
  try {
    const out = execSync('ps -axo pid=,ppid=', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const childrenOf = new Map<number, number[]>()
    for (const line of out.trim().split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, [])
      childrenOf.get(ppid)!.push(pid)
    }
    const stack = [root]
    while (stack.length) {
      const p = stack.pop()!
      for (const c of childrenOf.get(p) ?? []) {
        if (!set.has(c)) {
          set.add(c)
          stack.push(c)
        }
      }
    }
  } catch {
    // fall through with just root
  }
  return set
}

// Chromium routes audio OUTPUT through the audio.mojom.AudioService utility process.
// Excluding just that PID removes our translated playback from the tap, without passing
// non-audio PIDs (gpu/network/renderer) which lack a Core Audio object and make the tap fail.
function ownAudioServicePids(): number[] {
  const tree = processSubtree(process.pid)
  try {
    const out = execSync('ps -axo pid=,command=', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const pids: number[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = Number(m[1])
      if (tree.has(pid) && m[2].includes('audio.mojom.AudioService')) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

function rms16(buf: Buffer): number {
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 0x8000
    sumSq += s * s
  }
  return Math.sqrt(sumSq / n)
}

function stopCapture(): void {
  if (audioProc) {
    try {
      audioProc.kill()
    } catch {
      // ignore
    }
    audioProc = null
  }
  pcmLeftover = Buffer.alloc(0)
}

ipcMain.handle('capture:start', () => {
  stopCapture()
  const exclude = ownAudioServicePids()
  const args = ['--sample-rate', '16000', '--chunk-duration', '0.1']
  if (exclude.length) args.push('--exclude-processes', ...exclude.map(String))
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(audioteeBinaryPath(), args)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  audioProc = proc

  proc.stdout.on('data', (chunk: Buffer) => {
    // Re-frame the byte stream into exact 100ms frames so each chunk is sample-aligned.
    pcmLeftover = pcmLeftover.length ? Buffer.concat([pcmLeftover, chunk]) : chunk
    let offset = 0
    while (pcmLeftover.length - offset >= FRAME_BYTES) {
      const frame = pcmLeftover.subarray(offset, offset + FRAME_BYTES)
      offset += FRAME_BYTES
      mainWindow?.webContents.send('capture:pcm', {
        b64: frame.toString('base64'),
        rms: rms16(frame)
      })
    }
    pcmLeftover = offset > 0 ? Buffer.from(pcmLeftover.subarray(offset)) : pcmLeftover
  })

  // AudioTee emits structured JSON log lines on stderr; only surface real errors.
  let lastError = ''
  proc.stderr.on('data', (d: Buffer) => {
    for (const line of d.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        if (msg.message_type === 'error') {
          lastError = String(msg.data?.message ?? 'audio error')
          mainWindow?.webContents.send('capture:error', lastError)
        }
      } catch {
        lastError = trimmed
      }
    }
  })

  proc.on('error', (e) => {
    mainWindow?.webContents.send('capture:error', e.message)
  })
  proc.on('exit', (code) => {
    if (code && code !== 0 && audioProc === proc) {
      mainWindow?.webContents.send(
        'capture:error',
        lastError || `audio capture stopped (code ${code})`
      )
    }
    if (audioProc === proc) audioProc = null
  })

  return { ok: true }
})

ipcMain.handle('capture:stop', () => {
  stopCapture()
  return true
})

app.on('before-quit', stopCapture)

// ---- IPC ----
ipcMain.handle('settings:get', () => ({
  hasApiKey: !!store.get('apiKeyEnc'),
  apiKey: getApiKey(),
  totalCostUsd: store.get('totalCostUsd'),
  targetLang: store.get('targetLang'),
  echoTargetLanguage: store.get('echoTargetLanguage'),
  outputDeviceId: store.get('outputDeviceId'),
  encryptionAvailable: safeStorage.isEncryptionAvailable(),
  platform: process.platform
}))

ipcMain.handle('settings:setApiKey', (_e, key: string) => setApiKey(key))

ipcMain.handle('settings:setPrefs', (_e, prefs: Partial<Persisted>) => {
  if (typeof prefs.targetLang === 'string') store.set('targetLang', prefs.targetLang)
  if (typeof prefs.echoTargetLanguage === 'boolean')
    store.set('echoTargetLanguage', prefs.echoTargetLanguage)
  if (typeof prefs.outputDeviceId === 'string') store.set('outputDeviceId', prefs.outputDeviceId)
  return true
})

ipcMain.handle('cost:addTotal', (_e, deltaUsd: number) => {
  const next = (store.get('totalCostUsd') || 0) + (Number(deltaUsd) || 0)
  store.set('totalCostUsd', next)
  return next
})

ipcMain.handle('cost:resetTotal', () => {
  store.set('totalCostUsd', 0)
  return 0
})

// macOS: request microphone permission (covers audio capture entitlement prompt).
ipcMain.handle('perm:ensureAudio', async () => {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  try {
    return await systemPreferences.askForMediaAccess('microphone')
  } catch {
    return false
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
