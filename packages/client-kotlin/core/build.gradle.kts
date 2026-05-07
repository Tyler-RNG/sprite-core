plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    `maven-publish`
}

group = "ai.openclaw.spritecore"
version = findProperty("version")?.toString() ?: "0.5.5"

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
