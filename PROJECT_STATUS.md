# Ridezz — Project Status

Last updated: 2026-08-22

## Done

- Git repository initialized locally at project root, connected to GitHub
  remote `origin` (`vitheshakula/Ridezz`, private).
- `mobile/` scaffolded: bare React Native 0.87.0 + TypeScript app
  (`react-native init`, package `com.ridezz.mobile`). Android-first; iOS
  project exists from the template but is untested.
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
  - `registerGlobals()` called in `mobile/index.js` before the app
    registers, as required by the SDK.
- `server/` directory created, intentionally empty — token service not built
  yet.
- Root `.gitignore`, `README.md` created. `debug.keystore` is intentionally
  tracked (RN's own generated `.gitignore` un-ignores it and
  `android/app/build.gradle` references it by a hardcoded path with no
  fallback generation) — it's the standard public debug-only signing key
  (fixed alias/password), not a real secret.

### First realtime LiveKit audio room (this task)

- Rewired `mobile/App.tsx` to switch between `JoinScreen` and `RideScreen`
  based on local session state (no navigation library — not needed yet).
- `mobile/src/screens/JoinScreen.tsx`: rider name + room code form, requests
  Android `RECORD_AUDIO` permission at runtime (blocks join with a message
  on denial), fetches a LiveKit connection via the token service, disables
  the button and shows a spinner while joining (prevents duplicate taps),
  and surfaces connection/permission errors inline instead of failing
  silently.
- `mobile/src/services/livekit.ts`: wraps LiveKit's
  `TokenSource.developmentTokenServer(...)` (the current, non-deprecated
  API in the installed `livekit-client`). Normalizes the rider-typed room
  code (trim/collapse whitespace/lowercase) and generates a unique
  `participantIdentity` per join (`<slugified-name>-<random>`) so two
  riders can't collide by typing the same display name, while
  `participantName` stays the human-entered name.
- `mobile/src/screens/RideScreen.tsx`: wraps LiveKit's `<LiveKitRoom>`
  component (`audio` publish on, `video` off — audio-only app) which
  owns connect/publish/disconnect lifecycle; starts/stops
  `AudioSession` (native audio engine, routes through
  speaker/wired/Bluetooth automatically) on mount/unmount. Uses the SDK's
  own hooks — `useConnectionState`, `useLocalParticipant`,
  `useRemoteParticipants` — for a live rider list and connection state
  (Connecting/Connected/Reconnecting/Disconnected, plus a separate `Error`
  state surfaced via `onError`/`onMediaDeviceFailure`). No manual
  reconnection logic was added — this only observes the SDK's own
  reconnection behavior, as requested.
- `mobile/src/components/MuteButton.tsx`: single large button, defaults to
  unmuted after join, toggles
  `localParticipant.setMicrophoneEnabled()`; remote audio keeps playing
  while locally muted (publish-side only).
- Leave Ride returns to the Join screen, which unmounts `<LiveKitRoom>`
  (disconnects/unpublishes automatically via its own cleanup) and stops the
  audio session — no stale `Room` instances kept around.
- `mobile/src/config/devConfig.ts`: holds
  `LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID`, LiveKit Cloud's Development Token
  Server identifier for the Ridezz project. Not a secret, but
  environment-specific, so it's isolated in one small config file rather
  than scattered through components. **Currently still the placeholder
  `PASTE_TOKEN_SERVER_ID_HERE` — the real ID from the LiveKit Cloud
  dashboard has not been filled in yet, so Join Ride will fail with a clear
  "not configured" error until that's done.** This flow is temporary and
  will be replaced by `server/`'s own token endpoint before production.
- Added a manual Jest mock at `mobile/__mocks__/@livekit/react-native.tsx`:
  the real package touches native modules that don't exist under Jest, so
  the existing `App.test.tsx` smoke test now runs against a lightweight
  stub of the handful of exports (`AudioSession`, `LiveKitRoom`, the
  hooks) our code actually uses, rather than the native bridge.

## Not done yet (known gaps)

- **LiveKit development token server ID not filled in.** See
  `mobile/src/config/devConfig.ts` — joining will fail until this is set.
- **Two-phone physical testing has not happened yet.** Everything below is
  implemented and verified in isolation (types, lint, tests, Android build,
  Metro bundle) but not yet exercised on real devices/real network
  conditions. Do not treat this as working end-to-end until that test runs.
- **No Android foreground service for background audio — known
  limitation, deliberately deferred.** The app currently only keeps
  publishing/receiving audio while in the foreground. Locking the screen or
  backgrounding the app on Android will very likely suspend the mic/audio
  session (Android reclaims audio resources from backgrounded apps without
  a foreground service, and Android 14+ specifically requires a
  `microphone`-typed foreground service for this). This is the explicit
  subject of the next task, not this one.
- **No `server/` implementation.** Token issuance backend is not built.
- No reconnection UI beyond surfacing the SDK's own connection state; no
  retry/backoff logic has been added on top of it.
- iOS not set up/tested (Android-first per product direction).
- JDK note: system default `java` resolves to JDK 23
  (`C:\Program Files\Java\jdk-23`), no JDK 17/21 present. Build-verified
  working with this project's Gradle 9.4.1 / AGP setup.

## Verification status

`tsc --noEmit`, `eslint .`, and `jest` all pass. `./gradlew assembleDebug`
builds successfully and produces
`mobile/android/app/build/outputs/apk/debug/app-debug.apk`. A Metro
production bundle (`react-native bundle --platform android`) was also run
as a sanity check and resolved/bundled the full dependency graph
(including LiveKit) without errors. None of this proves the two-phone
audio path works — that requires the physical-device test described in the
handoff for this task.

## Next milestone

Test on two physical Android phones (see the physical-device test
procedure from this task's handoff), then implement Android
locked-screen/background intercom survival based on what's observed.
