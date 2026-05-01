---
name: openclaw-pixellab-avatar
description: Walk an operator through generating a pixel-art avatar on pixellab.ai for the OpenClaw SpriteCore plugin and packaging it into the per-agent atlas + manifest layout. Use this when the user wants to create a new sprite avatar from scratch, add new emotion states to an existing one, or asks anything about pixellab.ai integration with OpenClaw. Pairs with `scripts/avatars/pixellab-import.mjs` for the actual asset packaging step (currently a stub).
---

# OpenClaw + pixellab.ai Avatar Skill

Use this skill when the user wants to author a SpriteCore avatar with
pixellab.ai art instead of hand-drawn frames. The skill orchestrates the
human + pixellab interaction; the packaging script does the file plumbing.

## Read first

- `README.md` — plugin config the assets must satisfy.
- `template/agent/README.md` — template layout the
  output must match.
- `docs/avatars/formats.md` — atlas spec the manifest must conform to.

## Default workflow

The pipeline has four steps. Each produces an artifact you verify before
moving on. Don't skip steps — each gate catches a different class of mistake.

### 1. Confirm the ask

Ask the user:

- **Character name** (short, e.g. `moon`, `elf`, `ginger`).
- **Character description** — a single sentence describing the look
  (e.g. `a magical elf with pointed ears`). PixelLab folds this into both
  the character's name and prompt fields (the API doesn't support them
  separately), so keep it concise + self-describing.
- **Target emotions / animations** — which states the final avatar will
  carry. Common set: `idle`, `thinking`, `happy`, `sad`, `angry`, `surprised`.
  At minimum include `idle` and `thinking` (the watch auto-plays `thinking`
  while waiting for replies).
- **Agent id** this will be wired into (default: `agent`).
- **Voice** — which ElevenLabs voice the agent should speak with. Offer
  to run `--list-voices` (see Step 5b) so the user can pick; if they have
  no preference, suggest `--voice auto` for a smoke-test voice they can
  change later. A voice id drops an `elevenlabs` voice block into the
  wired config so TTS just works the moment the gateway restarts.

### 2. Create the character (step 1 of 4)

Pixellab's create endpoint takes a description and returns a character_id +
4 directional rotations. It does **not** add animations yet.

```bash
node scripts/pixellab-create.mjs \
  --name "<short-name>" \
  --description "<one-sentence description>"
```

Options:

- `--width / --height <n>` — pixel frame size (default 96×96)
- `--api-key-command "<cmd>"` — custom secret source (falls back to
  `PIXELLAB_API_KEY` env or `pass show pixellab/api-key`)
- `--json` — emit `{ character_id, name, rotations }` for downstream chaining
- `--dry-run` — print the request payload without calling pixellab

The script waits up to 5 minutes for the background job to finish, then
prints the character id and the four rotation URLs (`south`, `west`, `east`,
`north`).

### 3. Operator approves the look

Open the four rotation URLs in a browser and eyeball them. If the character
doesn't match what the user wanted:

- Adjust the description and re-run step 2 (generates a fresh character_id).
- Or delete via `DELETE /v2/characters/{id}` and re-run.

If approved, hold the `character_id` — every downstream step needs it.

### 4. Add animations (step 3 of 4)

Run `pixellab-animate.mjs` once — it queues every emotion sequentially,
polls each per-direction background job, and reports when the character has
the full set on pixellab.

```bash
node scripts/pixellab-animate.mjs \
  --uid <character_id> \
  --emotions idle,thinking,happy,sad,angry,surprised,love,wink
```

Options:

- `--prompt-map <json>` — override per-emotion prompts when the defaults
  don't fit the character (e.g. a stoic character shouldn't "warm smile").
- `--mode template | v3 | pro` — default `v3`.
- `--frame-count <4-16>` — default `8`; `v3` only.
- `--timeout-ms <n>` — default `600000` (10 min per emotion).
- `--json` — emit the final animation list as JSON for chaining.

Expect ~5–10 min per emotion. The script prints `✓ <emotion> complete` as
each job finishes. If any emotion fails, the script exits non-zero with a
summary — rerun with just the failed emotions to fill in the gaps.

### 5a. (Optional) Discover ElevenLabs voices

Before exporting, if the user wants to pin a specific voice, list what's
in their ElevenLabs library:

```bash
node scripts/pixellab-export.mjs --list-voices
```

No `--uid` required — this is a read-only lookup. Each line prints
`<voiceId>  <name> [category]  <labels>`. Copy the voice id the user
picks and pass it to the export step via `--voice-id`.

Auth: `ELEVENLABS_API_KEY` env, `--elevenlabs-api-key-command <cmd>`,
or `pass show elevenlabs/api-key`.

### 5b. Export into SpriteCore (step 4 of 4)

Once animations exist on the character, the exporter pulls the ZIP bundle,
calls `/characters/<id>/animations` for canonical emotion names (`happy`,
`sad`, etc. — not the verbose pixellab slugs), packs frames into a WebP
atlas, writes the manifest, generates the config block (including the
voice if a voice id was supplied), and with `--apply` patches
`openclaw.json` directly.

```bash
# Normal path: write atlas + manifest AND patch openclaw.json in one shot.
# The exporter backs up the config before writing; restart the gateway
# afterward so it picks up the new agent entry.
node scripts/pixellab-export.mjs \
  --uid <character_id> \
  --agent-id <agent-id> \
  --overwrite \
  --apply

# Dry-style path: write atlas + manifest only; print the openclaw.json
# snippet for manual review/paste. Use this when you want to eyeball the
# block before wiring it in.
node scripts/pixellab-export.mjs \
  --uid <character_id> \
  --agent-id <agent-id> \
  --overwrite

# Custom output root
node scripts/pixellab-export.mjs \
  --uid <character_id> \
  --agent-id <agent-id> \
  --assets-root ~/my-custom/assets/avatars \
  --overwrite

# Pick an ElevenLabs voice for the snippet (see `--list-voices` below)
node scripts/pixellab-export.mjs \
  --uid <character_id> \
  --agent-id <agent-id> \
  --voice-id <elevenlabs-voice-id> \
  --overwrite

# Auto-pick the first voice from the operator's ElevenLabs library
node scripts/pixellab-export.mjs \
  --uid <character_id> \
  --agent-id <agent-id> \
  --voice auto \
  --overwrite
```

The exporter:

- Pairs zip-folder hashes with the API's `animation_type` field to produce
  clean SpriteCore state names, falling back to slug names when the
  animation metadata endpoint 404s.
- Derives emotion descriptions from pixellab's `display_name` (or the
  original prompt when unset).
- Deduplicates canonical names (two `idle` animations → `idle`, `idle_2`, …)
  so the manifest stays valid.
- Cleans up the per-state `frames/` working dir after packing the atlas, so
  the shipped agent directory only contains `<id>.atlas.webp` +
  `<id>.atlas.json`.
- Prints a canonical `openclaw.json` snippet using
  `emotions.<state>.description` (the current shape — the older
  `prompting.descriptions` form still works but is deprecated). Operators
  hand-add `directive` blocks when they tune per-emotion TTS.

Use `--rename` when the `animation_type` fetch 404s and you want clean
state names instead of pixellab's verbose slugs. Needle matching is
case-insensitive and normalizes `_`/`-` to spaces, so natural-language
substrings work against underscored slugs:

```bash
--rename "idle:standing still,thinking:hand on chin,happy:warm smile,sad:downturned mouth"
```

### Voice selection

The exporter can include a `voice` block in the printed snippet so the
agent is TTS-ready the moment it lands in `openclaw.json`:

- `--list-voices` — one-time read-only lookup against
  `GET /v1/voices`. Prints `<voiceId>  <name> [category]  <labels>` per
  line. No `--uid` required.
- `--voice-id <id>` — drops the voice block into the snippet with the
  explicit id.
- `--voice auto` — picks the first voice from the operator's ElevenLabs
  library. Useful for smoke-test agents; production agents should pin an
  explicit id.

Auth: `ELEVENLABS_API_KEY` env, `--elevenlabs-api-key-command <cmd>`, or
`pass show elevenlabs/api-key`. Voice lookup is silent-skip on failure so
the export still completes with a snippet sans voice block.

The compat shim `scripts/avatars/pixellab-import.mjs` forwards to the same
exporter, so any existing call site keeps working.

### 6. Wire into `openclaw.json`

If you ran the exporter with `--apply`, this step is already done — the
exporter wrote the agent block under
`plugins.entries["sprite-core"].config.agents.<agent-id>` and printed the
backup path. Skip to the restart in Step 7.

If you ran without `--apply`, copy the config snippet the exporter printed
into `openclaw.json` under
`plugins.entries["sprite-core"].config.agents.<agent-id>`. Default state
from the snippet is `idle` when present; otherwise the first animation.
Review before saving — sometimes you want a more specific default.

### 7. Verify

- `openclaw config get plugins.entries.sprite-core.config.agents.<agentId>`
  shows the block.
- `curl -H "Authorization: Bearer <gateway-token>" http://localhost:18789/sprite-core/agents`
  returns the agent's avatar + voice.
- Phone/watch refresh — the new manifest should arrive on the
  `/openclaw/avatars/<agentId>/character-manifest` DataClient path.

## Constraints

- Do not commit the pixellab API key. It belongs in the user's environment
  only.
- Do not invent pixellab.ai API endpoints. If the upstream contract isn't
  documented in this skill, ask the user to share their pixellab account
  docs before generating any code that hits the API.
- Frame dimensions must be uniform. If the user supplies mismatched sizes,
  ask which one is canonical and resize the others (sharp is in repo deps)
  before packing.

## Open TODOs

- Animate-then-tag pipeline: today the exporter's `DEFAULT_CANONICAL_RENAMES`
  map collapses pixellab's verbose slugs back to canonical emotion names
  (`idle`, `happy`, `sad`, …) when `/characters/<id>/animations` 404s.
  Better would be for `pixellab-animate.mjs` to tag each animation upstream
  with the emotion key it was invoked with (via a name field in the
  animate-character request or a follow-up PATCH), so the mapping is
  upstream and the exporter never has to guess.
- Auto-restart the gateway after `--apply`: currently the exporter prints a
  restart command but intentionally does not run it (visible side effect
  the operator should own). Add `--restart-gateway` as opt-in sugar for
  unattended runs.
- `/characters/<id>/animations` currently 404s in our environment; the
  exporter falls back to slug names plus the canonical rename map.
  Confirm the pixellab API contract (endpoint path / required auth /
  response shape) and update the exporter, or remove the fetch entirely
  if it's permanently gone.
- Pixellab 3-concurrent-job cap: account-wide limit seen during batch
  runs. Future: add a simple semaphore to the animate or batch scripts so
  parallel pipelines block-and-retry instead of 429'ing out on create.
