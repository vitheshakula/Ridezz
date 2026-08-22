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

### First realtime LiveKit audio room

- `mobile/App.tsx` switches between `JoinScreen` and `RideScreen` based on
  local session state (no navigation library — not needed yet).
- `mobile/src/screens/JoinScreen.tsx`: rider name + room code form, requests
  Android `RECORD_AUDIO` permission at runtime (blocks join with a message
  on denial), fetches a LiveKit connection via the token service, disables
  the button and shows a spinner while joining (prevents duplicate taps),
  and surfaces connection/permission errors inline instead of failing
  silently.
- `mobile/src/services/livekit.ts`: wraps LiveKit's
  `TokenSource.developmentTokenServer(...)`. Normalizes the rider-typed room
  code (trim/collapse whitespace/lowercase) and generates a unique
  `participantIdentity` per join (`<slugified-name>-<random>`) so two
  riders can't collide by typing the same display name, while
  `participantName` stays the human-entered name.
- `mobile/src/screens/RideScreen.tsx`: wraps LiveKit's `<LiveKitRoom>`
  component (`audio` publish on, `video` off — audio-only app) which owns
  connect/publish/disconnect lifecycle; starts/stops `AudioSession` (native
  audio engine) on mount/unmount. Uses the SDK's own hooks —
  `useConnectionState`, `useLocalParticipant`, `useRemoteParticipants` —
  for a live rider list and connection state
  (Connecting/Connected/Reconnecting/Disconnected, plus a separate `Error`
  state surfaced via `onError`/`onMediaDeviceFailure`). No manual
  reconnection logic — this only observes the SDK's own behavior.
- `mobile/src/components/MuteButton.tsx`: single large button, defaults to
  unmuted after join, toggles `localParticipant.setMicrophoneEnabled()`.
- Leave Ride returns to the Join screen, which unmounts `<LiveKitRoom>`
  (disconnects/unpublishes automatically) and stops the audio session.
- `mobile/src/config/devConfig.ts` holds `LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID`
  — LiveKit Cloud's Development Token Server (Sandbox) ID for the Ridezz
  project. Not a secret, but environment-specific. **Set to the real value
  (`ridezz-jpbfuv`) and verified working** — see Physical device
  verification below. Note this must be the Sandbox *ID*, not the sandbox
  *URL* shown in the dashboard; passing the URL gets a 404 from LiveKit's
  endpoint (hit this exact mistake once, documented in the file). This flow
  is temporary and will be replaced by `server/`'s own token endpoint
  before production.
- Manual Jest mock at `mobile/__mocks__/@livekit/react-native.tsx`: the real
  package touches native modules that don't exist under Jest, so
  `App.test.tsx` runs against a lightweight stub of the handful of exports
  our code actually uses.

### Hermes startup crash fixes

- **`DOMException`**: Hermes has no global `DOMException`, and
  `livekit-client`'s `RemoteParticipant` -> `deferrable-map.ts` does
  `class DeferrableMapAbortError extends DOMException` at module-evaluation
  time. Fixed with `mobile/src/polyfills/domException.ts`, a direct
  `global.DOMException = ...` assignment guaranteed to run first.
- **`TextEncoder`/`TextDecoder`**: Hermes on-device provides `TextEncoder`
  natively but not `TextDecoder` (confirmed independently — they are not a
  package deal on this stack). `livekit-client`'s data-stream reassembly
  path references `TextDecoder`. `@livekit/react-native` vendors a polyfill
  for this, but it turned out to be silently broken by this project's
  Metro/Babel transform of that specific pre-minified vendor file (proven
  by diffing Metro's compiled output against the source, and confirmed
  on-device via `Object.getOwnPropertyDescriptor` that no property was ever
  created) — a build-pipeline bug, not an ordering issue, unrelated to
  which package imports it or when. Fixed with a small hand-written UTF-8
  `TextEncoder`/`TextDecoder` in `mobile/src/polyfills/textEncoding.ts`
  (supports streaming decode across chunk boundaries), assigned via the
  same direct-write pattern.
- Both polyfills are consolidated behind `mobile/src/polyfills/index.ts`,
  which `index.js` imports as the guaranteed-first statement — before
  `@livekit/react-native`, before anything that could reach
  `livekit-client`.

### Physical device verification (RMX3853, Android)

Installed and run via Metro dev server + `adb`. Confirmed via `adb logcat`
and screenshots, in order:

1. App launches to the Join screen with no crash (DOMException/TextDecoder
   fixes hold on real hardware).
2. Entered rider name + room code, tapped Join Ride: LiveKit token fetched
   successfully from the Development Token Server (once configured with
   the correct Sandbox ID), WebSocket connected to
   `wss://ridezz-xxrxarpe.livekit.cloud`, joined room `test01`.
3. Connection state showed **Connected**, rider list showed "Vithesh
   (you)", 1 rider.
4. Microphone publishing confirmed active: Android status bar shows the
   mic-in-use indicator, and logcat shows `requestAudioFocus()` with
   `USAGE_VOICE_COMMUNICATION` from LiveKit's `AudioSwitchManager`.
5. Mute button tapped: turned red/"UNMUTE", mic status bar indicator
   disappeared (publication actually stopped, not just a UI toggle).
   Unmuted again successfully.
6. Leave Ride tapped: logcat shows `disconnect from room`,
   `abandonAudioFocus()`, `connection state changed: connected ->
   disconnected`; app returned cleanly to the Join screen.

No errors, warnings, or crashes at any step. This is single-device
verification only (mic publish + connect + clean teardown) — **two-phone
simultaneous audio has not been tested yet.**

## Not done yet (known gaps)

- **Two-phone physical testing has not happened yet.** Single-device join
  (connect, publish, mute, leave) is verified working end-to-end. Two
  phones talking to each other simultaneously, on separate networks, is
  still untested.
- **No Android foreground service for background audio — known
  limitation, deliberately deferred.** The app currently only keeps
  publishing/receiving audio while in the foreground. Locking the screen or
  backgrounding the app on Android will very likely suspend the mic/audio
  session (Android reclaims audio resources from backgrounded apps without
  a foreground service, and Android 14+ specifically requires a
  `microphone`-typed foreground service for this).
- **No `server/` implementation.** Token issuance backend is not built;
  the app still uses LiveKit's Development Token Server directly.
- No reconnection UI beyond surfacing the SDK's own connection state; no
  retry/backoff logic has been added on top of it.
- iOS not set up/tested (Android-first per product direction).
- JDK note: system default `java` resolves to JDK 23
  (`C:\Program Files\Java\jdk-23`), no JDK 17/21 present. Build-verified
  working with this project's Gradle 9.4.1 / AGP setup.

## Verification status

`tsc --noEmit`, `eslint .`, and `jest` all pass. `./gradlew assembleDebug`
builds successfully. Metro bundling (both dev and production) resolves the
full dependency graph without errors. Beyond static checks, the app has now
been verified working on a real Android phone: launches without crashing,
joins a real LiveKit Cloud room, publishes/unpublishes the microphone, and
leaves cleanly.

## Next milestone

Two-phone simultaneous test: two Android phones, on separate networks,
join the same room, talk over each other, mute/unmute, leave/rejoin, then
implement Android locked-screen/background intercom survival based on
what's observed.
