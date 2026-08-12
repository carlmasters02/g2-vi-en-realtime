// In-memory transcript log: one entry per translated utterance.
//
// stt.ts accumulates both languages delta-by-delta and calls addEntry once per
// utterance, so `vi` and `en` are a matched pair rather than a token pair.

export interface TranscriptEntry {
  /** Vietnamese source, as transcribed. */
  vi: string
  /** English translation. */
  en: string
  /** Epoch milliseconds at which the utterance was flushed. */
  at: number
}

const entries: TranscriptEntry[] = []

export function addEntry(vi: string, en: string): void {
  entries.push({ vi, en, at: Date.now() })
}

export function getEntries(): readonly TranscriptEntry[] {
  return entries
}

export function clearEntries(): void {
  entries.length = 0
}
