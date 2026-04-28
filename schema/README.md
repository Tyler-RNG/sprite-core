# @tylerwarburton/sprite-core-schema

Wire-protocol source of truth for the SpriteCore plugin and all client SDKs.

This package is the single TypeBox definition of:

- `CharacterManifest` — the shape of `node.getCharacterManifest` responses
- `NodeGetCharacterManifestParams` / `Result` — RPC envelopes
- `DISPLAY_CAP_*` / `DISPLAY_MODE_*` — capability + mode string constants
- The `<<<state>>>` / `<<<state-N>>>` marker grammar

All four downstream packages — `plugin`, `client-js`, `client-kotlin`,
`client-swift` — derive their types from this file. Kotlin and Swift types
are code-generated from the TypeBox schemas (see `../scripts/`); TS packages
import directly.

**Never hand-edit Kotlin or Swift wire-type files to add a field.** Edit
`src/display.ts` here, regenerate, and commit all the language outputs
together as one atomic change.

## Exports

```ts
import {
  CharacterManifestSchema,
  CharacterManifest,
  NodeGetCharacterManifestResult,
  DISPLAY_CAP_SPRITE_HEADSHOT,
} from "@tylerwarburton/sprite-core-schema";

import { createAvatarMarkerParser, splitByMarkers } from "@tylerwarburton/sprite-core-schema/marker";
```
