/// <reference types="vite/client" />

export type AppSettings = {
  hasApiKey: boolean
  apiKey: string
  totalCostUsd: number
  targetLang: string
  echoTargetLanguage: boolean
  outputDeviceId: string
  encryptionAvailable: boolean
  platform: string
}

export interface PreloadApi {
  getSettings: () => Promise<AppSettings>
  setApiKey: (key: string) => Promise<boolean>
  setPrefs: (prefs: {
    targetLang?: string
    echoTargetLanguage?: boolean
    outputDeviceId?: string
  }) => Promise<boolean>
  addTotalCost: (deltaUsd: number) => Promise<number>
  resetTotalCost: () => Promise<number>
  ensureAudioPermission: () => Promise<boolean>
  startCapture: () => Promise<{ ok: boolean; error?: string }>
  stopCapture: () => Promise<boolean>
  onCapturePcm: (cb: (frame: { b64: string; rms: number }) => void) => () => void
  onCaptureError: (cb: (message: string) => void) => () => void
}

declare global {
  interface Window {
    api: PreloadApi
  }
}
