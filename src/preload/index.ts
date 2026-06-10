import { contextBridge, ipcRenderer } from 'electron'

export type AppSettings = {
  hasApiKey: boolean
  apiKey: string
  totalCostUsd: number
  targetLang: string
  echoTargetLanguage: boolean
  outputDeviceId: string
  resumptionHandle: string
  encryptionAvailable: boolean
  platform: string
}

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setApiKey: (key: string): Promise<boolean> => ipcRenderer.invoke('settings:setApiKey', key),
  setPrefs: (prefs: {
    targetLang?: string
    echoTargetLanguage?: boolean
    outputDeviceId?: string
  }): Promise<boolean> => ipcRenderer.invoke('settings:setPrefs', prefs),
  addTotalCost: (deltaUsd: number): Promise<number> =>
    ipcRenderer.invoke('cost:addTotal', deltaUsd),
  resetTotalCost: (): Promise<number> => ipcRenderer.invoke('cost:resetTotal'),
  saveSessionHandle: (handle: string): Promise<boolean> =>
    ipcRenderer.invoke('session:saveHandle', handle),
  clearSessionHandle: (): Promise<boolean> => ipcRenderer.invoke('session:clearHandle'),
  ensureAudioPermission: (): Promise<boolean> => ipcRenderer.invoke('perm:ensureAudio'),

  // System-audio capture via AudioTee (Core Audio tap, excludes our own process tree).
  // Main streams 100ms PCM frames (base64 + rms) to the renderer over 'capture:pcm'.
  startCapture: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('capture:start'),
  stopCapture: (): Promise<boolean> => ipcRenderer.invoke('capture:stop'),
  onCapturePcm: (cb: (frame: { b64: string; rms: number }) => void): (() => void) => {
    const listener = (_e: unknown, frame: { b64: string; rms: number }): void => cb(frame)
    ipcRenderer.on('capture:pcm', listener)
    return () => ipcRenderer.removeListener('capture:pcm', listener)
  },
  onCaptureError: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('capture:error', listener)
    return () => ipcRenderer.removeListener('capture:error', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
