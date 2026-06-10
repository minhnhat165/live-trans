import { parseUsage, type Usage } from '../lib/cost'

const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'

export const LIVE_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview'

export type LiveConfig = {
  apiKey: string
  targetLanguageCode: string
  echoTargetLanguage: boolean
}

export type LiveHandlers = {
  onReady: () => void
  // Transcripts arrive as incremental deltas (small fragments) — append them.
  // onTurnComplete (rare for this model) marks a turn boundary.
  onInputTranscript: (delta: string) => void
  onOutputTranscript: (delta: string) => void
  onTurnComplete: () => void
  onInterrupted: () => void
  onAudio: (base64Pcm24k: string) => void
  onUsage: (usage: Usage) => void
  onError: (message: string) => void
  onClose: (info: { code: number; reason: string }) => void
}

export class LiveTranslateClient {
  private ws: WebSocket | null = null
  private ready = false

  connect(config: LiveConfig, handlers: LiveHandlers): void {
    const url = `${WS_BASE}?key=${encodeURIComponent(config.apiKey)}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      const setup = {
        setup: {
          model: LIVE_TRANSLATE_MODEL,
          // translationConfig + responseModalities live under generationConfig on the wire.
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: {
              targetLanguageCode: config.targetLanguageCode,
              echoTargetLanguage: config.echoTargetLanguage
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      }
      ws.send(JSON.stringify(setup))
    }

    ws.onmessage = async (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text()
        const msg = JSON.parse(raw) as Record<string, any>
        this.handleMessage(msg, handlers)
      } catch (err) {
        handlers.onError(`Failed to parse server message: ${String(err)}`)
      }
    }

    ws.onerror = () => {
      handlers.onError('WebSocket error — check your API key, network, and model access.')
    }

    ws.onclose = (ev: CloseEvent) => {
      this.ready = false
      handlers.onClose({ code: ev.code, reason: ev.reason })
    }
  }

  private handleMessage(msg: Record<string, any>, handlers: LiveHandlers): void {
    if (msg.setupComplete) {
      this.ready = true
      handlers.onReady()
      return
    }

    const server = msg.serverContent
    if (server) {
      if (server.interrupted) handlers.onInterrupted()
      if (server.inputTranscription?.text) {
        handlers.onInputTranscript(server.inputTranscription.text)
      }
      if (server.outputTranscription?.text) {
        handlers.onOutputTranscript(server.outputTranscription.text)
      }
      const parts = server.modelTurn?.parts ?? []
      for (const part of parts) {
        const data = part.inlineData?.data
        const mime: string = part.inlineData?.mimeType ?? ''
        if (data && mime.startsWith('audio/')) handlers.onAudio(data)
      }
      if (server.turnComplete) handlers.onTurnComplete()
    }

    if (msg.usageMetadata) {
      handlers.onUsage(parseUsage(msg.usageMetadata))
    }

    if (msg.error) {
      const e = msg.error
      handlers.onError(`API error ${e.code ?? ''}: ${e.message ?? JSON.stringify(e)}`)
    }
  }

  sendAudioChunk(base64Pcm16k: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' }
        }
      })
    )
  }

  close(): void {
    this.ready = false
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
  }
}
