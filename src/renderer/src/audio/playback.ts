function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  // PCM 16-bit little-endian. Copy into an aligned buffer to be safe.
  return new Int16Array(bytes.buffer.slice(0, len - (len % 2)))
}

/**
 * Plays back 24 kHz / 16-bit / mono PCM chunks (base64) from Gemini Live Translate,
 * routed to a chosen output device (e.g. headphones) so it is not re-captured by loopback.
 */
export class TranslatedAudioPlayer {
  private ctx: AudioContext | null = null
  private playHead = 0
  private sinkId = 'default'
  private gain: GainNode | null = null
  private sources = new Set<AudioBufferSourceNode>()

  async start(sinkId: string): Promise<void> {
    this.sinkId = sinkId || 'default'
    const ctx = new AudioContext({ sampleRate: 24000 })
    this.ctx = ctx
    this.gain = ctx.createGain()
    this.gain.connect(ctx.destination)
    await this.applySink(this.sinkId)
    this.playHead = ctx.currentTime
  }

  async applySink(sinkId: string): Promise<void> {
    this.sinkId = sinkId || 'default'
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
    if (ctx && typeof ctx.setSinkId === 'function' && this.sinkId !== 'default') {
      try {
        await ctx.setSinkId(this.sinkId)
      } catch {
        // Fall back silently to the default device if the sink can't be set.
      }
    }
  }

  enqueue(base64Pcm: string): void {
    if (!this.ctx || !this.gain) return
    // Safety cap: never let the queue run more than 3s ahead, or audio keeps playing long
    // after the source stops. Drop chunks beyond that.
    if (this.playHead - this.ctx.currentTime > 3.0) return
    const int16 = base64ToInt16(base64Pcm)
    if (int16.length === 0) return
    const f32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000
    const buffer = this.ctx.createBuffer(1, f32.length, 24000)
    buffer.copyToChannel(f32, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.gain)
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
    const now = this.ctx.currentTime
    if (this.playHead < now) this.playHead = now
    src.start(this.playHead)
    this.playHead += buffer.duration
  }

  /** Drop all queued/scheduled audio — called when the model interrupts (revises) a turn. */
  interrupt(): void {
    for (const src of this.sources) {
      try {
        src.onended = null
        src.stop()
        src.disconnect()
      } catch {
        // already stopped
      }
    }
    this.sources.clear()
    if (this.ctx) this.playHead = this.ctx.currentTime
  }

  async stop(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close().catch(() => {})
      this.ctx = null
    }
    this.gain = null
    this.playHead = 0
  }
}
