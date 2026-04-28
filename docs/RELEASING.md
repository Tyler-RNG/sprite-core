# Releasing

This repo ships five artifacts from one release:

- `@tylerwarburton/sprite-core-schema` — npm (public registry)
- `@tylerwarburton/sprite-core-client` — npm (public registry)
- `@tylerwarburton/sprite-core` — npm (public registry)
- `ai.openclaw.spritecore:sprite-core-client(-android)` — Maven (GitHub Packages)
- `SpriteCoreClient` — SwiftPM (consumed by git tag)

## One-time setup

| Secret | Where | Why |
|---|---|---|
| `NPM_TOKEN` | repo Settings → Secrets and variables → Actions | Publish the three npm packages to the public registry under the `@tylerwarburton` scope. Use an *Automation* token from <https://www.npmjs.com/settings/~/tokens>. |
| `GITHUB_TOKEN` | auto-provided by GitHub Actions | Publish Kotlin Maven artifacts to GitHub Packages. No manual setup. |

For SwiftPM there is nothing to configure — consumers pull by git tag.

## Cutting a release

1. Ensure `main` is green on CI.
2. Bump every `version` field to the new version (must match exactly):
   - `packages/plugin/package.json`
   - `packages/plugin/ui/package.json`
   - `packages/client-js/package.json`
   - `schema/package.json`
   - `package.json` (root)
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
5. Commit and push to `main`.
6. Trigger the release: GitHub repo → **Actions** → **Release** workflow →
   **Run workflow** → enter `X.Y.Z`. Leave **tag** checked.

The workflow runs:

1. `resolve-version` — fails the release if `check-versions.mjs` disagrees
   with the input.
2. `publish-schema` (must succeed before client-js / plugin run, since they
   pull schema from npm).
3. In parallel: `publish-client-js`, `publish-plugin`,
   `publish-client-kotlin`, `validate-client-swift`.
4. `tag-release` — creates and pushes `vX.Y.Z` after every publish job
   succeeds.

A single failure in any publish job stops that artifact from going out (and
also stops the git tag from being created). Each artifact publish is
idempotent per-version, so a retry after fix is safe.

## Consuming the releases

### npm packages

```bash
npm install @tylerwarburton/sprite-core
npm install @tylerwarburton/sprite-core-client
npm install @tylerwarburton/sprite-core-schema
```

No special `.npmrc` needed — these live on the public npm registry.

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
    implementation("ai.openclaw.spritecore:sprite-core-client:0.5.0")
    implementation("ai.openclaw.spritecore:sprite-core-client-android:0.5.0")
}
```

Put `gpr.user` + `gpr.key` in `~/.gradle/gradle.properties` (with
`gpr.key` = a PAT with `read:packages`) so local builds can resolve
without env vars.

### SwiftPM (Swift client)

```swift
.package(url: "https://github.com/Tyler-RNG/sprite-core.git", from: "0.5.0")
```

Then depend on the `"SpriteCoreClient"` product. SwiftPM resolves by git
tag, so no auth is needed beyond the repo clone.

## Publishing locally (rarely needed)

Only useful for ad-hoc testing. Don't cut real releases this way — use the
workflow so every artifact goes out at the same version.

- **npm**: `cd schema && pnpm build && pnpm publish --access public`
  (requires `NODE_AUTH_TOKEN` env or `npm login`).
- **Gradle**: `cd packages/client-kotlin && GITHUB_ACTOR=you GITHUB_TOKEN=... gradle :core:publish :android:publish -Pversion=X.Y.Z`.
- **SwiftPM**: no local publish — just tag + push.

## Rollback / yank

- **npm**: `npm unpublish @tylerwarburton/sprite-core@X.Y.Z` is allowed for
  72h after publish. After that, publish `X.Y.(Z+1)`.
- **Maven (GitHub Packages)**: versions are immutable once published. Bump
  and ship a new one.
- **SwiftPM (git tag)**: `git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`
  plus any SPM cache buster. Don't rewrite history — create a superseding
  tag instead.
