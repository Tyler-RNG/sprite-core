plugins {
    id("com.android.library")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
    `maven-publish`
}

group = "ai.openclaw.spritecore"
version = findProperty("version")?.toString() ?: "0.5.10"

android {
    namespace = "ai.openclaw.spritecore.client.compose"
    compileSdk = 36

    defaultConfig {
        // Matches :android — the wearable consumes both at minSdk 30.
        minSdk = 30
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            java.setSrcDirs(listOf("src/main/kotlin"))
        }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":core"))
    api(project(":android"))

    val composeBom = platform("androidx.compose:compose-bom:2026.04.01")
    implementation(composeBom)
    api("androidx.compose.runtime:runtime")
    api("androidx.compose.foundation:foundation")
    api("androidx.compose.ui:ui")
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                artifactId = "sprite-core-client-compose"
                pom {
                    name.set("SpriteCore Client (Compose)")
                    description.set("Compose UI wrapper for the SpriteCore client kit on Android / Wear OS")
                    url.set("https://github.com/Tyler-RNG/sprite-core")
                    licenses {
                        license {
                            name.set("MIT License")
                            url.set("https://opensource.org/licenses/MIT")
                        }
                    }
                    scm {
                        connection.set("scm:git:git://github.com/Tyler-RNG/sprite-core.git")
                        url.set("https://github.com/Tyler-RNG/sprite-core")
                    }
                }
            }
        }
        repositories {
            maven {
                name = "GitHubPackages"
                url = uri("https://maven.pkg.github.com/Tyler-RNG/sprite-core")
                credentials {
                    username = System.getenv("GITHUB_ACTOR") ?: findProperty("gpr.user")?.toString()
                    password = System.getenv("GITHUB_TOKEN") ?: findProperty("gpr.key")?.toString()
                }
            }
        }
    }
}
