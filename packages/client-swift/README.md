# SpriteCoreClient (Swift)

Swift client SDK for the SpriteCore plugin. SwiftPM library, zero deps
beyond Foundation, supports iOS 15+, macOS 12+, tvOS 15+, watchOS 8+.

## Install

From a consuming Xcode project:

```swift
// In Package.swift, or via Xcode: File → Add Package Dependencies
.package(path: "../sprite-core/packages/client-swift")          // local dev
// or
.package(url: "https://github.com/Tyler-RNG/sprite-core.git", from: "1.0.0")
```

Then add `"SpriteCoreClient"` to your target dependencies.

## Minimal usage

```swift
import SpriteCoreClient
import UIKit

let envelope = CharacterManifestJson.parse(jsonData)!
let graph = try AnimationGraph.fromManifest(envelope.manifest, mode: "headshot")

let frameSource = InMemorySpriteSource<UIImage> { data in UIImage(data: data) }
for (refKey, bytes) in assetBytes { frameSource.put(refKey, bytes: bytes) }

let player = SpriteAnimationPlayer(graph: graph)

Task {
    for await ref in await player.refStream() {
        guard let ref, let img = frameSource.frame(for: ref) else { continue }
        await MainActor.run { imageView.image = img }
    }
}

// When the model emits `<<<happy>>>`:
let parser = AvatarMarkerParser()
let parsed = parser.push(streamChunk)
for m in parsed.markers {
    await player.requestState(m.state, playCount: m.count)
}
```

## Surface

- `CharacterManifest` / `CharacterManifestEnvelope` — `Codable` wire types
- `CharacterManifestJson.parse(_:)` — envelope parser
- `AnimationGraph.fromManifest(_:mode:)` — projection + wildcard resolver
- `SpriteAnimationPlayer` — `actor`-isolated state machine, async-streams refs
- `FrameSource` protocol + `InMemorySpriteSource`
- `AvatarMarkerParser` / `parseAvatarMarkers(_:)` / `splitByMarkers(_:)`

## Conformance

This Swift implementation mirrors the Kotlin and TypeScript ports in the
sibling packages. The shared fixture suite at `../../fixtures/` is the
oracle. Run:

```
swift test
```
