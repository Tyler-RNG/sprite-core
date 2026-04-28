# SpriteCore TTS Integration

How the `/stream/tts` endpoint works end-to-end, so a watch/phone dev can
integrate against it confidently without reading the plugin source.

## Architecture at a glance

SpriteCore is a **streaming proxy** between the client (phone/watch) and
ElevenLabs. The client never sees the ElevenLabs API key, never talks to
ElevenLabs directly, and doesn't have to build ElevenLabs's POST body by hand.

```
[client: phone or watch TalkSpeaker]
      │
      │  GET /stream/tts?voice=…&text=…&stability=…&style=…&speaker_boost=…&speed=…
      │  Authorization: Bearer <operator token>
      ▼
[gateway plugin: handleTtsRequest]            auth: "gateway" (enforced before handler)
      │
      │  POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream
      │  xi-api-key: $ELEVENLABS_API_KEY      (env-loaded on gateway host only)
      │  body: { text, model_id, voice_settings: { stability, similarity_boost, style?, use_speaker_boost?, speed? } }
      ▼
[ElevenLabs API]
      │
      │  200 OK, Content-Type: audio/mpeg, chunked MP3 stream
      ▼
[back through the plugin, piped to the client with chunked transfer]
```

The plugin **does not** buffer, transcode, or re-encode. It reads ElevenLabs's
streaming response and writes bytes through to the client as they arrive. Time
to first audio is dominated by ElevenLabs's latency, not the plugin.

## Endpoint

`GET /stream/tts` (also aliased as `/tts` for legacy callers).

Registered with `auth: "gateway"`, meaning the plugin HTTP dispatcher rejects
any request without a valid operator token before the handler even runs. TTS
costs real money — there is no public escape hatch.

### Query parameters

| Param | Required | Default | Maps to ElevenLabs `voice_settings` |
| --- | --- | --- | --- |
| `voice` | yes | — | URL path `/text-to-speech/{voice_id}/stream` |
| `text` | yes | — | body `text` (URL-decode before sending upstream) |
| `model` | no | plugin `streamTts.defaultModel` → `eleven_turbo_v2` | body `model_id` |
| `stability` | no | `0.5` | `stability` |
| `similarity` | no | `0.75` | `similarity_boost` |
| `style` | no | omitted | `style` (only forwarded when present) |
| `speaker_boost` | no | omitted | `use_speaker_boost` (only forwarded when present) |
| `speed` | no | omitted | `speed` (only forwarded when present) |

`style`, `speaker_boost`, and `speed` are all **opt-in**: if the client omits
them, the plugin doesn't forward them, and ElevenLabs uses its model defaults
for that voice. This keeps "plain voice" callers indistinguishable from
pre-emotion-feature behavior.

`speaker_boost` accepts `"true"` / `"false"` / `"1"` / `"0"` (case-insensitive);
anything else is silently ignored.

### Response

- **200 OK** — `Content-Type: audio/mpeg`, `Transfer-Encoding: chunked`,
  `Cache-Control: no-store`. Body is streaming MP3. Clients can start decoding
  and playing the first bytes before synthesis completes.
- **400** — missing `voice` or `text`, or undecodable `text`.
- **429** — ElevenLabs rate-limited the gateway. Back off and retry.
- **502** — network failure reaching ElevenLabs.
- **503** — plugin misconfigured (provider not ElevenLabs, API key missing,
  `streamTts.enabled` false).
- **500** — unexpected handler error. Body has `error.type = "internal_error"`
  and `error.detail` trimmed to 200 chars. Shouldn't fire in normal operation
  — emitted by the handler's outer try/catch so bugs produce a diagnosable
  JSON envelope rather than Node's default plaintext 500.
- **Other upstream status** — propagated with `error.type = "upstream_error"`
  and a truncated `error.detail` for triage.

Error bodies are JSON: `{ error: { message, type, detail? } }`.

## Emotion directives: how clients compose requests

The TTS endpoint itself is generic — it knows nothing about emotions. Emotion
awareness is fully client-driven:

1. Client fetches `/sprite-core/agents` (or reads `node.getCharacterManifest`)
   once per session and caches the per-agent `emotions.<state>.directive` map.
2. While rendering a reply, the client parses `<<<state>>>` / `<<<state-N>>>`
   markers out of the model text (see [Markers](#markers)) to split the reply
   into per-emotion audio segments.
3. For each segment, the client builds the `/stream/tts` URL by merging the
   segment's emotion directive with the agent's base voice:

   | Directive field | Goes where |
   | --- | --- |
   | `voiceId` | replaces the agent's base `voice` query param (per-emotion voice **swap**) |
   | `stability` | `?stability=…` |
   | `similarity` | `?similarity=…` |
   | `style` | `?style=…` |
   | `speakerBoost` | `?speaker_boost=true` |
   | `speed` | `?speed=…` |
   | `audioTag` | prepended to `text` before URL-encoding (e.g. `"[happy] hey there!"`) |

4. Client sends one request per segment, plays the streaming MP3, and
   dispatches the matching avatar state before the segment starts.

### `audioTag` is text-level, not header-level

`audioTag` is an ElevenLabs v3 feature: inline strings like `[happy]`,
`[whispers]`, `[laughs]` inserted into the synthesis text are interpreted as
emotion cues by the v3 model. Older models (`eleven_turbo_v2`,
`eleven_multilingual_v2`) ignore the tag as regular text. Convention is to
prepend the tag with a trailing space:

```
"great to see you"  →  "[happy] great to see you"
```

Do this **before URL-encoding** the `text` query param.

### Markers

Model replies can carry inline markers that tell the client when to switch
emotion:

| Marker | Meaning |
| --- | --- |
| `<<<happy>>>` | switch to `happy`, hold until next marker |
| `<<<happy-0>>>` | same as above, explicit |
| `<<<happy-1>>>` | play `happy` once, then return to default state |
| `<<<happy-N>>>` | play `happy` N times (interruptible by a later marker) |

Markers are stripped from the visible text by the gateway-side parser before
it reaches the client. The client's own marker-aware splitter is what builds
per-emotion segments for TTS — see `apps/android/app/src/main/java/ai/openclaw/app/avatar/`
(Kotlin reference implementation).

## Authentication

| Hop | Mechanism |
| --- | --- |
| Client → plugin | Bearer token from `openclaw pair` (stored in the phone/watch) |
| Plugin → ElevenLabs | `xi-api-key: $ELEVENLABS_API_KEY` header |

The ElevenLabs key never leaves the gateway host. It's loaded from the
gateway's systemd unit env (`~/.config/systemd/user/openclaw-gateway.service`),
not from the shell env or the repo.

## Model selection

Per request: `?model=<id>` on the query string. If omitted, the plugin falls
back through: `streamTts.defaultModel` from config → hard default
`eleven_turbo_v2`.

Model choice affects which directive fields actually do anything audibly:

| Model | `stability` / `similarity` / `style` / `speaker_boost` / `speed` | `audioTag` |
| --- | --- | --- |
| `eleven_v3` | honored | **honored** (inline cues) |
| `eleven_turbo_v2` | honored | ignored (read as literal text) |
| `eleven_multilingual_v2` | honored | ignored |

The ElevenLabs v3 model is required for audio tags to change the delivery.
For Ginger on this deployment, the plugin default is set to `eleven_v3`.

## Example: composing a request

Given a `sad` segment for Ginger with text `"i'm sorry to hear that"`, and
Ginger's cached emotion directive:

```json
{
  "stability": 0.55,
  "style": 0.2,
  "speed": 0.95,
  "audioTag": "[sad]"
}
```

The client builds:

```
GET /stream/tts
  ?voice=FGY2WhTYpPnrIDTdsKH5
  &text=%5Bsad%5D%20i%27m%20sorry%20to%20hear%20that
  &stability=0.55
  &style=0.2
  &speed=0.95
```

Base voice ID `FGY2WhTYpPnrIDTdsKH5` came from the agent's `voice.voiceId`
since the directive didn't specify a `voiceId` override. If it had, that value
would go into `voice=` instead, giving the segment a different voice entirely
(e.g. a whispered voice for `sad`).

`similarity` isn't included because Ginger's `sad` directive didn't set it —
the plugin falls back to `0.75`, ElevenLabs's sane default.
`speaker_boost` is omitted for the same reason.

## Testing a request end-to-end

Plain curl against the live gateway, using the operator token from `openclaw`:

```bash
AUTH="Bearer $(openclaw config get gateway.operatorToken)"
curl -sSN -H "Authorization: $AUTH" \
  "http://localhost:18789/stream/tts?voice=FGY2WhTYpPnrIDTdsKH5&text=hello%20world&stability=0.5&style=0.6" \
  > out.mp3
```

`-N` disables curl's output buffering so you can watch the bytes stream in.

## Concurrency

Clients can fire multiple `/stream/tts` requests in parallel for different
segments — the plugin does not serialize, and ElevenLabs supports parallel
synthesis on a single API key up to your account's concurrency limit. Running
segments in parallel reduces time-to-first-audio for multi-segment replies.

Rate limits are per ElevenLabs account, not per gateway, so be mindful if
multiple concurrent sessions synthesize at once.

## See also

- [`src/tts-route.ts`](../src/tts-route.ts) — route handler.
- [`src/types.ts`](../src/types.ts) — `SpriteCoreEmotionDirective` / `SpriteCoreEmotionEntry` shapes.
- [`src/prompting.ts`](../src/prompting.ts) — the prompt block that teaches the model the `<<<state>>>` / `<<<state-N>>>` vocabulary.
- [`openclaw.plugin.json`](../openclaw.plugin.json) — config JSON schema.
- ElevenLabs docs: <https://elevenlabs.io/docs/api-reference/text-to-speech-stream>.
