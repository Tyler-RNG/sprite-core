# SpriteCore

Plugin + cross-language client SDKs for multi-state sprite avatars, streaming
TTS, and streaming STT on [OpenClaw](https://github.com/openclaw/openclaw).

This repo holds four publishable artifacts, sharing one version and one
wire-schema source of truth so the server plugin and every client language
stay in lockstep:

| Package | Language | Artifact | Purpose |
|---|---|---|---|
| [`packages/plugin`](./packages/plugin) | TypeScript (Node) | `@tyler-rng/sprite-core` (npm) | OpenClaw gateway plugin — asset serving, TTS/STT proxy, prompt block, `node.getCharacterManifest` RPC |
| [`packages/client-js`](./packages/client-js) | TypeScript | `@tyler-rng/sprite-core-client` (npm) | Browser / Node reference implementation of the render engine |
| [`packages/client-kotlin`](./packages/client-kotlin) | Kotlin (JVM + Android) | `ai.openclaw.spritecore:sprite-core-client` (Maven) | Kotlin kit for wearables, phones, desktop |
| [`packages/client-swift`](./packages/client-swift) | Swift | `SpriteCoreClient` (SwiftPM) | iOS / macOS / tvOS / watchOS kit |

The canonical wire schema lives in [`schema/`](./schema) (TypeBox). Kotlin and
Swift type files are generated from it so they cannot drift. Runtime behaviour
is locked down by the shared [`fixtures/`](./fixtures) suite — every language's
test harness replays the same JSON cases and must produce byte-identical
outputs.

## Layout

```
sprite-core/
├── pnpm-workspace.yaml
├── package.json                    ← workspace root
├── schema/                         ← TypeBox wire schema (source of truth)
├── fixtures/                       ← language-agnostic conformance JSON
├── scripts/                        ← (TODO) codegen TS → Kotlin / Swift
├── docs/                           ← shared avatar/TTS/STT protocol docs
└── packages/
    ├── plugin/                     ← OpenClaw plugin (was the root of this repo)
    ├── client-js/                  ← TypeScript reference renderer
    ├── client-kotlin/              ← Kotlin kit (core + android modules)
    └── client-swift/               ← Swift kit (SwiftPM)
```

## Quickstart

```bash
pnpm install
pnpm test                     # runs schema + TS client + plugin tests
./gradlew -p packages/client-kotlin test
swift test --package-path packages/client-swift
```

Each package has its own README with language-specific install + usage. The
**`<<<state>>>` / `<<<state-N>>>` marker grammar** and the
**`CharacterManifest` wire shape** are defined once in `schema/` and mirrored
everywhere else.

## Versioning

All four packages release together at one version. A bump to `schema/`
invalidates conformance and requires a release across all four. See
[`CHANGELOG.md`](./CHANGELOG.md) *(to be added)*.

## Consuming from OpenClaw

OpenClaw installs the plugin like any other npm-served extension:

```jsonc
// openclaw.json
{
  "plugins": {
    "entries": {
      "sprite-core": { "enabled": true, "config": { /* ... */ } }
    }
  }
}
```

And the apps pull in the language-appropriate client SDK:

- Web / Electron / React Native → `@tyler-rng/sprite-core-client` (npm)
- Android phone + Wear OS watch → `ai.openclaw.spritecore:sprite-core-client` (Maven)
- iOS / macOS → `SpriteCoreClient` (SwiftPM)

For live-development against OpenClaw without publishing, both Gradle
(`includeBuild`) and SwiftPM (`path:`) support local path links.

## License

MIT.
