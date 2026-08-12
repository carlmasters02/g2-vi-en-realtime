// Session transcript: timestamped bilingual entries, persisted continuously.
//
// stt.ts accumulates both languages delta-by-delta and calls addEntry once per
// utterance, so `vi` and `en` are a matched pair rather than a token pair.
//
// Entries are mirrored to sessionStorage as they arrive rather than written on
// exit. Exit events on this platform are unreliable — a crash or a Bluetooth
// drop may fire ABNORMAL_EXIT_EVENT or nothing at all — so a save-on-exit
// design loses the session it was meant to protect.

export interface TranscriptEntry {
  /** Vietnamese source, as transcribed. */
  vi: string
  /** English translation. */
  en: string
  /** Milliseconds since the session started. */
  elapsedMs: number
}

interface StoredSession {
  startedAt: number
  entries: TranscriptEntry[]
}

const STORAGE_KEY = 'g2-vi-en-transcript'
const DIVIDER = '─'.repeat(50)
const COPIED_LABEL_MS = 2000
const OBJECT_URL_TTL_MS = 10000

let startedAt = Date.now()
let entries: TranscriptEntry[] = []

let countEl: HTMLSpanElement | null = null
let saveEl: HTMLButtonElement | null = null
let labelTimer: number | null = null

// ── session state ────────────────────────────────────────────────────────────

/**
 * Writes the whole session to sessionStorage. A full or unavailable store must
 * never break capture, so every failure here is swallowed — the in-memory
 * session remains authoritative.
 */
function persist(): void {
  try {
    const payload: StoredSession = { startedAt, entries }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Quota exceeded, private-mode storage, or no sessionStorage at all.
  }
}

/** Recovers a session left behind by a reload within the same WebView tab. */
function restore(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.startedAt !== 'number' || !Array.isArray(parsed.entries)) return
    startedAt = parsed.startedAt
    entries = parsed.entries.filter(
      (e): e is TranscriptEntry =>
        !!e && typeof e.vi === 'string' && typeof e.en === 'string' && typeof e.elapsedMs === 'number',
    )
  } catch {
    // Unreadable or corrupt payload: start clean rather than fail to load.
  }
}

restore()

export function addEntry(vi: string, en: string): void {
  entries.push({ vi, en, elapsedMs: Date.now() - startedAt })
  persist()
  syncUi()
}

export function getEntries(): readonly TranscriptEntry[] {
  return entries
}

export function clearEntries(): void {
  entries = []
  persist()
  syncUi()
}

/** Starts a new session: clears entries and restarts the elapsed-time clock. */
export function resetSession(): void {
  startedAt = Date.now()
  entries = []
  persist()
  syncUi()
}

// ── formatting ───────────────────────────────────────────────────────────────

/** Elapsed milliseconds as zero-padded MM:SS. Minutes run past 59 rather than rolling over. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function buildTranscript(): string {
  const header = [
    'Vietnamese → English transcript',
    `Session started: ${new Date(startedAt).toLocaleString()}`,
    `Entries: ${entries.length}`,
    '',
    DIVIDER,
    '',
    '',
  ].join('\n')

  const body = entries
    .map(e => `[${formatElapsed(e.elapsedMs)}]\nVI: ${e.vi}\nEN: ${e.en}`)
    .join('\n\n')

  return `${header}${body}\n`
}

function filename(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `transcript-${stamp}.txt`
}

// ── companion-page UI ────────────────────────────────────────────────────────

function syncUi(): void {
  if (countEl) countEl.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
  if (saveEl && labelTimer === null) saveEl.disabled = entries.length === 0
}

/** Briefly swaps the button label, then restores it. */
function flashLabel(text: string): void {
  if (!saveEl) return
  const button = saveEl
  if (labelTimer !== null) window.clearTimeout(labelTimer)
  button.textContent = text
  labelTimer = window.setTimeout(() => {
    labelTimer = null
    button.textContent = 'Save transcript'
    syncUi()
  }, COPIED_LABEL_MS)
}

/**
 * Saves the session, trying each route in turn and stopping at the first that
 * works. WebViews commonly block programmatic downloads, so the share sheet is
 * the reliable path and `a.download` is a last resort.
 */
async function save(): Promise<void> {
  if (entries.length === 0) return
  const text = buildTranscript()
  const name = filename()

  // 1. Share sheet, which hands a real file to the OS.
  try {
    const file = new File([text], name, { type: 'text/plain' })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Transcript' })
      return
    }
  } catch {
    // Dismissing the share sheet rejects; fall through to the next route.
  }

  // 2. Clipboard.
  try {
    await navigator.clipboard.writeText(text)
    flashLabel('Copied to clipboard')
    return
  } catch {
    // No clipboard permission or no secure context.
  }

  // 3. Direct download.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS)
}

/** Mounts the fixed save bar at the bottom of the companion page. */
export function installTranscriptUi(): void {
  if (saveEl) return // already installed

  injectStyles()

  const bar = document.createElement('div')
  bar.className = 'transcript-bar'

  const count = document.createElement('span')
  count.className = 'transcript-count'
  count.setAttribute('aria-live', 'polite')

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'transcript-save'
  button.textContent = 'Save transcript'
  button.addEventListener('click', () => {
    void save()
  })

  bar.append(count, button)
  document.body.appendChild(bar)

  countEl = count
  saveEl = button
  syncUi()
}

function injectStyles(): void {
  // Matches ui.ts: ER brand dark surfaces #232323 / #2E2E2E / #3E3E3E,
  // OS green #3CFA44 for the action.
  const css = `
    .panel { padding-bottom: 88px; }
    .transcript-bar { position: fixed; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      box-sizing: border-box; padding: 12px 24px calc(12px + env(safe-area-inset-bottom));
      background: #2E2E2E; border-top: 1px solid #3E3E3E; }
    .transcript-count { font-size: 13px; color: #A7A7A7; letter-spacing: 0.02em; }
    .transcript-save { font: inherit; font-size: 14px; font-weight: 600;
      padding: 10px 18px; border-radius: 999px; border: 1px solid #3CFA44;
      background: rgba(60,250,68,0.10); color: #3CFA44; cursor: pointer;
      touch-action: manipulation; }
    .transcript-save:disabled { border-color: #3E3E3E; background: transparent;
      color: #7B7B7B; cursor: default; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
