// Gemini 3.5 Live Translate is billed on audio tokens. Exact preview rates are not
// published in a stable place, so the per-1M-token rates are EDITABLE in Settings and
// default to a conservative public estimate (~$0.03–0.04 / minute of audio).
// Token counts themselves come straight from the API's usageMetadata, so once you set
// the real rate the running total is accurate.

export const DEFAULT_INPUT_RATE_PER_M = 10.0 // USD per 1M input audio tokens
export const DEFAULT_OUTPUT_RATE_PER_M = 10.0 // USD per 1M output audio tokens

// Observed audio token throughput for the Live Translate stream — used only to turn a
// token count back into an approximate "minutes of audio" figure for the Usage panel.
export const INPUT_TOKENS_PER_SEC = 32
export const OUTPUT_TOKENS_PER_SEC = 25

export type Usage = { inputTokens: number; outputTokens: number }

// Rough audio duration each side of the stream represents, in seconds. Input ≈ the source
// audio we sent; output ≈ the translated audio we received back.
export function estimateAudioSeconds(usage: Usage): { input: number; output: number } {
  return {
    input: usage.inputTokens / INPUT_TOKENS_PER_SEC,
    output: usage.outputTokens / OUTPUT_TOKENS_PER_SEC
  }
}

export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return '0s'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function costUsd(
  usage: Usage,
  inputRatePerM = DEFAULT_INPUT_RATE_PER_M,
  outputRatePerM = DEFAULT_OUTPUT_RATE_PER_M
): number {
  return (
    (usage.inputTokens / 1_000_000) * inputRatePerM +
    (usage.outputTokens / 1_000_000) * outputRatePerM
  )
}

export function formatUsd(value: number): string {
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

// Parse the Live API usageMetadata object into input/output token counts, tolerant of
// the slightly different field names the API has used across versions.
export function parseUsage(meta: Record<string, unknown> | undefined | null): Usage {
  if (!meta) return { inputTokens: 0, outputTokens: 0 }
  const input = Number(meta['promptTokenCount'] ?? 0)
  const output = Number(
    meta['responseTokenCount'] ?? meta['candidatesTokenCount'] ?? 0
  )
  const total = Number(meta['totalTokenCount'] ?? 0)
  // Fallback: if only a total is present, treat it all as output (worst case for cost).
  if (!input && !output && total) return { inputTokens: 0, outputTokens: total }
  return { inputTokens: input, outputTokens: output }
}
