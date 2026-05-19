# Changelog

All four packages in this repo (`@tylerwarburton/sprite-core`,
`@tylerwarburton/sprite-core-client`, `ai.openclaw.spritecore:sprite-core-client`
and `-android`, `SpriteCoreClient`) release together at one version. Tag
format: `v<version>` (e.g. `v1.0.0`).

## [0.5.9] - 2026-05-19

### Added

- Kotlin: new `:glasses` Gradle module publishing
  `ai.openclaw.spritecore:sprite-core-client-glasses`. Brilliant Frame BLE
  transport (`GlassesBleTransport`), Lua REPL client + sub-channel framing
  (`GlassesClient`), mic + IMU sources (`GlassesMicSource`,
  `GlassesInputSource`), and a `FrameSource<Bitmap>`-driven display sink
  (`GlassesDisplaySink`) that nearest-neighbour quantizes to a 16-color
  palette and streams 4bpp BEGIN/CHUNK/COMMIT packets. Bundles an on-device
  Lua client app (`assets/glasses_app.lua`) that owns mic drain, IMU
  callbacks, and display draw decode. Lets a phone-side companion (the new
  openclaw `apps/wearable/glasses` app) treat the Frame as a thin BLE
  client the same way the wearable treats Wear OS.

## [0.5.8] - 2026-05-10

### Added

- Kotlin: new `:compose` Gradle module publishing
  `ai.openclaw.spritecore:sprite-core-client-compose`. Ships
  `ai.openclaw.spritecore.client.compose.CharacterAvatar`, a Compose
  Composable that wires `AnimationGraph` + `SpriteAnimationPlayer` +
  `BitmapFrameSource` into a drop-in widget. Takes a `bitmapTransform:
  (Bitmap) -> Bitmap` hook so platform-specific framing (e.g. a watch face
  cropping a full-body sprite to a headshot) lives at the call site rather
  than inside each consuming app.
- Swift: `CGImageFrameSource` (atlas-aware ImageIO-backed `FrameSource`
  mirroring Kotlin's `BitmapFrameSource`) and `CharacterAvatarView` (SwiftUI
  View with a `cgImageTransform` hook). Gated on `canImport(SwiftUI) &&
  canImport(ImageIO)`.
- TypeScript: `ImageBitmapFrameSource` (atlas-aware `FrameSource<AtlasFrame>`
  with async prefetch) and `mountCharacterAvatar(canvas, opts)` returning a
  `{ setState, dispose }` controller. Framework-free — drives an
  `HTMLCanvasElement` directly via 2D context.

## [0.5.7] - 2026-05-09

### Fixed

- Plugin: `node.getCharacterManifest` gateway RPC is now registered with
  `{ scope: "operator.read" }`. Without an explicit scope, upstream openclaw
  (>=2026.5.0) defaults unscoped methods to `operator.admin`, which silently
  rejected every phone/watch call with `INVALID_REQUEST: missing scope:
  operator.admin`. The kit's `fetchManifest` returned null, so sprites never
  rendered on the phone — even though the gateway connection, TTS, STT and
  the dashboard sprite UI all kept working (they ride HTTP routes, not RPC
  scope). Sibling RPC `sprite-core.agents` already opts down to
  `operator.read`; this RPC was missed during the 0.5.5 fork→upstream port
  and the regression only surfaced after the host-default-deny took effect.

## [0.5.6] - 2026-05-07

### Changed

- Plugin compat: works on upstream openclaw `>=2026.5.0`. Bumps
  `peerDependencies.openclaw` from `>=2026.4.10` to `>=2026.5.0` and updates
  the dev pin to `^2026.5.6`.

### Fixed

- Plugin now declares `activation.onStartup: true` in `openclaw.plugin.json`
  so upstream's plugin loader actually invokes `register()` at gateway boot.
  Without it, the plugin was loaded but its HTTP routes (`/sprite-core/ui`,
  `/sprite-core/agents`, `/openclaw-assets`, etc.) were never registered —
  every URL fell through to the Control SPA catch-all.
- `api.registerSystemPromptContribution(...)` is now wrapped in a
  `typeof === "function"` guard. Upstream openclaw 2026.5.x doesn't expose
  that method (fork-only API), and an unguarded call threw `TypeError` and
  aborted plugin registration. The plugin now gracefully skips the
  prompt-contribution feature on hosts that don't expose it; atlas/TTS/STT
  and UI continue to work. Driving sprite state markers from the client
  side (or via tools/RPC) remains unaffected.
- `ui-dist` resolver now also probes `<here>/../../ui-dist` and
  `<here>/../../../ui-dist`. Previous candidates only worked for the bundled
  (tsdown) layout and the source layout; the tsc-emitted `dist/src/`-nested
  layout (which is what the new `build` script produces) needed two more
  candidates. Without this, `/sprite-core/ui` returned a 503 with the
  "SpriteCore UI bundle not built" message even when `ui-dist/` was
  correctly shipped.

### Build

- Added `build` and `prepack` scripts to `packages/plugin/package.json`.
  `prepack` runs `pnpm run build:ui && tsc` so `npm pack` produces a
  self-contained tarball with both `dist/` and `ui-dist/` populated, even
  on a fresh clone where neither directory exists yet.
- Added `dist` to the plugin's `files` array so the build output ships in
  the published tarball alongside the existing `ui-dist`.

## [0.5.0] - 2026-04-27

### Added

- Workspace layout: `packages/plugin`, `packages/client-js`,
  `packages/client-kotlin`, `packages/client-swift`, plus shared `schema/`
  and `fixtures/`.
- Cross-language client SDKs (TypeScript, Kotlin, Swift) implementing the
  `CharacterManifest` wire protocol: `AnimationGraph` projection, coroutine /
  async-iterator / `actor` sprite player, `FrameSource` adapter seam,
  streaming `<<<state>>>` / `<<<state-N>>>` marker parser, asset cache.
- `schema/` package publishing TypeBox definitions as the single source of
  truth for wire types (downstream Kotlin and Swift types kept in lockstep
  via the `fixtures/` conformance suite).
- Release workflow publishing all four artifacts from a single `v*` tag:
  - `@tylerwarburton/sprite-core` → npm (GitHub Packages)
  - `@tylerwarburton/sprite-core-client` → npm (GitHub Packages)
  - `ai.openclaw.spritecore:sprite-core-client` + `-android` → Maven
    (GitHub Packages)
  - `SpriteCoreClient` — consumed via git tag by SwiftPM
- `scripts/check-versions.mjs` — pre-flight gate that fails the release if
  any package's declared version disagrees with the tag.

### Changed

- Plugin moved from repo root into `packages/plugin/`. Package name and
  `install.npmSpec` unchanged — operators continue to install
  `@tylerwarburton/sprite-core` via the existing instructions.

### Fixed

- TypeScript marker parser upgraded to match Kotlin semantics (`<<<state-N>>>`
  play-count suffix). All three language ports now produce identical parse
  results for the same inputs.
- `emotions` field added to the Kotlin `CharacterManifest` data class
  (previously drifted from the TypeScript wire schema).
- Dashboard atlas previews now render the cropped source rect via canvas
  `drawImage` instead of the entire atlas sheet — atlas-kind avatars
  actually animate when you press play.
- Dashboard tracks the OpenClaw Control UI's persisted theme (light / dark)
  by mirroring `data-theme` / `data-theme-mode` attributes onto its own
  document, with `storage` event + `prefers-color-scheme` fallback.
- `pnpm typecheck` is green at the repo root (three pre-existing errors in
  `packages/plugin` blocked the documented quickstart).
