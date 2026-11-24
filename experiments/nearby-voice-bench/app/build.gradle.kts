// NOT BUILT OR VERIFIED in the authoring environment (no Android SDK, Google Maven unreachable).
// Versions mirror the Rideaze repo where it matters: play-services-nearby 19.3.0, compile 37 -> see note below.
plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "com.rideaze.bench"
    // Rideaze uses compileSdk 37 / targetSdk 36 with AGP 9. This standalone project pins AGP 8.13 (supported on the
    // Gradle 8.14 used for :core), whose highest verified compileSdk is 36. Raise together with AGP if desired.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.rideaze.bench" // distinct from com.ridezz.mobile
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "m1-0.1"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    implementation("com.google.android.gms:play-services-nearby:19.3.0")
}
