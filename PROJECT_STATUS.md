# Ridezz — Project Status

Last updated: 2026-08-21

## Done

- Git repository initialized locally at project root, connected to GitHub
  remote `origin` (`vitheshakula/Ridezz`, private).
- `mobile/` scaffolded: bare React Native 0.87.0 + TypeScript app
  (`react-native init`, package `com.ridezz.mobile`). Android-first; iOS
  project exists from the template but is untested.
- Fixed a CLI scaffolding bug: Android Kotlin sources were generated under
  `android/app/src/main/java/com/com.ridezz.mobile/` instead of
  `android/app/src/main/java/com/ridezz/mobile/`; moved to the correct path.
- Minimal join screen built in `mobile/App.tsx`: title, rider name field,
  room code field, Join Ride button (disabled until both fields are filled).
  No room-join logic wired yet.
- LiveKit React Native SDK installed in `mobile/`:
  `@livekit/react-native@2.12.0`, `@livekit/react-native-webrtc@144.1.2`,
  `livekit-client@2.22.0`. Native autolinking confirmed for Android.
- Android native setup for LiveKit applied and verified:
  - `LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())`
    in `MainApplication.kt` (runs before other RN init; `Communication`
    mode is correct for full-duplex two-way audio, not just playback).
  - Permissions in `AndroidManifest.xml`: `RECORD_AUDIO`,
    `MODIFY_AUDIO_SETTINGS`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`,
    `BLUETOOTH_CONNECT` (in addition to the default `INTERNET`).
- `server/` directory created, intentionally empty — token service not built
  yet.
- Root `.gitignore`, `README.md` created. `debug.keystore` is intentionally
  tracked (RN's own generated `.gitignore` un-ignores it and
  `android/app/build.gradle` references it by a hardcoded path with no
  fallback generation) — it's the standard public debug-only signing key
  (fixed alias/password), not a real secret.
- Verified: `tsc --noEmit`, `eslint .`, `jest` all pass; `./gradlew
  assembleDebug` builds successfully end-to-end (confirmed with both a full
  cold build and a fresh incremental rebuild).

## Not done yet (known gaps)

- **No LiveKit Cloud project connected.** No token generation, so
  `Join Ride` does not actually connect to a room yet.
- **No `server/` implementation.** Token issuance backend is not built.
- **No Android foreground service for background audio.** LiveKit's Android
  setup call is in place, but continuous mic/audio while the app is
  backgrounded/screen-locked on Android typically requires a foreground
  service (with `microphone` service type on Android 14+). This is required
  before the "screen locked in pocket" milestone will actually work and is
  not yet implemented.
- No mute/unmute UI, no connected rider list, no connection-state UI
  (Connected/Reconnecting/Disconnected) — these come after room-join wiring.
- No reconnection logic.
- iOS not set up/tested (Android-first per product direction).
- JDK note: system default `java` resolves to JDK 23
  (`C:\Program Files\Java\jdk-23`), no JDK 17/21 present. This is not the
  traditionally-recommended JDK for React Native/Gradle, but has now been
  build-verified to work with this project's Gradle 9.4.1 / AGP setup
  (`assembleDebug` succeeds), so it's a known-working combination, not a
  blocker.

## Next milestone

Two Android phones, on separate mobile-data connections, join the same
Ridezz room, talk simultaneously over earbuds/headsets, mute/unmute, then
lock both screens while audio keeps working.
