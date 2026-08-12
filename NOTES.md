# NOTES

## Current state
Streaming translation (Vietnamese → English) over the deployed Cloudflare
Worker relay. Real end-to-end — nothing mocked in the audio or network path.

- [src/asr/stt.ts](src/asr/stt.ts) — replaced the throwing template stub with a
  WebSocket client to `wss://g2-relay.carlmasters1031.workers.dev`.
- [src/asr/transcript.ts](src/asr/transcript.ts) — **newly created** (see below).
- [src/main.ts](src/main.ts) — untouched; the `startSttStream` contract is unchanged.
- `app.json` — added the `network` permission with the relay host, required
  before `evenhub pack`.

## Decisions
- **Resampling 16k → 24k** happens in `sendPcm`, linear interpolation, with the
  previous chunk's last sample and the fractional read position carried across
  calls so there is no seam per frame. Verified against a one-shot resample of
  the same signal: identical to rounding error, for frame sizes down to 2 bytes
  and for odd-length frames.
- **No VAD / silence gating.** Audio streams continuously; the model does its
  own endpointing.
- `session.update` (English output) is sent on `open` before anything else —
  the session otherwise defaults to Spanish.
- **Utterance flush:** deltas arrive token-by-token, so both languages
  accumulate and `addEntry(vi, en)` fires once per utterance, when the English
  buffer hits sentence-ending punctuation. Both buffers reset after each flush.
- `close()` sends `session.close` and keeps reading until `session.closed`
  rather than closing immediately, so draining translation isn't lost. A 3 s
  backstop timer prevents a hang if the relay never acknowledges — that timeout
  is my addition, not in the spec.
- The `apiKey` argument is accepted and ignored; the OpenAI key lives in the
  Worker. `VITE_RELAY_SECRET` comes from `.env.local`.

## Premises that didn't match the repo
- There was **no batch STT code to delete** — no WAV header construction, RMS,
  silence constants, promise queue, or fetch calls. `stt.ts` was the blank
  template stub that just threw.
- `src/asr/transcript.ts` **did not exist**. I created a minimal one exporting
  `addEntry(vi, en)` (plus `getEntries` / `clearEntries`) so the described
  integration has something to bind to. If the intended version lives
  elsewhere, drop it in — the import in `stt.ts` needs no change.
- `src/asr/filter.ts` was missing initially; it now exists and
  `isHallucination` is applied in `flushUtterance()` — once per utterance,
  never per-delta (a lone "Thank" would trip it constantly). A rejected
  utterance is skipped for `addEntry` **and** retracted from the displayed
  English, since deltas are appended live and it is already on screen by flush
  time.
- `main.ts` still gates startup on `VITE_STT_API_KEY` being set, so `.env.local`
  needs both it and `VITE_RELAY_SECRET`. Its value is never used or sent.

## Not yet verified
`npm run build` passes (`tsc --noEmit` clean). The relay handshake, event
names, and delta field shape have **not** been exercised against the live
Worker — that needs a device or the simulator.
