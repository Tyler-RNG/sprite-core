# sprite-core-client (Kotlin)

Kotlin client kit for the SpriteCore plugin. Two modules:

- **`:core`** — pure JVM. `CharacterManifest` data classes, `AnimationGraph`,
  `SpriteAnimationPlayer`, `FrameSource<T>`, marker parser, `AgentAvatarSource`.
  Works on any JVM target including Android, Wear OS, desktop, or a
  JVM server.
- **`:android`** — Android library. `BitmapFrameSource` bridges the core kit
  to Android `Bitmap`, decoded via `BitmapFactory`.

Artifact coordinates (after publish):

```
ai.openclaw.spritecore:sprite-core-client:1.0.0
ai.openclaw.spritecore:sprite-core-client-android:1.0.0
```

## Consuming locally (Gradle composite build)

From a consuming Gradle project (e.g. an Android app):

```kotlin
// settings.gradle.kts
includeBuild("../sprite-core/packages/client-kotlin")

// app/build.gradle.kts
dependencies {
    implementation("ai.openclaw.spritecore:sprite-core-client")
    implementation("ai.openclaw.spritecore:sprite-core-client-android")
}
```

This avoids publishing during active development — Gradle resolves the
modules directly from the checked-out path.

## Publishing

To publish snapshots / releases to a Maven registry (GitHub Packages or
Maven Central), configure the registry URL + credentials in
`~/.gradle/gradle.properties` or via CI environment:

```
./gradlew :core:publish :android:publish
```

Registry coordinates are configurable via `-Pregistry=<url>` in the Gradle
invocation or through CI secrets. See the repo-root `README.md` for the
build/publish conversation in progress.

## Layout

```
packages/client-kotlin/
├── settings.gradle.kts
├── build.gradle.kts              ← plugin version pins
├── gradle.properties
├── core/
│   ├── build.gradle.kts
│   └── src/main/kotlin/ai/openclaw/spritecore/client/
│       ├── CharacterManifest.kt       ← wire types + JSON parser + ready check
│       ├── AnimationGraph.kt          ← projection + transition resolver
│       ├── SpriteAnimationPlayer.kt   ← coroutine-driven state machine
│       ├── FrameSource.kt             ← platform adapter interface
│       ├── Ticker.kt                  ← timing abstraction
│       ├── AvatarMarkerParser.kt      ← `<<<state>>>` / `<<<state-N>>>` parser
│       └── AgentAvatarSource.kt       ← manifest + asset cache
└── android/
    └── src/main/kotlin/ai/openclaw/spritecore/client/android/
        └── BitmapFrameSource.kt       ← `FrameSource<Bitmap>` via BitmapFactory
```

## Conformance

Both modules' logic is validated against the fixtures at `../../fixtures/`.
When the wire schema at `../../schema/` changes, regenerate + rerun:

```
./gradlew :core:test :android:test
```
