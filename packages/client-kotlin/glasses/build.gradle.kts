plugins {
    id("com.android.library")
    kotlin("android")
    kotlin("plugin.serialization")
    `maven-publish`
}

group = "ai.openclaw.spritecore"
version = findProperty("version")?.toString() ?: "0.5.10"

android {
    namespace = "ai.openclaw.spritecore.client.glasses"
    compileSdk = 36

    defaultConfig {
        minSdk = 30
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            java.setSrcDirs(listOf("src/main/kotlin"))
            assets.setSrcDirs(listOf("src/main/assets"))
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
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                artifactId = "sprite-core-client-glasses"
                pom {
                    name.set("SpriteCore Client (Brilliant Frame glasses)")
                    description.set("Brilliant Frame BLE transport + Lua client + display sink for the SpriteCore client kit")
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
