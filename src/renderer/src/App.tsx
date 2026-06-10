import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LANGUAGES, labelFor } from './lib/languages'
import {
  costUsd,
  formatUsd,
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

  const captureRef = useRef<SystemAudioCapture | null>(null)
  const playerRef = useRef<TranslatedAudioPlayer | null>(null)
  const clientRef = useRef<LiveTranslateClient | null>(null)
  const origRef = useRef<HTMLDivElement | null>(null)
  const transRef = useRef<HTMLDivElement | null>(null)

  const running = status === 'connecting' || status === 'listening'
  const sessionCost = costUsd(sessionUsage, rates.input, rates.output)

  // ---- initial load ----
  useEffect(() => {
    window.api.getSettings().then((s) => {
      setApiKey(s.apiKey)
      setKeySaved(s.hasApiKey)
      setTargetLang(s.targetLang)
      setEcho(s.echoTargetLanguage)
      setOutputDeviceId(s.outputDeviceId)
      setTotalCost(s.totalCostUsd)
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

  const statusColor =
    status === 'listening'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400'
        : status === 'error'
          ? 'bg-rose-500'
          : 'bg-slate-500'

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="drag-region flex items-center justify-between border-b border-white/5 px-5 py-3 pt-6">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-lg">
            🎧
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">live-trans</h1>
            <p className="text-[11px] text-slate-400">
              Gemini 3.5 Live Translate · system audio → {labelFor(targetLang).split(' ')[0]}
            </p>
          </div>
        </div>
        <div className="no-drag flex items-center gap-3">
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`h-2 w-2 rounded-full ${statusColor} ${running ? 'animate-pulse' : ''}`} />
            {status}
          </span>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="no-drag rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      {/* Settings panel */}
      {showSettings && (
        <section className="border-b border-white/5 bg-slate-900/60 px-5 py-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Gemini API key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="AIza…"
                  className="flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                />
                <button
                  onClick={saveKey}
                  className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium hover:bg-indigo-400"
                >
                  {keySaved ? 'Update' : 'Save'}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Stored encrypted on this device via the OS keychain.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Target language</label>
              <select
                value={targetLang}
                onChange={(e) => onTargetChange(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">
                Output device (use headphones to avoid feedback)
              </label>
              <select
                value={outputDeviceId}
                onChange={(e) => onDeviceChange(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              >
                <option value="default">System default</option>
                {outputDevices
                  .filter((d) => d.deviceId && d.deviceId !== 'default')
                  .map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Rate in $/1M (input)
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={rates.input}
                  onChange={(e) => persistRates({ ...rates, input: Number(e.target.value) })}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Rate in $/1M (output)
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={rates.output}
                  onChange={(e) => persistRates({ ...rates, output: Number(e.target.value) })}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={playAudio}
                onChange={(e) => {
                  setPlayAudio(e.target.checked)
                  playAudioRef.current = e.target.checked
                }}
                className="h-4 w-4 accent-indigo-500"
              />
              Play translated audio (uncheck for subtitles-only — avoids any feedback)
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={echo}
                onChange={(e) => onEchoChange(e.target.checked)}
                className="h-4 w-4 accent-indigo-500"
              />
              Echo audio already in the target language (echoTargetLanguage)
            </label>

          </div>
        </section>
      )}

      {/* Transcripts */}
      <main className="grid flex-1 grid-cols-2 gap-px overflow-hidden bg-white/5">
        <Column
          title="Original"
          tone="slate"
          innerRef={origRef}
          text={original}
          empty="Detected speech appears here."
        />
        <Column
          title={`Translation · ${labelFor(targetLang).split(' ')[0]}`}
          tone="indigo"
          innerRef={transRef}
          text={translated}
          empty="Translated text appears here."
        />
      </main>

      {/* Footer */}
      <footer className="flex items-center justify-between gap-4 border-t border-white/5 bg-slate-900/60 px-5 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={toggle}
            className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition ${
              running
                ? 'bg-rose-500 hover:bg-rose-400'
                : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
            }`}
          >
            {running ? '■ Stop' : '▶ Enable translation'}
          </button>
          {/* VU meter */}
          <div className="h-2 w-28 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-emerald-400 transition-[width] duration-100"
              style={{ width: `${Math.min(100, Math.round(level * 320))}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-5 text-right text-xs">
          <Stat label="This session" value={formatUsd(sessionCost)} sub={`${sessionUsage.inputTokens + sessionUsage.outputTokens} tok`} />
          <Stat
            label="Total spent"
            value={formatUsd(totalCost)}
            sub="all time"
            onReset={async () => setTotalCost(await window.api.resetTotalCost())}
          />
        </div>
      </footer>

      {/* Status bar */}
      <div className="border-t border-white/5 bg-slate-950 px-5 py-1.5 text-[11px] text-slate-400">
        {message || 'Ready.'}
      </div>
    </div>
  )
}

// Memoized so VU-meter/cost re-renders (~10/s) don't re-render the growing transcript text.
const Column = memo(function Column(props: {
  title: string
  tone: 'slate' | 'indigo'
  text: string
  empty: string
  innerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col bg-slate-950">
      <div
        className={`px-4 py-2 text-xs font-semibold uppercase tracking-wide ${
          props.tone === 'indigo' ? 'text-indigo-300' : 'text-slate-400'
        }`}
      >
        {props.title}
      </div>
      <div ref={props.innerRef} className="flex-1 overflow-y-auto px-4 pb-4 text-[15px] leading-relaxed">
        {props.text ? (
          <p className="whitespace-pre-wrap">{props.text}</p>
        ) : (
          <p className="text-slate-600">{props.empty}</p>
        )}
      </div>
    </div>
  )
})

function Stat(props: {
  label: string
  value: string
  sub: string
  onReset?: () => void
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{props.label}</div>
      <div className="font-mono text-sm font-semibold text-slate-100">{props.value}</div>
      <div className="text-[10px] text-slate-500">
        {props.sub}
        {props.onReset && (
          <button onClick={props.onReset} className="ml-1 text-slate-500 hover:text-rose-400">
            reset
          </button>
        )}
      </div>
    </div>
  )
}
