# @tylerwarburton/sprite-core-client

TypeScript client SDK for the SpriteCore plugin. Consumes the `CharacterManifest`
wire shape emitted by `node.getCharacterManifest` and drives a portable
animation graph + sprite player that any JS runtime (browser, Node, Electron,
React Native) can render.

This is the reference implementation — the Kotlin and Swift kits in sibling
packages are functional mirrors of this code, validated against the shared
`fixtures/` suite at the repo root.

## Install

```
npm install @tylerwarburton/sprite-core-client
```

Published to the public npm registry under the `@tylerwarburton` scope.

## Minimal usage

```ts
import {
  AnimationGraph,
  SpriteAnimationPlayer,
  InMemorySpriteSource,
  createAvatarMarkerParser,
} from "@tylerwarburton/sprite-core-client";

const envelope = await fetchCharacterManifest("my-agent");
const graph = AnimationGraph.fromManifest(envelope.manifest, "headshot");

const frameSource = new InMemorySpriteSource<ImageBitmap>((bytes) =>
  createImageBitmap(new Blob([bytes])),
);
for (const [refKey, bytes] of Object.entries(assetBytes)) {
  frameSource.put(refKey, bytes);
}

const player = new SpriteAnimationPlayer(graph);
player.currentRef.subscribe((ref) => {
  if (!ref) return;
  const bitmap = frameSource.frame(ref);
  drawToCanvas(bitmap);
});

// When the model emits `<<<happy>>>`:
const parser = createAvatarMarkerParser();
const { markers, cleanedText } = parser.push(streamedChunk);
for (const m of markers) {
  player.requestState(m.state, m.count);
}
```

## Surface

- `CharacterManifest` types and TypeBox schemas (re-exported from
  `@tylerwarburton/sprite-core-schema`)
- `AnimationGraph.fromManifest(manifest, mode)` — projection + wildcard
  transition resolver
- `SpriteAnimationPlayer` — state machine, phases, play-count, ping-pong
- `FrameSource<F>` interface + `InMemorySpriteSource`
- `AssetSource` — manifest + asset cache with revision checks
- `createAvatarMarkerParser()` / `splitByMarkers()` — streaming marker parser
- `MutableObservable` — minimal StateFlow equivalent for `currentRef` /
  `currentState`
