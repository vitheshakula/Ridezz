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

No errors, warnings, or crashes at any step.

### Two-phone verification

Two physical Android phones joining the same room over separate
mobile-data networks: full-duplex audio, Bluetooth/wired/phone audio
routes, mute/unmute, leave/rejoin, and automatic recovery from temporary
network loss all confirmed working. The one gap identified there —
**locking the screen disconnected the rider; unlocking let it recover** —
is what this section's foreground-service work fixes.

### Android background/lock-screen survival

**Root cause**: nothing in our own code or in `@livekit/react-native`
tears anything down on backgrounding (no `AppState` listener exists
anywhere in that SDK). The disconnect was Android's own process lifecycle
management: with no foreground service, a backgrounded/locked app has no
claim to stay at foreground priority, so the OS (and on this device's
OEM skin — Realme/ColorOS — especially aggressively) suspends or kills it,
taking the WebRTC/LiveKit connection down with it. Confirmed directly:
ColorOS's own `OplusHansManager` logs `cannot transition from D to F,
importance=audioFocus` once the fix is in place — i.e. the OS *is* trying
to freeze the app on lock, and is specifically blocked from doing so by
the foreground service holding audio focus.

**Implementation** (`mobile/android/app/src/main/java/com/ridezz/mobile/`):
- `RidezzIntercomService.kt` — a foreground `Service` with no LiveKit/WebRTC
  logic of its own; its only job is to hold the existing process at
  foreground priority via an ongoing notification. The already-working
  `<LiveKitRoom>` / `AudioSession` JS session is untouched and keeps running
  in the same process.
- `RidezzIntercomModule.kt` + `RidezzIntercomPackage.kt` — a small RN
  native module exposing `startIntercomService()` / `stopIntercomService()`
  as promise-based JS calls; native start/stop failures reject the promise
  rather than being swallowed.
- Manifest: `foregroundServiceType="microphone"` on the service, plus
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, and
  `POST_NOTIFICATIONS` permissions. `microphone` was chosen deliberately
  (not `mediaPlayback`) because the app's defining backgrounded behavior is
  continuous mic capture via WebRTC, not literal media playback — declaring
  a type that doesn't match actual behavior is also a Play Store policy
  risk. `startForeground()` passes `FOREGROUND_SERVICE_TYPE_MICROPHONE`
  explicitly on API 29+ (targetSdk is 36 / Android 16, so the strict
  Android 14+ FGS-type enforcement applies).
- `RideScreen.tsx` starts the service (and `POST_NOTIFICATIONS` is
  requested, best-effort, in `JoinScreen.tsx`) in the same mount effect
  that already starts `AudioSession` — i.e. while the Activity is visible,
  as part of the user's own Join Ride tap, never after backgrounding.
  Stopped in the matching cleanup on Leave Ride. A failed service start
  doesn't block the ride (foreground audio still works) — it's surfaced as
  a visible warning instead ("Won't survive a locked screen: ...").
  `stopForeground(STOP_FOREGROUND_REMOVE)` is called explicitly in
  `onDestroy()` so the ongoing notification doesn't linger after Leave Ride.
- Notification: "Ridezz" / "Intercom active", `IMPORTANCE_LOW` channel (no
  sound, no badge, no heads-up), ongoing/non-dismissable while active, tap
  reopens the app, removed on Leave Ride. No controls on it yet.
- Screen is never forced awake — riders can lock normally, matching the
  product requirement.

**Physical verification** (single device, RMX3853/Realme, screen genuinely
confirmed locked via `dumpsys power`/`dumpsys window` at each step, not
just assumed):
- **1 minute locked**: passed (ran to 3+ minutes) — after unlocking, UI
  still showed Connected, 1 rider, mute state preserved, **no reconnect**.
- **5 minutes locked**: passed — `dumpsys` showed the service running
  continuously the entire time (no restart, no gap) and the screen
  genuinely locked (`isKeyguardShowing=true`) for the full duration.
- **Both phones locked simultaneously**: **not tested** — only one
  physical device was available this session. Needs a second device.
- **Network interruption while locked**: passed — toggled Wi-Fi off/on
  (15s) while the phone stayed locked; the room remained Connected
  afterward with no full reconnect cycle. One non-fatal artifact: a
  dev-build-only "Uncaught (in promise)" LogBox warning appeared, tracing
  to an internal WebSocket `error` Event surfacing from
  `livekit-client`/`react-native-webrtc`'s own reconnection handling
  during the network transition — not something in our code, doesn't
  reproduce in release builds (LogBox is dev-only), and didn't affect the
  ride. Worth watching, not a blocker.

**OEM-specific note**: on this device, `dumpsys activity services
<package>` and `dumpsys notification` both occasionally returned stale/
empty results that contradicted ground truth (confirmed by cross-checking
the unfiltered dump, the actual notification shade, and `ps`/`dumpsys
power`/`dumpsys window`). Trust the unfiltered/visual checks over the
filtered ones on ColorOS.

## Not done yet (known gaps)

- **Both-phones-locked simultaneously untested** — needs a second device.
- **No `server/` implementation.** Token issuance backend is not built;
  the app still uses LiveKit's Development Token Server directly.
- No reconnection UI beyond surfacing the SDK's own connection state; no
  retry/backoff logic has been added on top of it.
- No mute/leave controls on the ongoing notification (deliberately out of
  scope for this task).
- iOS not set up/tested (Android-first per product direction).
- JDK note: system default `java` resolves to JDK 23
  (`C:\Program Files\Java\jdk-23`), no JDK 17/21 present. Build-verified
  working with this project's Gradle 9.4.1 / AGP setup.

## Verification status

`tsc --noEmit`, `eslint .`, and `jest` all pass. `./gradlew assembleDebug`
builds successfully, including the new native foreground-service module.
Metro bundling (dev and production) resolves the full dependency graph
without errors. Verified on a real Android phone: launches without
crashing, joins a real LiveKit Cloud room, publishes/unpublishes the
microphone, survives 1 and 5 minutes locked with no reconnect, survives a
brief network interruption while locked, and leaves cleanly (service
stopped, notification removed).

## Next milestone

Prepare Ridezz for 10-rider rooms and improve per-rider connection/
presence state.
