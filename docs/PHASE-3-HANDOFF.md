# SpriteCore — Phase 3 Completion Handoff

> **Status update — 2026-05-01.** Item 7 ("Plugin repo extraction") below is
> now done: this is that repo, published as `@tylerwarburton/sprite-core` on
> npm. The bundled copy that used to live at
> `openclaw-src/extensions/sprite-core/` is being retired in favor of npm
> install. The handoff text below was written against the bundled layout; when
> reading it:
>
> - **Source paths** like `extensions/sprite-core/index.ts`,
>   `extensions/sprite-core/src/...`, `extensions/sprite-core/scripts/...`
>   now live at `packages/plugin/index.ts`, `packages/plugin/src/...`,
>   `packages/plugin/scripts/...` in this repo.
> - **Install paths** for an end-user with the npm package installed are
>   `~/.openclaw/extensions/sprite-core/...` (per
>   `src/plugins/install.ts:resolveSafeInstallDir`).
> - **Skill files** moved from monorepo-root `.agents/skills/` to
>   `packages/plugin/.agents/skills/` in 0.5.2 so they ship in the npm tarball.
>
> Items 1–6 below are still open. Item 7's last unchecked sub-item — keeping
> a stub vs. deleting the bundled directory in `openclaw-src` — is being
> resolved in this migration (deleted; openclaw discovery picks the plugin
> up from `~/.openclaw/extensions/sprite-core/` instead).

This is a handoff doc for the next dev picking up SpriteCore. Earlier phases
(plugin self-containment, character-manifest RPC, voice end-to-end plumbing,
pixellab create/animate/export pipeline) landed on the branch
`feat/android-wear-avatar-states-native` and are live on the user's gateway
(commit tip `25835b9` at handoff time).

Read this file top-to-bottom before touching anything — the order matters.

## Where we are

### Gateway (✅ done)

- Plugin is fully self-contained. `extensions/sprite-core/` owns avatar
  config, voice config, prompting vocabulary, and character-manifest synthesis.
- Two gateway RPCs registered from the plugin:
  - `node.getCharacterManifest` — returns the watch-ready manifest
  - `sprite-core.agents` — returns `{ agents: { <id>: { avatar, voice, prompting, emotions } }, publicBaseUrl }` — **scoped `operator.read`** so the phone can call it. Unclassified RPCs default to `operator.admin` which silently blocks the phone; don't add new plugin RPCs without an explicit scope.
- `/openclaw-assets/*`, `/stream/tts`, `/sprite-core/agents` HTTP routes all live
  and serving.
- System-prompt contribution (`api.registerSystemPromptContribution`)
  teaches the model the `[avatar:<state>]` marker vocabulary **only for
  clients with sprite display capability** — dashboard / headless / Telegram
  never see the block.
- Core contract is narrow:
  - `IdentityConfig.avatar` narrowed back to `string` in
    `src/config/types.base.ts`. Atlas types deleted.
  - `AgentConfig.voice` dropped from `src/config/types.agents.ts`.
  - `GatewayAgentRow` has no `avatarAtlas` or `voice` fields.

### Phone (✅ landed but watch-side TTS not wired)

- `NodeRuntime.refreshAgentsFromGateway` no longer reads voice from the core
  agent row.
- `TalkSpeaker` + `TalkSpeakRpcClient` + `TalkDataPlaneTtsFetcher` are the
  owners of voice fetching and TTS delivery on the phone.
- Press-and-hold voice on the dial works against `/stream/tts` through the
  plugin's data plane.

### Ginger (✅ rigged)

- Character UUID `518db3d2-7978-42db-bdf3-a99e856e2328` has 10 animations
  on pixellab (8 generated this session + 2 pre-existing).
- Atlas at `~/.openclaw/assets/avatars/ginger/ginger.atlas.{webp,json}`.
- 8 clean state names via the exporter's `--rename` flag: `idle, thinking,
happy, sad, angry, surprised, love, wink`.
- Config lives at `plugins.entries["sprite-core"].config.agents.ginger` with
  `avatar + voice + prompting.descriptions` — verified live on the gateway.

---

## What's still open

Roughly ordered by importance + sequencing. Each item has a concrete file
pointer and a verify gate so the next dev doesn't have to rediscover context.

### 1. Watch-side emotion-aware playback (hottest follow-up)

**Goal.** When the model emits `[avatar:happy] text segment [avatar:sad]
another segment`, the watch should:

- render the matching animation transition
- route each segment's TTS through an emotion-specific voice directive (when
  configured) so the audio tone matches the sprite

**Today.**

- Core's `src/gateway/avatar-marker-parser.ts` already strips markers +
  surfaces state changes.
- Plugin's `types.ts` has `SpriteCoreEmotionEntry = { description, directive?: SpriteCoreEmotionDirective }`
  and `SpriteCoreAgentEntry.emotions: Record<state, SpriteCoreEmotionEntry>`.
  The runtime surfaces this via `/sprite-core/agents` + `sprite-core.agents`
  RPC already.
- Phase 3 landed `audioSegments: WearChatAudioSegment[]?` on the reply
  envelope in the phone's `NodeRuntime`. Comment in that file says the watch
  "should play each segment's audio in order, dispatching the matching
  avatar state change ahead of each segment for lip-sync."
- The segment/state dispatch on the **watch** side is what's missing.

**Do.**

- In `apps/wearable/app/src/main/java/ai/openclaw/wear/WearViewModel.kt`
  (or wherever the chat reply envelope is consumed), honor `audioSegments`
  when present:
  - For each segment: `AvatarRuntime.requestState(segment.emotion)` → wait
    for state swap → play `segment.audio` → advance.
  - Fall back to single-blob audio + single state when `audioSegments` is
    unset (backwards compat for clients that don't know about it yet).
- On the phone's TalkSpeaker, consume each agent's `emotions.<state>.directive`
  from the `sprite-core.agents` response and fold it into the
  `/stream/tts` call (voice_settings, style, or whichever ElevenLabs knob
  corresponds).
- Add `emotions` block to ginger's config once the directive shape is
  finalized. Start with:
  ```jsonc
  "emotions": {
    "happy":    { "description": "warm / pleased", "directive": { "style": 0.6, "stability": 0.35 } },
    "thinking": { "description": "processing", "directive": { "stability": 0.6 } },
    "sad":      { "description": "sympathy", "directive": { "style": 0.2, "stability": 0.55 } },
    "angry":    { "description": "frustration", "directive": { "style": 0.9, "stability": 0.25 } }
  }
  ```
  (tune per what ElevenLabs v3 exposes).

**Verify.**

- Send a multi-emotion reply through ginger (`[avatar:happy] Hi! [avatar:sad] ...`).
- Watch renders the state swap at segment boundaries.
- TTS tone clearly differs between segments.
- Disable the plugin — everything falls back silently, no crashes.

---

### 2. Clean up leftover legacy-format cruft

**Today.**

- `~/.openclaw/sprite-core-pending-prompting.json` — stash file I wrote
  during the initial migration (before the gateway could accept the
  `prompting` key). No longer needed; ginger's live prompting is already in
  `openclaw.json`. Safe to delete.
- `~/.openclaw/openclaw.json.pre-sprite-core-migration-20260422-122730` —
  pre-migration config backup. Keep for now as rollback, delete once the
  operator is happy.
- `~/.openclaw/app/dist.pre-25835b-20260422-152058` — pre-deploy dist
  backup. Same deal.
- `~/.openclaw/assets/avatars/redsuccubus-1937/` — ginger's old atlas
  (before the new pixellab export). No longer referenced. Safe to delete.
- `~/.openclaw/assets/avatars/ginger/angry.gif`, `happy.gif`, `sad.gif`,
  `thinking.gif`, `neutral.gif`, `curious.gif`, `ginger.sprites-config.jsonc`,
  `frames/` — legacy pre-atlas source GIFs. Safe to delete but not blocking.

**Do.** Ask the operator before deleting anything under `~/.openclaw`. Not a
code change.

---

### 3. Exporter cosmetic: don't emit `thinking.intro` / `thinking.outro`

transitions when the phases don't exist

**Today.** `pixellab-export.mjs` unconditionally writes:

```jsonc
"transitions": {
  "*->thinking": "thinking.intro",
  "thinking->*": "thinking.outro"
}
```

into every atlas manifest. If the atlas's `thinking` animation is a flat
single-sequence (no phased `.intro`/`.loop`/`.outro`), those transitions
point at phases that don't exist. The runtime no-ops silently so nothing
breaks, but it's lint-noise in the manifest and confusing when reading.

**Do.**

- `extensions/sprite-core/scripts/pixellab-export.mjs`: only emit those
  transitions when the `thinking` animation has `.intro` / `.outro` phases.
- Since v3-mode generations are always flat, this will stop emitting them
  for pixellab-sourced characters. Future phased hand-authored characters
  still get the transitions.

**Verify.** Re-run the exporter against ginger; check the manifest no
longer has `*->thinking` etc.

---

### 4. Migrate the other 11 agents (operator-driven)

Currently stripped of legacy format but have no avatar/voice. Operator
chooses which to migrate next. The `openclaw-install-sprite-core` skill
covers the flow. No dev work — just run the skill per agent.

---

### 5. `pixellab-animate.mjs`: clean animation_type classification

**Today.** The script uses `mode: "v3"` which causes pixellab to store
generated animations as `animation_type: "custom-<truncated-prompt>"`
instead of clean canonical names (`happy`, `sad`, `thinking`…). The
exporter's `--rename` flag is the workaround — the operator maps verbose
slugs back to clean names at export time.

**Do (optional).**

- Investigate `mode: "template"` — the API docs mention
  `template_animation_id`. Figure out the template ids for the canonical
  emotions and use them when available. Would remove the need for
  `--rename`.
- OR: after queueing, PATCH the animation's `display_name` to the intended
  clean name so the exporter picks it up automatically (the exporter
  already prefers `display_name` over slug-derived descriptions). Requires
  a PATCH endpoint that may or may not exist — confirm first against
  `https://api.pixellab.ai/v2/openapi.json`.

**Verify.** Run `pixellab-animate.mjs` against a fresh character; run
`pixellab-export.mjs` without `--rename`; confirm state names are clean.

---

### 6. Docs cleanup

**Today.**

- `docs/gateway/data-plane.md` — still references the legacy core-owned
  data plane. Update to point at the plugin config (`plugins.entries["sprite-core"].config.assets.publicBaseUrl`).
- `docs/avatars/formats.md` — correct as of this branch; no action.
- `docs/tts/streaming.md` — describes the TTS streaming design. Phase 3
  may have implemented parts of this; update "Status" block if so.

**Do.** Walk each of those three files; update any sentence referring to
the old data plane / old voice location / phase 0 streaming status.

---

### 7. Plugin repo extraction (separate effort, not blocking)

**Status as of 2026-05-01: in progress.** `Tyler-RNG/sprite-core` is the
extracted repo; `@tylerwarburton/sprite-core@0.5.2` is the published artifact;
the bundled `openclaw-src/extensions/sprite-core/` directory is being deleted
in favor of `openclaw plugin install @tylerwarburton/sprite-core`. The skills
have moved to `packages/plugin/.agents/skills/` (so they ship in the tarball).

Original notes from the planning discussion, kept for reference:

- `git subtree split --prefix=extensions/sprite-core --branch sprite-core-split`
  then push to the new repo's `main`.
- Move both skills from `.agents/skills/openclaw-{install-sprite-core,pixellab-avatar}/`
  into the plugin repo's `.agents/skills/`.
- Change `package.json`: drop `"private": true`, move `@openclaw/plugin-sdk`
  to `peerDependencies` with a real version.
- Keep `extensions/sprite-core/` in the main repo as a bundled copy (easier)
  OR replace with a stub that auto-resolves to npm.
- Core files that stay (plugin depends on these):
  - `src/protocol/wear-asset.ts`
  - `src/gateway/avatar-marker-parser.ts`
  - `src/gateway/protocol/schema/display.ts`
  - `src/plugin-sdk/*`
  - `docs/avatars/formats.md`

Do this once the API is stable — probably after item 1 lands and has shipped
to real users for a week or two.

---

## Hot file pointers

| Concern                                | File                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Plugin entry / RPC registration        | `extensions/sprite-core/index.ts`                                      |
| Character-manifest synthesis           | `extensions/sprite-core/src/character-manifest.ts`                     |
| Prompting builder + system-prompt hook | `extensions/sprite-core/src/prompting.ts`                              |
| Types (incl. `SpriteCoreEmotionEntry`) | `extensions/sprite-core/src/types.ts`                                  |
| HTTP routes                            | `extensions/sprite-core/src/{agents,assets,tts}-route.ts`              |
| Pixellab pipeline                      | `extensions/sprite-core/scripts/pixellab-{create,animate,export}.mjs`  |
| Marker parser (core)                   | `src/gateway/avatar-marker-parser.ts`                                  |
| CharacterManifest wire schema (core)   | `src/gateway/protocol/schema/display.ts`                               |
| Android voice consumer                 | `apps/android/app/src/main/java/ai/openclaw/app/voice/TalkSpeaker*.kt` |
| Android agent summary                  | `apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt`        |
| Watch chat reply consumer              | `apps/wearable/app/src/main/java/ai/openclaw/wear/WearViewModel.kt`    |
| Watch avatar runtime                   | `apps/wearable/app/src/main/java/ai/openclaw/wear/` (DisplayKit)       |

## Verify-every-change contract

Every item above must land with:

1. **Gateway-side**: `pnpm tsgo` clean, plugin tests pass
   (`pnpm test extensions/sprite-core`), `pnpm build` clean, then rebuild +
   redeploy via `cp -r dist ~/.openclaw/app/dist && systemctl --user restart openclaw-gateway`.
2. **Live smoke**:
   - `openclaw gateway call sprite-core.agents --json --timeout 20000` returns
     expected shape.
   - `openclaw gateway call node.getCharacterManifest --params '{"agentId":"ginger"}' --json`
     returns a manifest with revision.
   - `curl -H "Authorization: Bearer $(…)" http://localhost:18789/sprite-core/agents`
     matches the RPC.
3. **Phone/watch**: reconnect, verify ginger renders new animations and TTS
   plays with emotion-appropriate voices (once item 1 lands).

## Known flake

`src/gateway/server.plugin-http-auth.test.ts > allows unauthenticated
Mattermost slash callback routes` times out at 120 s on heavy integration
load. Reproduces on clean main. Not caused by any of the above; flag for
whoever fixes the test.

## Environment-specific notes

- `ELEVENLABS_API_KEY` is in the gateway's systemd unit at
  `~/.config/systemd/user/openclaw-gateway.service` (not in the shell env).
  If you move the gateway to another host, port the env var across.
- Pixellab API key is in `pass show pixellab/api-key`. The three pixellab
  scripts fall back to `pass` when `PIXELLAB_API_KEY` env is unset.
- Gateway runs as user systemd service on this host. Restart via
  `systemctl --user restart openclaw-gateway`. Do not `pkill` — systemd
  will just respawn.

---

When this doc goes stale, replace it. The code is the truth; this is the
breadcrumb.
