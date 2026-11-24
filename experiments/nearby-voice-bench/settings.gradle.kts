// Standalone experiment build. It is NOT part of the Rideaze mobile/ or server/ builds.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
    // Versions are declared once here. Declaring them is free: a plugin is only resolved when a module applies it,
    // so :core still builds on machines without Google Maven. (:app's plugins are UNVERIFIED without a real build.)
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.2.0"
        id("org.jetbrains.kotlin.android") version "2.2.0"
        id("com.android.application") version "8.13.0"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        mavenCentral()
        google()
    }
}

rootProject.name = "nearby-voice-bench"

// :core is pure Kotlin/JVM (protocol, clock, ledger, sessions, recorder) and builds with only a JDK.
include(":core")

// :app needs the Android SDK and Google Maven. It is included only when an SDK is present or
// -PwithApp is passed, so that `:core:test` works on machines without the Android toolchain.
val hasAndroidSdk = System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null
if (hasAndroidSdk || providers.gradleProperty("withApp").isPresent) {
    include(":app")
}
