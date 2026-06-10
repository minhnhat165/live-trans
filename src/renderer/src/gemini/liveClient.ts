import { parseUsage, type Usage } from '../lib/cost'

const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'

export const LIVE_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview'

// Reconnect/backoff tuning. goAway-driven reconnects are graceful and reset the
// attempt counter on success, so these caps only bite during real network loss.
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000
const GOAWAY_RECONNECT_MS = 200
const MAX_RECONNECT_ATTEMPTS = 8

export type LiveConfig = {
  apiKey: string
  targetLanguageCode: string
  echoTargetLanguage: boolean
}

export type LiveHandlers = {
  // Fires once, the first time setup completes — start capture here.
  onReady: () => void
  // Reconnect lifecycle (capture/playback stay alive across these).
  onReconnecting: (attempt: number, delayMs: number) => void
  onReconnected: () => void
  // Transcripts arrive as incremental deltas (small fragments) — append them.
  // onTurnComplete (rare for this model) marks a turn boundary.
  onInputTranscript: (delta: string) => void
  onOutputTranscript: (delta: string) => void
  onTurnComplete: () => void
  onInterrupted: () => void
  onAudio: (base64Pcm24k: string) => void
  onUsage: (usage: Usage) => void
  onError: (message: string) => void
  // Terminal close only: user stopped, or we gave up after exhausting retries.
  onClose: (info: { code: number; reason: string }) => void
}

export class LiveTranslateClient {
  private ws: WebSocket | null = null
  private ready = false

  private config: LiveConfig | null = null
  private handlers: LiveHandlers | null = null

  // In-session resumption only: a handle the server issues mid-session, replayed
  // on a transparent reconnect (goAway / network drop) so the SAME live session
  // continues without a gap. Reset to null on every fresh connect() — we never
  // resume an old session across manual start/stop or app restarts (that bloats
  // the session context and makes responses slow + choppy).
  private resumptionHandle: string | null = null

  private hasReadyOnce = false
  private closedByUser = false
  private serverGoingAway = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  connect(config: LiveConfig, handlers: LiveHandlers): void {
    this.config = config
    this.handlers = handlers
    // Always start a fresh session; resumption is only used internally for
    // transparent reconnects within this same run (set from server messages).
    this.resumptionHandle = null
    this.hasReadyOnce = false
    this.closedByUser = false
    this.reconnectAttempts = 0
    this.openSocket()
  }

  private openSocket(): void {
    const config = this.config
    const handlers = this.handlers
    if (!config || !handlers) return

    this.serverGoingAway = false
    const url = `${WS_BASE}?key=${encodeURIComponent(config.apiKey)}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      const setup: Record<string, any> = {
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
          outputAudioTranscription: {},
          // Enabling sessionResumption makes the server emit sessionResumptionUpdate
          // handles; replaying the last handle resumes the same session.
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {}
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
      // Don't surface as a hard error during reconnect attempts — onclose drives recovery.
      if (this.hasReadyOnce) return
      handlers.onError('WebSocket error — check your API key, network, and model access.')
    }

    ws.onclose = (ev: CloseEvent) => {
      this.ready = false
      if (this.ws === ws) this.ws = null

      if (this.closedByUser) {
        handlers.onClose({ code: ev.code, reason: ev.reason })
        return
      }

      this.scheduleReconnect(ev)
    }
  }

  private scheduleReconnect(ev: CloseEvent): void {
    const handlers = this.handlers
    if (!handlers) return

    // A graceful goAway is expected (sessions rotate every few minutes); reconnect
    // fast and don't let it eat into the failure budget.
    if (this.serverGoingAway) {
      this.serverGoingAway = false
      handlers.onReconnecting(0, GOAWAY_RECONNECT_MS)
      this.reconnectTimer = setTimeout(() => this.openSocket(), GOAWAY_RECONNECT_MS)
      return
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      handlers.onClose({
        code: ev.code,
        reason: ev.reason
          ? `${ev.reason} (gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts)`
          : `gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
      })
      return
    }

    const attempt = ++this.reconnectAttempts
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
    handlers.onReconnecting(attempt, delay)
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay)
  }

  private handleMessage(msg: Record<string, any>, handlers: LiveHandlers): void {
    if (msg.setupComplete) {
      this.ready = true
      this.reconnectAttempts = 0
      if (!this.hasReadyOnce) {
        this.hasReadyOnce = true
        handlers.onReady()
      } else {
        handlers.onReconnected()
      }
      return
    }

    // Server hands us a resumption token; keep the latest resumable one in memory
    // so a transparent reconnect within this session can replay it. Not persisted.
    const resume = msg.sessionResumptionUpdate
    if (resume) {
      if (resume.resumable && resume.newHandle) {
        this.resumptionHandle = resume.newHandle
      }
      return
    }

    // Server is about to close this connection — reconnect with the handle when it does.
    if (msg.goAway) {
      this.serverGoingAway = true
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
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
