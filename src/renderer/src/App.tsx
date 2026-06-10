import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LANGUAGES, shortLabel } from './lib/languages'
import {
  costUsd,
  formatUsd,
  formatTokens,
  formatDuration,
  estimateAudioSeconds,
  DEFAULT_INPUT_RATE_PER_M,
  DEFAULT_OUTPUT_RATE_PER_M,
  type Usage
} from './lib/cost'
import { SystemAudioCapture } from './audio/capture'
import { TranslatedAudioPlayer } from './audio/playback'
import { LiveTranslateClient } from './gemini/liveClient'

type Status = 'idle' | 'connecting' | 'listening' | 'error'
type OutputDevice = { deviceId: string; label: string }

const RATE_KEY = 'live-trans.rates'

// Ko-fi (PayPal-backed, works for Vietnam) — opens in the default browser via the
// window-open handler. TODO: replace `your-username` with your actual Ko-fi username.
const KOFI_URL = 'https://ko-fi.com/minhnhat165'

// Transcripts stream for the whole length of a video; cap the retained text so a long
// session can't grow an unbounded string that re-renders slower and slower.
const MAX_TRANSCRIPT_CHARS = 8000
function appendCapped(prev: string, addition: string): string {
  const next = prev + addition
  return next.length > MAX_TRANSCRIPT_CHARS ? next.slice(next.length - MAX_TRANSCRIPT_CHARS) : next
}

function loadRates(): { input: number; output: number } {
  try {
    const raw = localStorage.getItem(RATE_KEY)
    if (raw) {
      const r = JSON.parse(raw)
      return { input: Number(r.input), output: Number(r.output) }
    }
  } catch {
    /* ignore */
  }
  return { input: DEFAULT_INPUT_RATE_PER_M, output: DEFAULT_OUTPUT_RATE_PER_M }
}

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  listening: 'Listening',
  error: 'Error'
}

export default function App(): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [targetLang, setTargetLang] = useState('en')
  const [echo, setEcho] = useState(false)
  const [outputDeviceId, setOutputDeviceId] = useState('default')
  const [outputDevices, setOutputDevices] = useState<OutputDevice[]>([])
  const [rates, setRates] = useState(loadRates())

  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [level, setLevel] = useState(0)

  const [sessionUsage, setSessionUsage] = useState<Usage>({ inputTokens: 0, outputTokens: 0 })
  const [totalCost, setTotalCost] = useState(0)
  // Transcripts arrive as incremental deltas (small fragments), so we append them.
  // turnComplete is rare/absent for this model; we add a line break when it does arrive.
  const [original, setOriginal] = useState('')
  const [translated, setTranslated] = useState('')
  const [playAudio, setPlayAudio] = useState(true)
  const playAudioRef = useRef(true)
  const [showSettings, setShowSettings] = useState(true)
  const [showUsage, setShowUsage] = useState(false)
  // macOS uses a hidden-inset title bar (content slides under the traffic lights); Windows/Linux
  // keep the native frame, so we only reserve the traffic-light strip on macOS.
  const [isMac, setIsMac] = useState(false)

  const captureRef = useRef<SystemAudioCapture | null>(null)
  const playerRef = useRef<TranslatedAudioPlayer | null>(null)
  const clientRef = useRef<LiveTranslateClient | null>(null)
  const origRef = useRef<HTMLDivElement | null>(null)
  const transRef = useRef<HTMLDivElement | null>(null)

  const running = status === 'connecting' || status === 'listening'
  const sessionCost = costUsd(sessionUsage, rates.input, rates.output)
  const targetName = shortLabel(targetLang)

  // ---- initial load ----
  useEffect(() => {
    window.api.getSettings().then((s) => {
      setApiKey(s.apiKey)
      setKeySaved(s.hasApiKey)
      setTargetLang(s.targetLang)
      setEcho(s.echoTargetLanguage)
      setOutputDeviceId(s.outputDeviceId)
      setTotalCost(s.totalCostUsd)
      setIsMac(s.platform === 'darwin')
      if (s.hasApiKey) setShowSettings(false)
    })
    void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }, [])

  // auto-scroll transcripts
  useEffect(() => {
    origRef.current?.scrollTo({ top: origRef.current.scrollHeight })
  }, [original])
  useEffect(() => {
    transRef.current?.scrollTo({ top: transRef.current.scrollHeight })
  }, [translated])

  async function refreshDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const outs = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Output device' }))
      setOutputDevices(outs)
    } catch {
      /* ignore */
    }
  }

  async function saveKey(): Promise<void> {
    const ok = await window.api.setApiKey(apiKey.trim())
    setKeySaved(ok && !!apiKey.trim())
    setMessage(ok ? 'API key saved (encrypted).' : 'Could not save key — OS encryption unavailable.')
  }

  function persistRates(next: { input: number; output: number }): void {
    setRates(next)
    localStorage.setItem(RATE_KEY, JSON.stringify(next))
  }

  const handleUsage = useCallback(
    (u: Usage) => {
      // usageMetadata arrives per-message (incremental), so accumulate it.
      setSessionUsage((prev) => ({
        inputTokens: prev.inputTokens + u.inputTokens,
        outputTokens: prev.outputTokens + u.outputTokens
      }))
      const cost = costUsd(u, rates.input, rates.output)
      if (cost > 0) window.api.addTotalCost(cost).then(setTotalCost)
    },
    [rates.input, rates.output]
  )

  async function start(): Promise<void> {
    if (!apiKey.trim()) {
      setStatus('error')
      setMessage('Enter your Gemini API key first.')
      setShowSettings(true)
      return
    }
    setStatus('connecting')
    setMessage('Requesting audio permission…')
    setOriginal('')
    setTranslated('')
    setSessionUsage({ inputTokens: 0, outputTokens: 0 })

    await window.api.ensureAudioPermission()
    await refreshDevices()

    const player = new TranslatedAudioPlayer()
    const capture = new SystemAudioCapture()
    const client = new LiveTranslateClient()
    playerRef.current = player
    captureRef.current = capture
    clientRef.current = client

    try {
      await player.start(outputDeviceId)
    } catch (err) {
      setStatus('error')
      setMessage(`Audio output failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    client.connect(
      { apiKey: apiKey.trim(), targetLanguageCode: targetLang, echoTargetLanguage: echo },
      {
        onReady: async () => {
          setMessage('Connected — capturing system audio…')
          try {
            await capture.start({
              onChunk: (b64) => client.sendAudioChunk(b64),
              onLevel: (rms) => setLevel(rms),
              onError: (m) => {
                setStatus('error')
                setMessage(`Capture error: ${m}`)
              }
            })
            setStatus('listening')
            setMessage('Listening. Play your video — translation comes out on the selected device.')
          } catch {
            /* capture.start already reported the error */
          }
        },
        // Reconnect is handled inside the client; capture/playback stay alive,
        // so we only nudge the status. attempt 0 = a graceful session rotation.
        onReconnecting: (attempt) => {
          setStatus((s) => (s === 'error' ? s : 'connecting'))
          setMessage(
            attempt === 0
              ? 'Session rotating — reconnecting…'
              : `Connection dropped — reconnecting (attempt ${attempt})…`
          )
        },
        onReconnected: () => {
          setStatus((s) => (s === 'error' ? s : 'listening'))
          setMessage('Reconnected — resuming translation.')
        },
        onInputTranscript: (t) => setOriginal((p) => appendCapped(p, t)),
        onOutputTranscript: (t) => setTranslated((p) => appendCapped(p, t)),
        onTurnComplete: () => {
          setOriginal((p) => (p.endsWith('\n') ? p : p + '\n'))
          setTranslated((p) => (p.endsWith('\n') ? p : p + '\n'))
        },
        onInterrupted: () => player.interrupt(),
        onAudio: (b64) => {
          if (playAudioRef.current) player.enqueue(b64)
        },
        onUsage: handleUsage,
        onError: (m) => {
          setStatus('error')
          setMessage(m)
        },
        onClose: ({ code, reason }) => {
          // functional update avoids the stale `status` captured in this closure
          setStatus((s) => (s === 'error' ? s : 'idle'))
          setMessage(reason ? `Disconnected (${code}): ${reason}` : `Disconnected (${code}).`)
        }
      }
    )
  }

  async function stop(): Promise<void> {
    await captureRef.current?.stop()
    clientRef.current?.close()
    await playerRef.current?.stop()
    captureRef.current = null
    clientRef.current = null
    playerRef.current = null
    setStatus('idle')
    setLevel(0)
    setMessage('Stopped.')
  }

  function toggle(): void {
    if (running) void stop()
    else void start()
  }

  function onTargetChange(code: string): void {
    setTargetLang(code)
    window.api.setPrefs({ targetLang: code })
  }
  function onEchoChange(v: boolean): void {
    setEcho(v)
    window.api.setPrefs({ echoTargetLanguage: v })
  }
  function onDeviceChange(id: string): void {
    setOutputDeviceId(id)
    window.api.setPrefs({ outputDeviceId: id })
    void playerRef.current?.applySink(id)
  }

  const dot =
    status === 'listening'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400'
        : status === 'error'
          ? 'bg-red-400'
          : 'bg-faint'
  const pill =
    status === 'listening'
      ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
      : status === 'connecting'
        ? 'border-amber-400/25 bg-amber-400/10 text-amber-300'
        : status === 'error'
          ? 'border-red-400/25 bg-red-400/10 text-red-300'
          : 'border-border bg-surface text-muted'

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* ---- Title bar ---- */}
      <header className="drag-region flex shrink-0 flex-col border-b border-border/60">
        {/* thin strip reserving space for the macOS traffic-light buttons (none on Windows/Linux) */}
        <div className={isMac ? 'h-9 shrink-0' : 'h-3 shrink-0'} />
        <div className="flex items-center justify-between px-4 pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-[9px] bg-linear-to-br from-accent to-[#0e8f80] shadow-sm ring-1 ring-white/10">
              <HeadphonesIcon />
            </div>
            <div className="leading-tight">
              <h1 className="text-[13px] font-semibold tracking-tight">live-trans</h1>
              <p className="text-[11px] text-faint">
                Gemini 3.5 Live Translate · system audio →{' '}
                <span className="font-medium text-muted">{targetName}</span>
              </p>
            </div>
          </div>

          <div className="no-drag flex items-center gap-2">
          <span
            className={`flex h-8 items-center gap-2 rounded-full border px-3 text-[11px] font-medium transition-colors ${pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dot} ${running ? 'animate-pulse' : ''}`} />
            {STATUS_LABEL[status]}
          </span>
          <a
            href={KOFI_URL}
            target="_blank"
            rel="noreferrer"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 text-[11px] font-medium text-amber-300 transition hover:border-amber-400/40 hover:bg-amber-400/15"
            title="Support on Ko-fi"
          >
            <CoffeeIcon />
            <span>Coffee</span>
          </a>
          <button
            onClick={() => setShowUsage(true)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:border-border-strong hover:text-foreground"
            title="Usage"
          >
            <ChartIcon />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:border-border-strong hover:text-foreground"
            title="Settings"
          >
            <GearIcon />
          </button>
          </div>
        </div>
      </header>

      {/* ---- Transcripts ---- */}
      <main className="grid min-h-0 flex-1 grid-cols-2 gap-3 px-4 pb-3 pt-3">
        <Column
          title="Original"
          accent={false}
          innerRef={origRef}
          text={original}
          live={running}
          empty="Detected speech appears here."
        />
        <Column
          title={`Translation · ${targetName}`}
          accent
          innerRef={transRef}
          text={translated}
          live={running}
          empty="Translated text appears here."
        />
      </main>

      {/* ---- Control dock ---- */}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={toggle}
            className={`flex h-10 items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition active:scale-[0.98] ${
              running
                ? 'border border-border-strong bg-surface-2 text-red-300 hover:bg-elevated'
                : 'bg-accent text-accent-fg shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_8px_rgba(20,184,166,0.25)] hover:bg-accent-hover'
            }`}
          >
            {running ? (
              <>
                <StopIcon /> Stop
              </>
            ) : (
              <>
                <PlayIcon /> Enable translation
              </>
            )}
          </button>

          <Meter level={level} active={running} />
        </div>

        <div className="flex items-center gap-6">
          <Stat
            label="This session"
            value={formatUsd(sessionCost)}
            sub={`${sessionUsage.inputTokens + sessionUsage.outputTokens} tok`}
          />
          <div className="h-8 w-px bg-border" />
          <Stat
            label="Total spent"
            value={formatUsd(totalCost)}
            sub="all time"
            onReset={async () => setTotalCost(await window.api.resetTotalCost())}
          />
        </div>
      </footer>

      {/* ---- Status line ---- */}
      <div className="shrink-0 border-t border-border bg-background px-4 py-1.5 text-[11px] text-faint">
        {message || 'Ready.'}
      </div>

      {/* ---- Settings modal ---- */}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          apiKey={apiKey}
          setApiKey={setApiKey}
          keySaved={keySaved}
          saveKey={saveKey}
          targetLang={targetLang}
          onTargetChange={onTargetChange}
          outputDeviceId={outputDeviceId}
          outputDevices={outputDevices}
          onDeviceChange={onDeviceChange}
          rates={rates}
          persistRates={persistRates}
          playAudio={playAudio}
          setPlayAudio={(v) => {
            setPlayAudio(v)
            playAudioRef.current = v
          }}
          echo={echo}
          onEchoChange={onEchoChange}
        />
      )}

      {/* ---- Usage modal ---- */}
      {showUsage && (
        <UsageModal
          onClose={() => setShowUsage(false)}
          usage={sessionUsage}
          sessionCost={sessionCost}
          totalCost={totalCost}
          rates={rates}
          running={running}
          onResetTotal={async () => setTotalCost(await window.api.resetTotalCost())}
        />
      )}
    </div>
  )
}

/* =========================== Transcript column =========================== */

// Memoized so VU-meter/cost re-renders (~10/s) don't re-render the growing transcript text.
const Column = memo(function Column(props: {
  title: string
  accent: boolean
  text: string
  empty: string
  live: boolean
  innerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span
          className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${
            props.accent ? 'text-accent' : 'text-muted'
          }`}
        >
          {props.title}
        </span>
        {props.live && props.text && (
          <span className="flex items-center gap-1.5 text-[10px] text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            live
          </span>
        )}
      </div>
      <div
        ref={props.innerRef}
        className="flex-1 overflow-y-auto px-4 py-3.5 text-[15px] leading-relaxed"
      >
        {props.text ? (
          <p className="whitespace-pre-wrap text-foreground/90">{props.text}</p>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-[18rem] text-center text-[13px] text-faint">{props.empty}</p>
          </div>
        )}
      </div>
    </section>
  )
})

/* =========================== VU meter =========================== */

const METER_BARS = 20
function Meter({ level, active }: { level: number; active: boolean }): React.JSX.Element {
  const pct = active ? Math.min(100, level * 320) : 0
  const lit = Math.round((pct / 100) * METER_BARS)
  return (
    <div className="flex h-10 items-center gap-2.5 rounded-lg border border-border bg-background/40 px-3">
      <span className={active ? 'text-accent' : 'text-faint'}>
        <MicIcon />
      </span>
      <div className="flex h-4 items-center gap-0.5">
        {Array.from({ length: METER_BARS }).map((_, i) => {
          const on = i < lit
          return (
            <span
              key={i}
              className="rounded-full transition-all duration-100"
              style={{
                width: 3,
                height: on ? '100%' : '38%',
                background: on ? 'var(--color-accent)' : 'var(--color-border-strong)'
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

/* =========================== Stat =========================== */

function Stat(props: {
  label: string
  value: string
  sub: string
  onReset?: () => void
}): React.JSX.Element {
  return (
    <div className="text-right">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
        {props.label}
      </div>
      <div className="font-mono text-[15px] font-semibold tabular-nums text-foreground">
        {props.value}
      </div>
      <div className="text-[10px] text-faint">
        {props.sub}
        {props.onReset && (
          <button onClick={props.onReset} className="ml-1.5 text-faint transition hover:text-red-400">
            reset
          </button>
        )}
      </div>
    </div>
  )
}

/* =========================== Settings modal =========================== */

function SettingsModal(props: {
  onClose: () => void
  apiKey: string
  setApiKey: (v: string) => void
  keySaved: boolean
  saveKey: () => void
  targetLang: string
  onTargetChange: (code: string) => void
  outputDeviceId: string
  outputDevices: OutputDevice[]
  onDeviceChange: (id: string) => void
  rates: { input: number; output: number }
  persistRates: (r: { input: number; output: number }) => void
  playAudio: boolean
  setPlayAudio: (v: boolean) => void
  echo: boolean
  onEchoChange: (v: boolean) => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        className="no-drag flex max-h-[88vh] w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-[11px] text-muted">Configure your translation session</p>
          </div>
          <button
            onClick={props.onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-foreground"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Modal body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <Field label="Gemini API key" hint="Stored encrypted on this device via the OS keychain.">
            <div className="flex gap-2">
              <input
                type="password"
                value={props.apiKey}
                onChange={(e) => props.setApiKey(e.target.value)}
                placeholder="AIza…"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-accent"
              />
              <button
                onClick={props.saveKey}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover"
              >
                {props.keySaved ? 'Update' : 'Save'}
              </button>
            </div>
          </Field>

          <Field label="Target language">
            <Select value={props.targetLang} onChange={props.onTargetChange}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Output device"
            hint="Use headphones to avoid the mic re-capturing translated audio (feedback)."
          >
            <Select value={props.outputDeviceId} onChange={props.onDeviceChange}>
              <option value="default">System default</option>
              {props.outputDevices
                .filter((d) => d.deviceId && d.deviceId !== 'default')
                .map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Rate $/1M · input">
              <input
                type="number"
                step="0.5"
                value={props.rates.input}
                onChange={(e) =>
                  props.persistRates({ ...props.rates, input: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm tabular-nums outline-none transition focus:border-accent"
              />
            </Field>
            <Field label="Rate $/1M · output">
              <input
                type="number"
                step="0.5"
                value={props.rates.output}
                onChange={(e) =>
                  props.persistRates({ ...props.rates, output: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm tabular-nums outline-none transition focus:border-accent"
              />
            </Field>
          </div>

          <div className="space-y-1 rounded-xl border border-border bg-background/40 p-1">
            <Toggle
              checked={props.playAudio}
              onChange={props.setPlayAudio}
              title="Play translated audio"
              desc="Uncheck for subtitles only — avoids any feedback."
            />
            <Toggle
              checked={props.echo}
              onChange={props.onEchoChange}
              title="Echo target-language audio"
              desc="Pass through audio that's already in the target language."
            />
          </div>
        </div>

        {/* Modal footer */}
        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={props.onClose}
            className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-elevated"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/* =========================== Usage modal =========================== */

function UsageModal(props: {
  onClose: () => void
  usage: Usage
  sessionCost: number
  totalCost: number
  rates: { input: number; output: number }
  running: boolean
  onResetTotal: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const { usage, rates } = props
  const totalTokens = usage.inputTokens + usage.outputTokens
  const audio = estimateAudioSeconds(usage)
  const inCost = (usage.inputTokens / 1_000_000) * rates.input
  const outCost = (usage.outputTokens / 1_000_000) * rates.output

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        className="no-drag flex max-h-[88vh] w-full max-w-md animate-pop-in flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Token usage</h2>
            <p className="text-[11px] text-muted">
              {props.running ? 'Live — this session so far' : 'This session'}
            </p>
          </div>
          <button
            onClick={props.onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-foreground"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {/* Token breakdown */}
          <div className="grid grid-cols-2 gap-3">
            <UsageCard
              label="Input"
              value={formatTokens(usage.inputTokens)}
              unit="tok"
              sub={`≈ ${formatDuration(audio.input)} audio · ${formatUsd(inCost)}`}
            />
            <UsageCard
              label="Output"
              value={formatTokens(usage.outputTokens)}
              unit="tok"
              sub={`≈ ${formatDuration(audio.output)} audio · ${formatUsd(outCost)}`}
              accent
            />
          </div>

          {/* Total + cost */}
          <div className="grid grid-cols-2 gap-3">
            <UsageCard label="Total tokens" value={formatTokens(totalTokens)} unit="tok" />
            <UsageCard label="Session cost" value={formatUsd(props.sessionCost)} />
          </div>

          {/* All-time */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-background/40 px-4 py-3">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
                Total spent · all time
              </div>
              <div className="font-mono text-[17px] font-semibold tabular-nums text-foreground">
                {formatUsd(props.totalCost)}
              </div>
            </div>
            <button
              onClick={props.onResetTotal}
              className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-medium text-muted transition hover:border-red-400/40 hover:text-red-400"
            >
              Reset
            </button>
          </div>

          <p className="text-[11px] leading-relaxed text-faint">
            Token counts come straight from the API. Cost = tokens × your rates
            (input&nbsp;${rates.input}/1M, output&nbsp;${rates.output}/1M — editable in
            Settings). Audio estimates assume ~32 tok/s in, ~25 tok/s out.
          </p>
        </div>
      </div>
    </div>
  )
}

function UsageCard(props: {
  label: string
  value: string
  unit?: string
  sub?: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-background/40 px-4 py-3">
      <div
        className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${
          props.accent ? 'text-accent' : 'text-faint'
        }`}
      >
        {props.label}
      </div>
      <div className="font-mono text-[17px] font-semibold tabular-nums text-foreground">
        {props.value}
        {props.unit && <span className="ml-1 text-[11px] font-normal text-faint">{props.unit}</span>}
      </div>
      {props.sub && <div className="mt-0.5 text-[10px] text-faint">{props.sub}</div>}
    </div>
  )
}

/* =========================== Settings primitives =========================== */

function Field(props: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="mt-1.5 text-[11px] text-faint">{props.hint}</p>}
    </div>
  )
}

function Select(props: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative">
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2 pr-9 text-sm outline-none transition focus:border-accent"
      >
        {props.children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">
        <ChevronIcon />
      </span>
    </div>
  )
}

function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left transition hover:bg-surface-2"
    >
      <span>
        <span className="block text-[13px] font-medium text-foreground">{props.title}</span>
        <span className="block text-[11px] text-faint">{props.desc}</span>
      </span>
      <span
        className={`relative h-5.5 w-9.5 shrink-0 rounded-full transition-colors ${
          props.checked ? 'bg-accent' : 'bg-border-strong'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${
            props.checked ? 'translate-x-4.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}

/* =========================== Icons =========================== */

function MicIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v3" />
    </svg>
  )
}

function HeadphonesIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
      <path d="M21 15a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2zM3 15a2 2 0 0 0 2 2h1v-5H5a2 2 0 0 0-2 2z" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function CoffeeIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <path d="M6 2v2M10 2v2M14 2v2" />
    </svg>
  )
}

function ChartIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="5" rx="0.5" />
      <rect x="12" y="8" width="3" height="9" rx="0.5" />
      <rect x="17" y="5" width="3" height="12" rx="0.5" />
    </svg>
  )
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function StopIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
