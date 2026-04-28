# Conformance Fixtures

Language-agnostic test oracles. All three client SDKs (`client-js`,
`client-kotlin`, `client-swift`) load fixtures from this directory and
replay the declared inputs; byte-identical behaviour is the contract.

When a fixture passes on all three, the runtimes are conforming.

## Directory layout

```
fixtures/
├── README.md                        ← this file
├── animation-graph/                 ← `AnimationGraph` behaviour
│   └── wildcard-transitions.json
├── sprite-player/                   ← `SpriteAnimationPlayer` behaviour
│   ├── phased-intro.json
│   ├── play-count.json
│   └── ping-pong.json
├── marker/                          ← `AvatarMarkerParser` behaviour
│   ├── bare-markers.json
│   ├── play-count-markers.json
│   ├── split-across-chunks.json
│   └── invalid-shapes.json
└── manifest/                        ← decoder shape checks
    └── minimal-headshot.json
```

## Fixture kinds

### `animation-graph/*.json`

```jsonc
{
  "kind": "animation-graph",
  "description": "wildcard precedence resolves most-specific → least-specific",
  "manifest": { /* CharacterManifest */ },
  "mode": "headshot",
  "cases": [
    {
      "name": "exact match beats wildcard",
      "resolveTransition": { "from": "idle", "to": "thinking" },
      "expected": "thinking.intro"
    }
  ]
}
```

Runners:
1. Deserialize `manifest`.
2. Build the graph via `AnimationGraph.fromManifest(manifest, mode)`.
3. For each case, run `resolveTransition(from, to)` and compare.
   - Expected string → phase reference (TransitionRef.Phase)
   - Expected object `{ blend, ms }` → crossfade

### `sprite-player/*.json`

```jsonc
{
  "kind": "sprite-player",
  "description": "playing a phased state once runs intro then loop",
  "manifest": { /* CharacterManifest */ },
  "mode": "headshot",
  "requests": [
    { "target": "thinking", "playCount": null, "advanceMs": 500 }
  ],
  "expectedRefSequence": [
    "thinking.intro.00", "thinking.intro.01", "thinking.loop.00"
  ]
}
```

Runners use a fake `Ticker` that advances virtual time and record every
`currentRef` emission. Expected sequence is compared after all requests
and their `advanceMs` intervals have been processed.

### `marker/*.json`

```jsonc
{
  "kind": "marker",
  "description": "bare <<<happy>>> stripped and surfaced",
  "cases": [
    {
      "name": "single marker",
      "chunks": ["hello <<<happy>>> world"],
      "expectedCleanedText": "hello  world",
      "expectedMarkers": [{ "state": "happy", "count": null }]
    },
    {
      "name": "split across chunks",
      "chunks": ["start <<<hap", "py>>> end"],
      "expectedCleanedText": "start  end",
      "expectedMarkers": [{ "state": "happy", "count": null }]
    }
  ]
}
```

Runners create a fresh parser per case, push chunks in order, call flush,
and compare concatenated cleaned text + total markers list.

### `manifest/*.json`

Simplest form — just a JSON object to decode + assertions about the result.
Used to pin decoder behaviour (required fields, optional defaults, union
handling for `TransitionRef`). Expected output is implementation-defined
per runner — usually "it decodes without error and fields match."

## Adding a new fixture

1. Drop the JSON file in the right sub-directory.
2. Add a runner assertion in each language's test suite (or, for pure
   marker/manifest fixtures, rely on the shared loader).
3. `pnpm test` / `./gradlew test` / `swift test` should all pass.

If a fixture is meant to exercise a **future** feature, mark it with
`"skip": true` at the top and a note in `description` saying why.
