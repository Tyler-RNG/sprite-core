plugins {
    kotlin("jvm") version "2.2.20" apply false
    kotlin("plugin.serialization") version "2.2.20" apply false
    id("com.android.library") version "8.7.3" apply false
}

// Gradle 8.10.2 is pinned at the workflow layer via
// gradle/actions/setup-gradle@v4's `gradle-version` input. Kotlin 2.2.20 +
// AGP 8.7.3 requires Gradle >= 8.9 and < 9.x. Kotlin 2.2.x is needed because
// kotlinx-serialization 1.10.x ships 2.3.0 metadata; compiler 2.1.x can only
// read up to 2.2.0 and crashes the K2 type-checker while reporting it.

// Per-module config lives in core/build.gradle.kts and android/build.gradle.kts.
// This root exists only to pin plugin versions.
