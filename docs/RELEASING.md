# Releasing

This repo ships four artifacts from one git tag. Everything publishes to
GitHub Packages (npm + Maven) under the `Tyler-RNG/sprite-core` repository
scope, plus SwiftPM consumes the git tag directly.

## One-time setup (done once per repo)

No additional secrets are required. GitHub Actions automatically provides a
`GITHUB_TOKEN` with `packages: write` to the release workflow — that's the
only credential needed to publish to GitHub Packages from CI.

For SwiftPM, there is nothing to configure — consumers pull by git tag.

## Cutting a release

1. Ensure `main` is green on CI.
2. Bump every `version` field to the new version (must match exactly):
   - `packages/plugin/package.json`
   - `packages/client-js/package.json`
   - `schema/package.json`
   - `packages/client-kotlin/core/build.gradle.kts` (the literal in the
     `version = findProperty("version")?.toString() ?: "X.Y.Z"` fallback)
   - `packages/client-kotlin/android/build.gradle.kts` (same)
   - Swift has no declared version — the git tag IS the Swift version.
3. Verify locally:
   ```
   node scripts/check-versions.mjs
   ```
4. Update `CHANGELOG.md`: move items from **Unreleased** into a new
   `## X.Y.Z — YYYY-MM-DD` heading.
5. Commit:
   ```
   git commit -am "Release vX.Y.Z"
   ```
6. Tag:
   ```
   git tag vX.Y.Z
   ```
7. Push both:
   ```
   git push origin main --follow-tags
   ```
8. Watch the Release workflow. The order is:
   1. `verify-versions` — fails the release if `check-versions.mjs` disagrees
      with the tag.
   2. In parallel: `publish-plugin`, `publish-client-js`,
      `publish-client-kotlin`, `validate-client-swift`.

   A single failure in any of those jobs stops that artifact from publishing
   (the others may already have shipped; this is an intentional tradeoff —
   each artifact publish is idempotent per-version, so a retry after fix is
   safe).

## Consuming the releases

### npm packages (plugin + client-js)

Both are scoped to `@tyler-rng` and live on GitHub Packages. A consumer
needs to point the scope at GitHub Packages in their `.npmrc`:

```
@tyler-rng:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_READ_PACKAGES_TOKEN}
```

The token only needs the `read:packages` scope. See
`packages/plugin/README.md` for the private-beta install recipe (this is
already documented for the plugin).

### Maven (Kotlin core + android)

From a consuming Gradle project:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
        maven {
            url = uri("https://maven.pkg.github.com/Tyler-RNG/sprite-core")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull
                    ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}

// app/build.gradle.kts
dependencies {
    implementation("ai.openclaw.spritecore:sprite-core-client:1.0.0")
    implementation("ai.openclaw.spritecore:sprite-core-client-android:1.0.0")
}
```

Put `gpr.user` + `gpr.key` in `~/.gradle/gradle.properties` (with
`gpr.key` = a PAT with `read:packages`) so local builds can resolve
without env vars.

### SwiftPM (Swift client)

```swift
.package(url: "https://github.com/Tyler-RNG/sprite-core.git", from: "1.0.0")
```

Then depend on the `"SpriteCoreClient"` product. SwiftPM resolves by git
tag, so no auth is needed beyond the repo clone — if your consuming Xcode
project is on a machine that can already git-clone the repo, it'll work.

## Publishing locally (rarely needed)

Only useful for ad-hoc testing. Don't cut real releases this way — use the
workflow so every artifact goes out at the same version.

- **npm**: `cd packages/plugin && npm publish` (requires
  `NODE_AUTH_TOKEN` in env, `write:packages` scope PAT).
- **npm (client-js)**: `cd packages/client-js && pnpm build && npm publish`.
- **Gradle**: `cd packages/client-kotlin && GITHUB_ACTOR=you GITHUB_TOKEN=... gradle :core:publish :android:publish -Pversion=X.Y.Z`.
- **SwiftPM**: no local publish — just tag + push.

## Rollback / yank

- **npm (GitHub Packages)**: `npm unpublish @tyler-rng/sprite-core@X.Y.Z` is
  allowed for 72h after publish. After that, publish a `X.Y.(Z+1)` that
  supersedes it.
- **Maven (GitHub Packages)**: versions are immutable once published. Bump
  and ship a new one.
- **SwiftPM (git tag)**: `git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`
  plus any SPM cache buster. Don't rewrite history — create a superseding
  tag instead.

## Secrets checklist

| Secret | Where | Why |
|---|---|---|
| `GITHUB_TOKEN` | auto-provided by GitHub Actions | npm + Maven publish to GitHub Packages |
| `read:packages` PAT | operator local `~/.npmrc` | pull `@tyler-rng/*` from GitHub Packages |
| `read:packages` PAT | operator local `~/.gradle/gradle.properties` | pull `ai.openclaw.spritecore:*` from Maven GitHub Packages |
| `write:packages` PAT | *only* if publishing locally | not needed for normal CI releases |

No extra org/team secrets need to be configured in the repo's Settings →
Secrets and variables.
