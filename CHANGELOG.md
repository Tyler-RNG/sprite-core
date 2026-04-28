# Changelog

All four packages in this repo (`@tylerwarburton/sprite-core`,
`@tylerwarburton/sprite-core-client`, `ai.openclaw.spritecore:sprite-core-client`
and `-android`, `SpriteCoreClient`) release together at one version. Tag
format: `v<version>` (e.g. `v1.0.0`).

## Unreleased

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

## 1.0.0 — 2026-04-23

Initial release of the plugin extracted from `openclaw-src/extensions/sprite-core/`.
See `packages/plugin/README.md` for plugin-specific documentation.
