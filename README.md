# SpriteCore

Plugin + cross-language client SDKs for multi-state sprite avatars, streaming
TTS, and streaming STT on [OpenClaw](https://github.com/openclaw/openclaw).

This repo holds four publishable artifacts, sharing one version and one
wire-schema source of truth so the server plugin and every client language
stay in lockstep:

| Package | Language | Artifact | Purpose |
|---|---|---|---|
| [`packages/plugin`](./packages/plugin) | TypeScript (Node) | `@tylerwarburton/sprite-core` (npm) | OpenClaw gateway plugin — asset serving, TTS/STT proxy, prompt block, `node.getCharacterManifest` RPC |
| [`packages/client-js`](./packages/client-js) | TypeScript | `@tylerwarburton/sprite-core-client` (npm) | Browser / Node reference implementation of the render engine |
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
[`CHANGELOG.md`](./CHANGELOG.md).

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

Full config schema and the dashboard UI are documented in
[`packages/plugin/README.md`](./packages/plugin/README.md).

And the apps pull in the language-appropriate client SDK:

- Web / Electron / React Native → `@tylerwarburton/sprite-core-client` (npm)
- Android phone + Wear OS watch → `ai.openclaw.spritecore:sprite-core-client` (Maven)
- iOS / macOS → `SpriteCoreClient` (SwiftPM)

For live-development against OpenClaw without publishing, both Gradle
(`includeBuild`) and SwiftPM (`path:`) support local path links.

## Installing a dev build into your local OpenClaw

If you're testing plugin changes against a real gateway without publishing to
npm, use the helper script — it builds the UI, packs the plugin, drops it into
your OpenClaw install's `node_modules`, and restarts the daemon:

```bash
# Defaults to ~/.openclaw/app (the global `npm i -g openclaw` location)
scripts/install-into-openclaw.sh

# Or point at a different install:
scripts/install-into-openclaw.sh --install-dir /path/to/openclaw

# Faster iteration: reuse an existing ui-dist/ build
scripts/install-into-openclaw.sh --skip-build
```

The script is idempotent — every run does an atomic swap and keeps the
previous copy at `node_modules/@tylerwarburton/sprite-core.prev` for rollback.

After it finishes, enable the plugin in your `openclaw.json` (see
[packages/plugin/README.md → Enable](./packages/plugin/README.md#enable))
and browse to `http://localhost:18789/sprite-core/ui/` — the dashboard's
HTML shell is served publicly; its API calls are same-origin and ride the
session you already have for the OpenClaw Control UI.

`scripts/sync-to-openclaw.sh` is **deprecated** as of 0.5.3. It used to mirror
this repo's plugin sources into a sibling `openclaw-src/extensions/sprite-core/`
checkout (the bundled-plugin layout). With the plugin now published to npm, the
canonical install path is:

```bash
openclaw plugins install @tylerwarburton/sprite-core
openclaw plugins update  @tylerwarburton/sprite-core   # later updates
```

The script is still in the repo for emergency hotfix use against an
openclaw-src checkout that you can't restart.

## License

MIT.
