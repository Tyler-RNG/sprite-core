plugins {
    kotlin("jvm") version "2.0.20" apply false
    kotlin("plugin.serialization") version "2.0.20" apply false
    id("com.android.library") version "8.6.0" apply false
}

// Per-module config lives in core/build.gradle.kts and android/build.gradle.kts.
// This root exists only to pin plugin versions.
