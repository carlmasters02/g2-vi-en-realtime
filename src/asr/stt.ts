// Streaming translation client for the G2 microphone.
//
// The G2 mic emits PCM s16le @ 16 kHz, mono via `bridge.audioControl(true)`.
// Each onEvenHubEvent callback with `audioEvent.audioPcm` delivers a chunk,
// which main.ts hands to `sendPcm`.
//
// Audio goes to OpenAI's realtime translation API through an already-deployed
// Cloudflare Worker relay, which holds the OpenAI key. The relay wants
// base64-encoded PCM16 @ 24 kHz, so every chunk is resampled 16k -> 24k
// (linear interpolation) before it is encoded and appended to the session's
// input audio buffer.
//
// Endpointing is the model's job: audio streams continuously, silence
// included. There is deliberately no VAD or silence gating here.

import { isHallucination } from './filter'
import { addEntry } from './transcript'

export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

const RELAY_ORIGIN = 'wss://g2-relay.carlmasters1031.workers.dev'
const INPUT_RATE = 16000
const OUTPUT_RATE = 24000
const RESAMPLE_STEP = INPUT_RATE / OUTPUT_RATE // input samples advanced per output sample

// A translated utterance is flushed to the transcript log when the English
// stream reaches sentence-ending punctuation, allowing for trailing quotes or
// brackets that arrive in the same delta.
const SENTENCE_END = /[.!?…][)\]"'”’\s]*$/

/**
 * Resamples 16 kHz PCM s16le to 24 kHz, keeping interpolation continuous
 * across chunk boundaries.
 *
 * Two pieces of state survive between calls: the final sample of the previous
 * chunk (the left-hand endpoint for output samples that straddle the seam) and
 * the fractional read position. Resampling each chunk independently would put
 * a discontinuity at every frame.
 */
class Resampler {
  /** Last sample of the previous chunk, addressed as local index -1. */
  private tail = 0
  private hasTail = false
  /** Position of the next output sample, in input samples relative to chunk start. */
  private pos = 0
  /** Odd trailing byte from the previous chunk — half of a split sample. */
  private carryByte: number | null = null

  process(chunk: Uint8Array): Uint8Array | null {
    const samples = this.toSamples(chunk)
    const n = samples.length
    if (n === 0) return null

    // Emit while the right-hand interpolation endpoint is still in range. This
    // leaves `pos` in [n - 1, n - 1 + step), so after rebasing it lands in
    // [-1, 0) and the next chunk needs only one carried sample.
    const out: number[] = []
    while (this.pos < n - 1) {
      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const a = i < 0 ? this.tail : samples[i]
      const b = samples[i + 1]
      out.push(a + (b - a) * frac)
      this.pos += RESAMPLE_STEP
    }

    this.tail = samples[n - 1]
    this.hasTail = true
    this.pos -= n

    if (out.length === 0) return null

    const bytes = new Uint8Array(out.length * 2)
    const view = new DataView(bytes.buffer)
    for (let j = 0; j < out.length; j++) {
      const s = Math.max(-32768, Math.min(32767, Math.round(out[j])))
      view.setInt16(j * 2, s, true) // little-endian, regardless of host order
    }
    return bytes
  }

  /** Decodes s16le bytes, carrying a split sample across the chunk boundary. */
  private toSamples(chunk: Uint8Array): Int16Array {
    let bytes = chunk
    if (this.carryByte !== null) {
      const joined = new Uint8Array(chunk.length + 1)
      joined[0] = this.carryByte
      joined.set(chunk, 1)
      bytes = joined
      this.carryByte = null
    }

    const count = bytes.length >> 1
    if (bytes.length & 1) this.carryByte = bytes[bytes.length - 1]

    const samples = new Int16Array(count)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true)

    // First chunk ever: start interpolating at the first real sample.
    if (!this.hasTail && count > 0) this.tail = samples[0]
    return samples
  }
}

/** btoa over a binary string built in slices — spreading a large array overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += SLICE) {
    const slice = bytes.subarray(i, i + SLICE)
    let s = ''
    for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j])
    binary += s
  }
  return btoa(binary)
}

export function startSttStream(
  _apiKey: string, // unused: the OpenAI key lives in the Worker relay
  onSnapshot: (snap: SttSnapshot) => void,
  onError?: (err: unknown) => void,
): SttClient {
  const secret = import.meta.env.VITE_RELAY_SECRET as string | undefined
  if (!secret) {
    throw new Error('VITE_RELAY_SECRET not set — copy .env.example to .env.local')
  }

  const ws = new WebSocket(`${RELAY_ORIGIN}/?key=${encodeURIComponent(secret)}`)
  const resampler = new Resampler()

  // Frames that arrive before the socket opens; flushed in order on 'open'.
  const pending: string[] = []

  let englishAll = '' // every English delta, for the on-glasses display
  let englishUtterance = '' // English since the last transcript flush
  let vietnameseUtterance = '' // Vietnamese since the last transcript flush

  let closeRequested = false
  let finished = false
  let drainTimer: number | null = null

  function fail(err: unknown) {
    onError?.(err)
  }

  function send(payload: unknown) {
    const json = JSON.stringify(payload)
    if (ws.readyState === WebSocket.OPEN) ws.send(json)
    else if (ws.readyState === WebSocket.CONNECTING) pending.push(json)
    // CLOSING/CLOSED: nothing to send to, and close() already drained.
  }

  function emit() {
    onSnapshot({ finalText: englishAll, interimText: '', finished })
  }

  /**
   * Writes one utterance to the transcript log and resets both accumulators.
   *
   * The hallucination filter is applied here and only here — per-delta it would
   * reject single tokens ("Thank") that are fine mid-sentence. A rejected
   * utterance is also retracted from `englishAll`: deltas are appended live for
   * the on-glasses display, so by flush time it is already on screen, and
   * `englishUtterance` is by construction the exact tail of `englishAll`.
   */
  function flushUtterance() {
    const rawEnglishLength = englishUtterance.length
    const vi = vietnameseUtterance.trim()
    const en = englishUtterance.trim()
    vietnameseUtterance = ''
    englishUtterance = ''
    if (!en && !vi) return
    if (isHallucination(en)) {
      englishAll = englishAll.slice(0, englishAll.length - rawEnglishLength)
      return
    }
    addEntry(vi, en)
  }

  function finish() {
    if (finished) return
    finished = true
    if (drainTimer !== null) {
      window.clearTimeout(drainTimer)
      drainTimer = null
    }
    flushUtterance()
    emit()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
  }

  ws.addEventListener('open', () => {
    // Must precede any audio: the session defaults to Spanish output, so
    // without this the first utterance comes back in the wrong language.
    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: { audio: { output: { language: 'en' } } },
      }),
    )
    for (const json of pending) ws.send(json)
    pending.length = 0
  })

  ws.addEventListener('message', event => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as Record<string, unknown>
    } catch {
      fail(new Error(`Unparseable relay message: ${String(event.data).slice(0, 200)}`))
      return
    }

    const delta = typeof msg.delta === 'string' ? msg.delta : ''

    switch (msg.type) {
      case 'session.output_transcript.delta': // English translation
        if (!delta) break
        englishAll += delta
        englishUtterance += delta
        if (SENTENCE_END.test(englishUtterance)) flushUtterance()
        emit()
        break

      case 'session.input_transcript.delta': // Vietnamese source
        vietnameseUtterance += delta
        break

      case 'error':
        fail(msg.error ?? msg)
        break

      case 'session.closed':
        finish()
        break

      default:
        break
    }
  })

  ws.addEventListener('error', () => {
    // The browser deliberately withholds detail on WebSocket errors.
    fail(new Error('Relay WebSocket error'))
  })

  ws.addEventListener('close', event => {
    if (!finished && !closeRequested) {
      fail(new Error(`Relay connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`))
    }
    finish()
  })

  return {
    sendPcm(chunk: Uint8Array) {
      if (closeRequested || finished) return
      const resampled = resampler.process(chunk)
      if (!resampled) return
      send({ type: 'session.input_audio_buffer.append', audio: toBase64(resampled) })
    },

    close() {
      if (closeRequested) return
      closeRequested = true
      if (finished) return
      send({ type: 'session.close' })
      // Keep reading until `session.closed` so translation still draining out
      // of the session is not dropped. The timer is only a backstop against a
      // relay that never acknowledges.
      drainTimer = window.setTimeout(() => {
        drainTimer = null
        finish()
      }, 3000)
    },
  }
}
