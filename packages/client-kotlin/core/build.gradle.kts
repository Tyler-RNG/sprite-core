plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    `maven-publish`
}

group = "ai.openclaw.spritecore"
version = findProperty("version")?.toString() ?: "1.0.0"

kotlin {
    jvmToolchain(17)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

tasks.test {
    useJUnitPlatform()
}

java {
    withSourcesJar()
    withJavadocJar()
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "sprite-core-client"
            pom {
                name.set("SpriteCore Client (Kotlin core)")
                description.set("Pure-JVM client kit for the SpriteCore plugin — animation graph + sprite player")
                url.set("https://github.com/Tyler-RNG/sprite-core")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
            }
        }
    }
    // Target registry is configured via -Pregistry= or env in CI; see
    // packages/client-kotlin/README.md.
}
