# g2-vi-en-realtime

Live Vietnamese → English translation for Even Realities G2 smart glasses.

Audio is captured by the glasses microphone, streamed continuously to OpenAI's realtime translation model through a Cloudflare Worker relay, and rendered as English text in the heads-up display roughly a second behind the speaker. Every session also accumulates a timestamped bilingual transcript you can save afterwards.

Built because the G2's built-in Translate app doesn't support Vietnamese.

## Table of contents

- [How it works](#how-it-works)
- [The two repositories](#the-two-repositories)
- [Design notes](#design-notes)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1. Deploy the relay](#1-deploy-the-relay)
  - [2. Configure this app](#2-configure-this-app)
  - [3. Run in development](#3-run-in-development)
  - [4. Package and install](#4-package-and-install)
- [Using the app](#using-the-app)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Adapting to other languages](#adapting-to-other-languages)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Costs](#costs)
- [Credits](#credits)

## How it works

```
G2 microphone
    │  PCM s16le, 16 kHz, mono
    ▼
Even Realities app  (WebView on your phone — this repo's code runs here)
    │  resampled to 24 kHz, base64-encoded PCM16
    │  WebSocket
    ▼
Cloudflare Worker relay  (separate repo — holds the OpenAI API key)
    │  WebSocket
    ▼
OpenAI  gpt-realtime-translate  (/v1/realtime/translations)
    │  session.input_transcript.delta   → Vietnamese source
    │  session.output_transcript.delta  → English translation
    ▼
back down the same path → G2 display + session transcript
```

A "G2 app" is a lightweight web application running inside a WebView hosted by the Even Realities phone app. The glasses themselves have no network stack and no compute for this — they are a Bluetooth display and microphone. Your phone does the work, but you never have to look at it.

## The two repositories

This project is split across two repos because they deploy to entirely different places and share no code.

| Repo | What it is | Where it runs |
|---|---|---|
| `g2-vi-en-realtime` (this one) | The glasses app. Vite + TypeScript, packaged into an `.ehpk` bundle. | Installed on your phone via Even Hub |
| [`g2-relay`](https://github.com/carlmasters02/g2-relay) | A ~60-line Cloudflare Worker that proxies WebSocket traffic to OpenAI. | Cloudflare's edge, free tier |

> Update that link to your actual relay repo URL before publishing.

You need both. This app will not function without a deployed relay — it has no OpenAI credentials of its own, by design. Set up the relay first.

### Why a relay exists

Browsers cannot set custom headers on WebSocket connections, so the WebView cannot authenticate to OpenAI directly. OpenAI's documented browser path is WebRTC with a server-minted ephemeral client secret, but that assumes audio from `getUserMedia` — here the audio arrives from the Even SDK instead, so WebRTC's media-track model doesn't fit.

A relay solves both problems at once and brings a bonus: the OpenAI key lives in a Cloudflare secret rather than being compiled into the shipped bundle. Vite inlines every `VITE_*` variable at build time, so any key referenced from client code ends up as plaintext inside the distributed `.ehpk`.

## Design notes

**Streaming, not batch.** An earlier version of this project used a batch pipeline: buffer audio locally behind a hand-rolled voice-activity detector, wrap each chunk in a WAV header, POST it for transcription, then translate the resulting text. It worked, but accuracy sat well below what the model was capable of, and latency ran 10–12 seconds.

The problem was the chunk boundaries. Batch transcription needs a complete audio file, so the client has to decide where utterances end. Every threshold is a compromise: cut too eagerly and the model receives fragments too short to establish context; cut too late and the user waits. Vietnamese punishes this especially hard — it's tonal and largely monosyllabic, so a clipped syllable becomes a different word rather than a partial one. Symptoms included whole missing sentences, semantic inversions (a "used to X, but now Y" contrast collapsing into "X, and now more X"), and occasional output in languages nobody had spoken.

`gpt-realtime-translate` removes the decision entirely. Audio streams continuously — including the silence between phrases — and the model handles its own endpointing with full acoustic context. No VAD, no thresholds, no chunk size. If you are extending this code, resist the urge to add silence gating back; it is precisely what this architecture exists to eliminate.

**Two transcript streams.** The API emits the source-language transcript and the translated transcript as separate event streams, so bilingual capture costs nothing extra. Under the old design it required a second API call per chunk.

## Prerequisites

- Even Realities G2 glasses, paired and on current firmware
- Even Realities account, used consistently across the phone app and [hub.evenrealities.com](https://hub.evenrealities.com)
- Node.js v20+ (v22 or v24 recommended)
- OpenAI account at usage Tier 1 or higher. The free tier cannot access `gpt-realtime-translate` at all. Tier 1 allows 50 minutes of audio per minute; Tier 2 allows 200.
- Cloudflare account (free tier) for the relay
- A way for your phone to reach your dev server during development — see [Development networking](#development-networking)

## Setup

### 1. Deploy the relay

Follow the README in the `g2-relay` repo. In short:

```bash
git clone https://github.com/carlmasters02/g2-relay
cd g2-relay
npm install
npx wrangler login

openssl rand -hex 16          # save this — it's your RELAY_SECRET

npx wrangler secret put OPENAI_API_KEY    # your OpenAI key
npx wrangler secret put RELAY_SECRET      # the value you just generated
npx wrangler deploy
```

Note the deployed URL — something like `https://g2-relay.carlmasters1031.workers.dev`. You need both that hostname and the relay secret in the next step.

Verify the relay reaches OpenAI before continuing. The relay repo includes a `test.js` for this; a healthy run prints `session.created` followed by `session.updated`.

### 2. Configure this app

```bash
git clone https://github.com/carlmasters02/g2-vi-en-realtime
cd g2-vi-en-realtime
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```
VITE_STT_API_KEY=unused
VITE_RELAY_SECRET=<the RELAY_SECRET you generated>
```

`VITE_STT_API_KEY` exists only to satisfy a startup guard inherited from the upstream template. Nothing reads its value — the literal string `unused` is correct. **Do not put an OpenAI key here.** It belongs in the Worker.

Then point the app and its manifest at your relay:

- `src/asr/stt.ts` — update the WebSocket hostname
- `app.json` — update the `network` permission whitelist to your relay hostname

The whitelist takes a bare hostname, no scheme:

```json
{
  "name": "network",
  "desc": "Stream audio to the translation relay.",
  "whitelist": ["g2-relay.carlmasters1031.workers.dev"]
}
```

`evenhub pack` rejects an app that reaches external hosts without declaring them, and it rejects an empty whitelist.

Also set a `package_id` unique to you. The upstream template ships `com.example.evenhubasr`, which may be rejected and will collide with any other app built from the same scaffold.

### 3. Run in development

```bash
npm run dev
```

Then expose it to your phone and sideload:

```bash
npx evenhub qr --url http://<your-lan-ip>:5173
```

Scan in the Even Realities app: **Even Hub** tab → developer section → **Scan QR**.

If you can't find the developer section, force-quit the Even Realities app completely and reopen it. The section only appears after a restart following sign-in at [hub.evenrealities.com](https://hub.evenrealities.com).

A desktop simulator is also available for UI work without wearing the glasses:

```bash
npm run simulate
```

The simulator cannot exercise the real microphone, so it won't validate the audio path.

#### Development networking

QR sideloading requires your phone to reach your laptop directly. Three things commonly prevent that:

- **Firewall.** On Fedora, check which zone your interface is in — `firewall-cmd --get-active-zones`. If it's `drop`, opening the port on the default zone does nothing; you must target that zone specifically: `sudo firewall-cmd --zone=drop --add-port=5173/tcp`
- **AP isolation.** Many managed and apartment-provided networks block client-to-client traffic entirely. No firewall change helps.
- **Vite binding.** The template binds to all interfaces already; confirm the `Network:` line appears in the dev server output.

If direct LAN access is unavailable, tunnel instead:

```bash
cloudflared tunnel --url http://localhost:5173
npx evenhub qr --url https://<generated>.trycloudflare.com
```

`vite.config.ts` already allows `.trycloudflare.com` hosts. Without that entry Vite rejects the request with "Blocked request. This host is not allowed."

Note that a quick tunnel is publicly reachable by anyone who guesses the URL. It's ephemeral and randomly named, which is acceptable for a dev session, but don't leave one running unattended.

### 4. Package and install

```bash
npm run build
npx evenhub login
npx evenhub pack app.json dist -o vitranslate-rt.ehpk
```

Then upload at [hub.evenrealities.com/developer](https://hub.evenrealities.com/developer) → **Create Private App** (the button may read "Upload package").

Force-quit and reopen the phone app. Your app now appears in your library and runs with no laptop, dev server, or tunnel involved — the relay is always up on Cloudflare.

When shipping an update, bump `version` in `app.json` first; the hub may reject a duplicate version string.

## Using the app

Launch it from the Even Realities app menu with the glasses on.

| Action | Effect |
|---|---|
| Tap the temple | Pause / resume capture |
| Double-tap the temple | Exit (system confirmation dialog appears) |
| Save transcript (companion page) | Share sheet → clipboard → download, first that works |

The glasses show a rolling window of translated English. The companion page — the app's view on your phone — shows the full session, a live entry count, and the save control. You never need to look at it during normal use; it exists for saving transcripts and surfacing errors.

Transcripts are timestamped bilingual pairs, one file per session:

```
[00:14]
VI: Xin chào, tôi tên là Đức, năm nay tôi 22 tuổi.
EN: Hello, my name is Duc, I am 22 years old.
```

Timestamps are session-relative and accumulate past 59 minutes rather than rolling into hours — `[75:04]` is 75 minutes in.

Entries are persisted as they arrive rather than written on exit, because exit events are unreliable — a crash or a Bluetooth drop may produce `ABNORMAL_EXIT_EVENT` or nothing at all.

On saving: WebViews commonly block programmatic downloads, so the save button tries the Web Share API first (hands the file to your system share sheet), falls back to clipboard, and only then attempts a direct download.

## Project layout

| File | Purpose |
|---|---|
| `src/main.ts` | App entry. Creates the display container, starts the mic, routes PCM to `stt.ts`, renders snapshots with a 120 ms debounce, handles tap and double-tap. |
| `src/asr/stt.ts` | The streaming translation client. Resampling, WebSocket lifecycle, event handling, utterance flushing. |
| `src/asr/transcript.ts` | Session transcript: timestamped bilingual entries, continuous persistence, save/share UI. |
| `src/asr/filter.ts` | Drops known model filler ("Thank you for watching", `[Music]`, etc.) at utterance boundaries. |
| `src/ui.ts` | Companion page — status chip, live transcript mirror. |
| `app.json` | Manifest: `g2-microphone` and `network` permissions, package ID, version. |
| `.env.example` | Required variable names. Committed; `.env.local` is not. |

## Configuration

Most of the old tuning surface is gone — the model handles endpointing. What remains:

**Target language** — `src/asr/stt.ts`, in the `session.update` sent on connect:

```ts
{ type: 'session.update', session: { audio: { output: { language: 'en' } } } }
```

This message is not optional. A translation session defaults to Spanish output. If it fails to arrive before the first audio, your first utterance comes back in Spanish. The client buffers it and flushes on socket open specifically to guarantee ordering.

**Display trim** — `src/main.ts` limits rendered text to the last 240 characters, sized for the 576×288 container at the default font. There is no font-size API.

**Render debounce** — 120 ms in `main.ts`. The BLE render queue cannot keep up with per-token writes; lowering this causes visible flicker and dropped frames.

## Adapting to other languages

The source language is auto-detected, so nothing needs changing to translate from a different language into English.

To translate into a language other than English, change the `language` field in `session.update` to the appropriate code. One session handles one output language; multiple targets require multiple sessions.

The hallucination filter in `src/asr/filter.ts` contains English-specific patterns and would need revisiting for a different target.

## Security

**No OpenAI key is present in this repo or in the built bundle.** It lives as a Cloudflare secret, accessible only to the Worker.

**The relay secret is in the built bundle.** Vite inlines `VITE_RELAY_SECRET` at build time, so it exists in plaintext inside your `.ehpk`. This is a deliberate trade: that secret grants access only to your relay, not to your OpenAI account, and rotating it takes seconds:

```bash
npx wrangler secret put RELAY_SECRET   # new value
# update .env.local, rebuild, repack, re-upload
```

Do not remove the secret gate from the Worker. A `workers.dev` URL is publicly reachable; without the gate, anyone who discovers it can stream audio billed to your account.

Set a spend limit on the OpenAI project backing this app, and use a project-scoped key rather than a default-project one.

`.gitignore` covers `.env*` (excluding `.env.example`), `dist/`, and `*.ehpk`. Verify with `git check-ignore -v .env.local` after cloning. Note that `git check-ignore -v` exits 0 for negated patterns too, so use `-q` or `git add --dry-run` when you want an unambiguous answer.

## Troubleshooting

**`beta_api_shape_disabled` error from OpenAI**
The relay is requesting the retired beta API shape. Remove `'openai-beta.realtime-v1'` from the WebSocket subprotocol array in the Worker. Keep `'realtime'` and the `openai-insecure-api-key.*` entry. The `/v1/realtime/translations` endpoint itself is current — don't change it to `/v1/realtime`, which is the voice-agent endpoint with different semantics.

**First utterance comes back in Spanish**
`session.update` didn't reach OpenAI before audio started. Confirm the client buffers pre-open messages and flushes them on `open`.

**401 from the relay**
`VITE_RELAY_SECRET` in `.env.local` doesn't match the Worker's `RELAY_SECRET`. Remember that Vite reads `.env.local` at startup — restart the dev server after editing it.

**Nothing appears on the glasses**
Check the status chip on the companion page; errors surface there rather than on the HUD. Also confirm `g2-microphone` is declared in `app.json` — without it the mic returns silence with no error.

**QR scans but the app never loads**
Network, not code. Test the URL in your phone's browser first: a timeout means firewall or AP isolation, a "Blocked request" message means Vite's `allowedHosts`.

**`evenhub pack` rejects the manifest**
Usually the `network` permission. The whitelist must be non-empty and entries are bare hostnames without a scheme.

**A single tap doesn't register**
`CLICK_EVENT` is 0, and protobuf omits zero-valued fields on the wire, so a tap arrives with `eventType` undefined. Resolve the default inside the envelope check, not on the envelope itself — otherwise every audio frame fires the tap handler.

**Save button does nothing**
Expected in some WebViews. The clipboard fallback should engage; if the button text changes to "Copied to clipboard", it worked.

## Known limitations

- **Requires network.** Audio is translated in the cloud. No connectivity, no translation.
- **Requires the phone.** The G2 has no independent network stack. The phone can stay in your pocket, but it must be present and paired.
- **Audio quality dominates accuracy.** A speaker near your face performs substantially better than a recording played across a room. The mic is 16 kHz mono and lossy over BLE; degraded input degrades output, and no amount of prompt or parameter tuning recovers detail that never arrived.
- **One session, one output language.**
- **The relay is a single point of failure.** If the Worker is down or misconfigured, the app cannot translate.
- **Transcripts are per-session** and not persisted across launches by design. Save before exiting if you want to keep one.

## Costs

`gpt-realtime-translate` is billed by audio duration at **$0.034 per minute** — roughly two cents for a half-hour conversation. Cloudflare Workers' free tier is comfortably sufficient for personal use.

## Credits

Scaffolded from the official Even Realities `asr` template, which ships a provider-agnostic STT stub. This project replaces that stub with a streaming translation client.

Built on OpenAI's realtime translation API.
