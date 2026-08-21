# Ridezz — Project Status

Last updated: 2026-08-21

## Done

- Git repository initialized locally at project root.
- `mobile/` scaffolded: bare React Native 0.87.0 + TypeScript app
  (`react-native init`, package `com.ridezz.mobile`).
- Fixed a CLI scaffolding bug: Android Kotlin sources were generated under
  `android/app/src/main/java/com/com.ridezz.mobile/` instead of
  `android/app/src/main/java/com/ridezz/mobile/`; moved to the correct path.
- Minimal join screen built in `mobile/App.tsx`: title, rider name field,
  room code field, Join Ride button (disabled until both fields are filled).
  No room-join logic wired yet.
- LiveKit React Native SDK installed in `mobile/`:
  `@livekit/react-native@2.12.0`, `@livekit/react-native-webrtc@144.1.2`,
  `livekit-client@2.22.0`.
- Android native setup for LiveKit applied:
  - `LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())`
    added to `MainApplication.kt` (must run before other RN init).
  - Permissions added to `AndroidManifest.xml`: `RECORD_AUDIO`,
    `MODIFY_AUDIO_SETTINGS`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`,
    `BLUETOOTH_CONNECT` (in addition to the default `INTERNET`).
- `server/` directory created, intentionally empty — token service not built
  yet.
- Root `.gitignore`, `README.md` created.

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
- GitHub remote not connected — GitHub CLI (`gh`) is not installed locally,
  so the repository has not been pushed anywhere yet.
- JDK note: system default `java` resolves to JDK 23
  (`C:\Program Files\Java\jdk-23`). This has not yet been build-verified
  against the Android Gradle Plugin version in `mobile/android`; a JDK
  mismatch is a plausible source of Android build failures and hasn't been
  ruled out.

## Next milestone

Two Android phones, on separate mobile-data connections, join the same
Ridezz room, talk simultaneously over earbuds/headsets, mute/unmute, then
lock both screens while audio keeps working.
