# SpriteCore STT Integration

How the `/stream/stt` endpoint works end-to-end, so a watch/phone dev can
integrate against it confidently without reading the plugin source. Mirrors
the shape of [`tts-integration.md`](tts-integration.md).

## Architecture at a glance

SpriteCore is a **streaming proxy** between the client (phone/watch) and
ElevenLabs. The client never sees the ElevenLabs API key and never talks to
ElevenLabs directly. Same key pair as TTS — ElevenLabs uses one key for both
`/v1/text-to-speech` and `/v1/speech-to-text`.

```
[client: phone or watch MicCaptureManager]
      │
      │  POST /stream/stt?model=scribe_v1&language=en&tag_audio_events=false
      │  Authorization: Bearer <operator token>
      │  Content-Type: audio/mp4    (or audio/wav, audio/ogg, audio/webm, audio/pcm;rate=16000, …)
      │  body: raw audio bytes (streamed, not buffered client-side either)
      ▼
[gateway plugin: handleSttRequest]            auth: "gateway" (enforced before handler)
      │
      │  POST https://api.elevenlabs.io/v1/speech-to-text
      │  xi-api-key: $ELEVENLABS_API_KEY      (env-loaded on gateway host only)
      │  Content-Type: multipart/form-data; boundary=----openclaw-stt-…
      │  parts:
      │    model_id         = <from ?model=, else config default>
      │    language_code    = <from ?language=, omitted if absent>
      │    tag_audio_events = <from ?tag_audio_events=, omitted if absent>
      │    diarize          = <from ?diarize=, omitted if absent>
      │    num_speakers     = <from ?num_speakers=, omitted if absent>
      │    file             = <piped from inbound body>        ← streamed through
      ▼
[ElevenLabs API]
      │
      │  200 OK, Content-Type: application/json
      │  { language_code, language_probability, text, words[] }
      ▼
[back through plugin, piped to client with chunked transfer]
```

The plugin does not buffer the audio on the way in and does not buffer the
JSON on the way out. The inbound audio body is wrapped in a manually-framed
multipart envelope: header bytes → inbound chunks → footer bytes. ElevenLabs's
response is streamed back directly. No transcoding, no re-encoding.

POST rather than GET because audio payloads blow past practical URL caps;
query-string options stay symmetrical with TTS.

## Endpoint

`POST /stream/stt` (also aliased as `/stt` for symmetry with `/tts` / `/stream/tts`).

Registered with `auth: "gateway"`, meaning the plugin HTTP dispatcher rejects
any request without a valid operator token before the handler even runs. STT
costs real money — there is no public escape hatch.

### Headers

| Header | Required | Purpose |
| --- | --- | --- |
| `Authorization: Bearer <operator token>` | yes | Gateway auth, same as `/stream/tts` |
| `Content-Type` | yes | Audio MIME. Forwarded verbatim to ElevenLabs's `file` part |
| `Content-Length` | recommended | Used for the size cap check and for ElevenLabs multipart framing |

### Query parameters

| Param | Required | Default | Multipart field sent upstream |
| --- | --- | --- | --- |
| `model` | no | plugin `streamStt.defaultModel` → `scribe_v1` | `model_id` |
| `language` | no | omitted (ElevenLabs auto-detects) | `language_code` (ISO-639-1) |
| `tag_audio_events` | no | omitted | `tag_audio_events` |
| `diarize` | no | omitted | `diarize` |
| `num_speakers` | no | omitted | `num_speakers` (positive integer) |

`tag_audio_events` and `diarize` accept `"true"` / `"false"` / `"1"` / `"0"`
(case-insensitive); malformed values are silently dropped (treated as
absent). `num_speakers` requires a positive integer; negatives/zero/NaN are
dropped.

### Accepted audio `Content-Type` values

The plugin enforces an allowlist before forwarding upstream. The base MIME
(parameters stripped) must match one of:

- `audio/mp4`
- `audio/wav` / `audio/x-wav`
- `audio/ogg`
- `audio/webm`
- `audio/flac`
- `audio/mpeg`
- `audio/pcm` — including the `audio/pcm;rate=16000` variant emitted by
  Android's `AudioRecord` default

Anything else returns `400 Unsupported Content-Type`.

### Body

Raw audio bytes. Streamed, not buffered at the plugin. Maximum size is
whatever ElevenLabs accepts (~1 GB today, but in practice utterances are
under a minute).

Optional plugin-side cap: if `streamStt.maxBodyBytes` is set in plugin
config and the inbound `Content-Length` exceeds it, the plugin rejects with
`413 Audio too large` before reading any bytes. When `Content-Length` is
absent the cap is not enforced (ElevenLabs itself bounds the size upstream).

### Response

- **200 OK** — `Content-Type: application/json`, `Transfer-Encoding: chunked`.
  Body is ElevenLabs's JSON response, passed through unchanged.

  Example shape:
  ```json
  {
    "language_code": "en",
    "language_probability": 0.98,
    "text": "Hello Ginger, can you hear me?",
    "words": [
      { "text": "Hello", "start": 0.1, "end": 0.42, "type": "word", "logprob": -0.05 },
      { "text": " ", "start": 0.42, "end": 0.43, "type": "spacing" },
      { "text": "Ginger", "start": 0.43, "end": 0.81, "type": "word", "logprob": -0.08 }
    ]
  }
  ```
- **400** — missing/empty body, or `Content-Type` not on the allowlist.
- **413** — body exceeds `streamStt.maxBodyBytes` (when configured).
- **429** — ElevenLabs rate-limited the gateway. Back off and retry.
- **502** — network failure reaching ElevenLabs, or upstream non-2xx. The
  body includes `error.detail` with up to the first 200 characters of
  ElevenLabs's response for triage.
- **503** — plugin misconfigured (provider not ElevenLabs, API key missing,
  or `streamStt.enabled` false).
- **500** — unexpected handler error. Body has `error.type = "internal_error"`
  and `error.detail` trimmed to 200 chars. Shouldn't fire in normal operation
  — emitted by the handler's outer try/catch so bugs produce a diagnosable
  JSON envelope rather than Node's default plaintext 500.

Error bodies are JSON: `{ error: { message, type, detail? } }`.

## Config

Add a `streamStt` block to the plugin config alongside the existing
`streamTts` block:

```jsonc
"plugins": {
  "entries": {
    "sprite-core": {
      "enabled": true,
      "config": {
        "streamTts": { /* … */ },
        "streamStt": {
          "enabled": true,
          "provider": "elevenlabs",
          "apiKey": { "source": "env", "id": "ELEVENLABS_API_KEY" },
          "defaultModel": "scribe_v1",
          "maxBodyBytes": 52428800
        }
      }
    }
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `enabled` | `boolean` | Required `true` for the route to register. Flipping to `false` removes the `/stream/stt` + `/stt` routes on next gateway restart. |
| `provider` | `"elevenlabs"` | Only value supported today. |
| `apiKey` | `SecretInput` | Same shape as `streamTts.apiKey`. Reuse `ELEVENLABS_API_KEY` — one key covers both STT and TTS. |
| `defaultModel` | `string` | ElevenLabs model id. Default `scribe_v1`. Override per request via `?model=`. |
| `maxBodyBytes` | `number` | Optional. Plugin-level size cap checked against inbound `Content-Length`. No default — absent means no plugin-level cap (ElevenLabs still bounds upstream). |

## How press-and-hold maps to this

The plugin's `/stream/stt` route is generic — it doesn't know about
press-and-hold, voice tabs, or turn boundaries. The UX flow is fully
client-driven:

1. **Finger-down** — client starts recording to a temp file or in-memory
   buffer (Android `AudioRecord` at 16 kHz mono PCM, or `MediaRecorder` with
   AAC/OGG for smaller uploads).
2. **Finger-up** — client stops recording, then issues one `POST /stream/stt`
   with the audio bytes as the body.
3. Client parses the returned JSON, extracts `text`, and feeds it into the
   existing send-queue path.
4. Partial / live-transcript UI is **out of scope for the batch endpoint** —
   the user sees their utterance once ElevenLabs returns. A later
   WebSocket-based `/stream/stt/realtime` endpoint could add partials; not
   required for phase 1.

### Phone-side wiring (for the mobile dev)

`apps/android/app/src/main/java/ai/openclaw/app/voice/MicCaptureManager.kt`
gains a `uploadHeldUtterance(file): String?` helper that the hold-release
path invokes instead of the current on-device `SpeechRecognizer` round.
Feature-flag behind `streamStt.enabled` so the device can fall back to
on-device recognition when the gateway isn't configured.

The returned `String?` is the `text` field of ElevenLabs's JSON; on
network/503/502 the helper returns `null` and the caller falls back.

## Authentication

| Hop | Mechanism |
| --- | --- |
| Client → plugin | Bearer token from `openclaw pair` (stored in the phone/watch) |
| Plugin → ElevenLabs | `xi-api-key: $ELEVENLABS_API_KEY` header |

The ElevenLabs key never leaves the gateway host. Loaded from the gateway's
systemd unit env (`~/.config/systemd/user/openclaw-gateway.service`), not
from the shell env or the repo.

## Model selection

Per request: `?model=<id>` on the query string. If omitted, the plugin falls
back through: `streamStt.defaultModel` from config → hard default
`scribe_v1`.

ElevenLabs's `scribe_v1` is the current best-accuracy STT model and is
enabled by default. Use `?model=<id>` to opt in to newer / lighter models as
ElevenLabs ships them without needing a plugin restart.

## Testing a request end-to-end

Plain curl against the live gateway, using the operator token:

```bash
AUTH="Bearer $(openclaw config get gateway.operatorToken)"
curl -sSN -X POST \
  -H "Authorization: $AUTH" \
  -H "Content-Type: audio/mp4" \
  --data-binary @utterance.m4a \
  "http://localhost:18789/stream/stt?model=scribe_v1&language=en"
```

`-N` keeps curl from buffering the response. `--data-binary` avoids any form
encoding of the audio bytes.

## Concurrency

Clients can issue multiple `/stream/stt` requests in parallel — the plugin
does not serialize. ElevenLabs's rate limits apply per account (shared with
TTS), so very bursty loads can trip 429; the client should back off and
retry.

## Non-goals for phase 1

- **Partial / streaming transcripts.** Batch only; a later
  `/stream/stt/realtime` WebSocket route can add partials.
- **Audio transcoding.** The plugin doesn't convert formats. The client
  sends what ElevenLabs accepts.
- **Diarization or emotion analysis in the plugin.** Those are
  client-driven: client reads ElevenLabs's returned `words` + `language_code`
  and decides what to do.

## See also

- [`src/stt-route.ts`](../src/stt-route.ts) — route handler.
- [`src/provider-auth.ts`](../src/provider-auth.ts) — shared ElevenLabs API key resolver.
- [`src/types.ts`](../src/types.ts) — `SpriteCoreStreamSttConfig` shape.
- [`openclaw.plugin.json`](../openclaw.plugin.json) — config JSON schema.
- [`tts-integration.md`](tts-integration.md) — the sibling TTS proxy, same architecture.
- ElevenLabs docs: <https://elevenlabs.io/docs/api-reference/speech-to-text>.
