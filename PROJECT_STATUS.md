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

### 10-rider readiness and presence

**Room capacity (target: 10)**: enforced client-side, in
`mobile/src/utils/riderPresence.ts` (`isRoomOverCapacity`) and wired into
`RideScreen.tsx`. The Development Token Server has no field for
server-side room capacity (checked `TokenSourceFetchOptions` — no
`maxParticipants`-equivalent), so `<LiveKitRoom>` is now given `audio={false}`
and the mic is only published *after* connecting, once we check the
server-reported `room.numParticipants`: if we'd be the 11th rider, we
disconnect immediately with a visible "This ride is full (10/10 riders)"
message and return to the Join screen, without ever publishing audio into
an over-capacity room. This is an explicitly accepted best-effort check,
not a hard guarantee — two riders joining in the same instant could both
slip through. **Authoritative enforcement moves to the future Ridezz token
backend**, which can refuse to mint an 11th token for a full room instead
of catching it after the fact.

**Rider presence model**: the top-level Connected/Reconnecting/
Disconnected/Error state continues to describe only the local rider's own
LiveKit connection (unchanged). Each rider row now shows real, non-fabricated
per-participant state from LiveKit's own SDK:
- **Speaking** — `useIsSpeaking(participant)` (real SDK speaking detection,
  no custom VAD).
- **Muted** — `useIsMuted({ participant, source: Track.Source.Microphone })`
  (real publication mute state).
- **Connection quality** — LiveKit's own `ConnectionQuality` enum
  (`Excellent`/`Good`/`Poor`/`Lost`/`Unknown`) via a small direct
  subscription to `ParticipantEvent.ConnectionQualityChanged`
  (`useParticipantConnectionQuality`), since components-react doesn't
  publicly export a bare per-participant quality hook. `Poor` → "Poor
  connection", `Lost` → "Connection lost"; Excellent/Good/Unknown show
  nothing (quiet by default). Explicitly does **not** fabricate a
  "Reconnecting" state for remote riders — LiveKit doesn't expose enough
  to distinguish that from the outside, so a remote rider's real dropout
  is only ever reported once `ParticipantDisconnected` actually fires
  ("X left the ride"), and returning under the *same* LiveKit identity
  is reported as "X rejoined" (tracked via a locally-remembered
  seen-identities set — real identity continuity, not guessed).
- List ordering is deterministic: local rider first, then remote riders by
  real server-assigned `participant.joinedAt`, not alphabetical, so the
  list doesn't reshuffle on every render.
- Join/leave/rejoin produce a lightweight, non-blocking, auto-dismissing
  banner (`PresenceToast`) — never a modal. Riders already in the room
  when you join aren't announced.

**Performance**: audited against the task's checklist — `<LiveKitRoom>`
still creates its `Room` once per mount (unchanged, verified in
`useLiveKitRoom`'s source, no new inline `options` object was introduced
to break that memoization); each `RiderRow` subscribes only to its own
participant's events (no cross-listening); remote audio continues to play
automatically through the existing WebRTC/AudioSession engine with zero
per-participant audio components added; `useIsSpeaking`/quality updates
are boolean/enum state, not raw high-frequency audio-level floats.

**Tests** (`mobile/__tests__/riderPresence.test.ts`, 23 cases, all pure
functions — no LiveKit simulator): capacity at 1/2/10/11 riders, join
ordering (including a full 10-rider list), presence diffing (join, leave,
rejoin, no-op, partial 1→2, and filling 0→10), connection-quality label
mapping, and the muted/speaking/quality status-label priority rule.

**Physical verification**: only one physical device was available this
session (same as the background-service task). Directly confirmed on that
device: capacity check doesn't false-positive for a normal 1-rider join
("1 / 10 riders"), the local rider's own row shows "You" and correctly
reflects live Muted state on mute/unmute, and the background-service
regression check passed (service still starts on join, still stops
cleanly on Leave Ride with these changes in place). **Not directly
observed**: a second rider's row as seen by a peer (name, Speaking,
Muted, connection-quality label), cross-device join/leave/rejoin toasts,
and 10 simultaneous riders — these are architecturally implemented and
unit-tested but need a second (and ideally several more) physical
device(s) to confirm cross-device.

### Live rider location sharing and group map

**Libraries chosen**: `react-native-maps@1.29.0` (Android renders via Google
Maps — confirmed Fabric/New-Architecture compatible via its own
`codegenConfig`) and `@react-native-community/geolocation@3.4.0` (a real
TurboModule, confirmed via its `Spec extends TurboModule` typing). Both
autolink cleanly; `react-native-maps` additionally pulls in
`play-services-maps`/`play-services-location`/`play-services-base` as
transitive Gradle deps.

**Google Maps API key handling**: `react-native-maps` needs a
`com.google.android.geo.API_KEY` manifest meta-data entry to render actual
map tiles on Android. No key was invented or committed. Instead:
`mobile/android/app/build.gradle` reads `MAPS_API_KEY` from
`local.properties` (already gitignored) and exposes it as a Gradle
`manifestPlaceholder`, consumed in `AndroidManifest.xml` as `${mapsApiKey}`.
`mobile/android/local.properties.example` documents how to get a real key
(Google Cloud Console → enable "Maps SDK for Android" → restrict to package
`com.ridezz.mobile` + debug/release SHA-1). Without a key set, the app
builds and runs fine — the map tab shows the native map surface with a
"Google" watermark but no tiles, which is expected and does not affect the
intercom.

**Permissions / foreground service**: `ACCESS_FINE_LOCATION`,
`ACCESS_COARSE_LOCATION`, and `FOREGROUND_SERVICE_LOCATION` added to
`AndroidManifest.xml`. **No `ACCESS_BACKGROUND_LOCATION`** — while the
screen is locked, GPS access happens through the same already-running
`RidezzIntercomService` that keeps the mic alive, and Android treats
location used by an active location-typed foreground service as foreground
access. `RidezzIntercomService`'s `startForeground()` call now declares
`FOREGROUND_SERVICE_TYPE_MICROPHONE or FOREGROUND_SERVICE_TYPE_LOCATION`
(manifest `foregroundServiceType="microphone|location"`). While making this
change, found and fixed a real pre-existing bug: the API-level gate for
that `startForeground()` overload was `Build.VERSION_CODES.Q` (29), but
`FOREGROUND_SERVICE_TYPE_MICROPHONE` actually requires API 30 (R) —
confirmed directly against this project's installed
`platforms/android-36/data/api-versions.xml` (`FOREGROUND_SERVICE_TYPE_LOCATION`
is `since="29"`, `FOREGROUND_SERVICE_TYPE_MICROPHONE` is `since="30"`).
Fixed the gate to `Build.VERSION_CODES.R`. Runtime location permission is
requested in `JoinScreen.tsx`, best-effort and non-blocking (denial doesn't
stop the ride — it just disables location/map for that rider, surfaced as
a warning banner on the Map tab).

**Update policy**: `distanceFilter: 15` meters, `interval: 4000` /
`fastestInterval: 3000` ms, `enableHighAccuracy: false`. Deliberately not a
maximum-precision, high-frequency GPS lock — motorcycles move in relatively
continuous lines and riders care about "roughly where is everyone," not
sub-second tracking, so this trades some freshness for meaningfully less
battery/radio use. Documented in `useRiderLocations.ts`.

**LiveKit data protocol**: dedicated topic `ridezz.location`, small
versioned JSON payload `{v, lat, lng, accuracy, timestamp}`, sent via
`publishData(..., { reliable: false, topic })` (lossy/unreliable — only the
newest fix matters, no need to retransmit a stale one). Sender identity
comes from the LiveKit `Participant` object attached to `RoomEvent.DataReceived`
(`participant.identity` / `participant.name`), never from data inside the
payload itself. `decodeLocationPayload()` in `mobile/src/utils/riderLocation.ts`
validates every incoming packet — non-object, wrong version, out-of-range
lat/lng, missing/absurd/future timestamp — and returns `null` (silently
dropped) rather than throwing, so a malformed or hostile packet can never
crash the app or corrupt state. On `ParticipantDisconnected`, a rider's last
known position is kept and marked `connected: false` (never erased) so the
UI can show "offline," not a fake live position. Freshness classification
(`classifyFreshness`): Live &lt;10s, Stale 10–60s, Offline (disconnected or
&gt;60s).

**A real bug found and fixed this session**: the local rider's own location
entry was initially keyed under an empty-string identity, because
`localParticipant.identity` isn't populated by the LiveKit server until
shortly after connect, and the original `useRiderLocations` effect closed
over that value directly (re-subscribing the GPS watch when identity later
changed wasn't reliable — and on a stationary phone, the OS's own location
provider often won't deliver a *new* fix to justify the resubscription
anyway, so the stale empty-keyed entry never got corrected). Fixed by
reading identity/name through a `ref` updated on every render, so a single
long-lived GPS watch always attributes fixes to whichever identity is
*currently* known, without needing to tear down and restart the underlying
OS-level location subscription. Verified via live device logs
(`mobile/__tests__` doesn't cover this — it's a hook-level, not pure-function,
concern) that a freshly-joined rider's own location now appears in state
correctly keyed within seconds of connecting.

**Map UI**: `RiderMap.tsx` — Intercom/Map segmented tabs in `RideScreen`,
markers for local + remote riders (local rider in blue, others colored by
freshness: green/live, amber/stale, grey/offline at reduced opacity), tap a
marker for a minimal callout (name, online/offline, "Updated Ns ago",
accuracy, and — for other riders — haversine distance phrased "X away",
deliberately **not** "ahead/behind," since there's no real route/heading
model to justify that). "Fit Group" and "Center Me" buttons are the only
camera control; the map does not auto-fit or auto-follow continuously. A
one-time initial camera placement fires when the local rider's first GPS
fix arrives (since `MapView`'s `initialRegion` prop only applies once, at
mount, before any fix exists yet).

**Physical verification (single device, RMX3853)**: confirmed end-to-end via
live `adb logcat` — permission granted, GPS/network location acquired,
correctly keyed into a `RiderLocation` under the real LiveKit identity
within seconds of joining, `locationPermissionGranted` state correct. GPS
continued to register with the OS across the existing foreground service
(no separate verification needed here beyond the prior 1/5-minute
locked-screen tests, since this reuses that same already-verified
mechanism). **Not visually confirmed**: whether a marker actually renders
on top of the map surface. With `MAPS_API_KEY` unset (no real key
available this session), `MapView`'s `onMapReady` callback never fires —
confirmed directly by instrumenting it — meaning the underlying native
Google Maps object never finishes initializing without a valid,
billing-enabled key. This is standard Google Maps SDK behavior (the
watermark logo is a static asset shown regardless of key validity; actual
map/marker/camera functionality is not), not a defect in Ridezz's code.
**A real Google Maps API key is required to visually verify markers, "Fit
Group," and "Center Me" on this or any device.** Two-phone tests (seeing a
peer's marker move, staleness after locking, recovery after a network
drop) were **not performed** — only one physical device was available this
session, same limitation as prior tasks.

**Tests** (`mobile/__tests__/riderLocation.test.ts`, 23 cases, pure
functions only): payload encode/decode round-trip, malformed JSON,
unsupported version, out-of-range/missing/future-timestamp rejection,
optional accuracy, upsert/replace/disconnect semantics, a 10-rider state,
live/stale/offline classification (including disconnected overriding a
fresh timestamp), haversine distance, and distance formatting. No
dev-only mocked-rider-row rendering mode was built (the task marked this
optional).

### Road-test polish (audible cues, mounted mode, diagnostics, standalone build)

**Real Google Maps API key verification**: a real key was added to (gitignored)
`local.properties` this session. It did **not** resolve the map — Google's
own SDK rejects it: `Google Maps Android API: Error requesting API token.
StatusCode=INVALID_ARGUMENT`, and logcat's `Authorization failure` message
prints the exact package/SHA-1 pair the key needs to be authorized for:
package `com.ridezz.mobile`, SHA-1
`5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25` (the debug
keystore's fingerprint — also what the standalone release build below is
signed with, so this one fingerprint covers both). **This needs fixing in
Google Cloud Console** (enable "Maps SDK for Android" on the project that
owns this key, add this exact package+SHA-1 pair as an Android app
restriction if one exists, confirm billing is enabled on the project) — it
is not something fixable from the app side. Two-phone map verification
(peer markers, staleness after lock, recovery after a drop) is blocked on
this and was **not performed**.

**Audible cues**: `RidezzAudioCuesModule.kt` — Android `SoundPool` with
`AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING` (the same attribute
Android itself uses for in-call tones like DTMF), so cues ride whatever
route the LiveKit call is already using and never touch audio focus or
`AudioManager` mode — meaning they genuinely can't interrupt or restart the
call, by construction, not just by care. Four short WAV tones
(`mobile/android/app/src/main/res/raw/cue_*.wav`, ~9-12KB each) were
synthesized locally (simple sine-wave "bip-boop" patterns, no external/
copyrighted assets) for rider-joined, rider-left, connection-lost, and
connection-restored. Join/leave cues reuse the exact same de-duplicated
presence-diff events that already drive the toast banner
(`useRiderPresenceToasts`'s new optional `onEvent` callback) rather than
re-deriving them. Connection-lost/restored cues come from a new pure
function, `classifyConnectionTransition` (`mobile/src/utils/connectionCues.ts`,
8 unit tests) — "lost" only fires from a previously-*healthy* Connected
state and "restored" only from a previously-reconnecting state, so there's
no cue on the initial join and no repeat cue for an ongoing reconnect
attempt. **Verified on-device**: toggling airplane mode mid-ride correctly
drove the room through Reconnecting and back to Connected, with exactly one
"lost" and one "restored" transition logged (see diagnostics below) and no
native errors.

**Keep screen awake**: `RidezzKeepAwakeModule.kt` toggles
`WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON` on the current Activity's
window — scoped to that window only, never touches the system-wide display
timeout. OFF by default. `useKeepAwake` mirrors a toggle onto this flag and
*always* releases it on unmount regardless of the toggle's last value, so
Leave Ride can never strand the screen pinned on; the hook lives at the
RideRoom level (not per-tab), so switching Intercom/Map doesn't release it.
**Verified on-device** via `dumpsys window` showing the `KEEP_SCREEN_ON`
flag appear and disappear exactly on toggle.

**Diagnostics log**: a bounded (100-event), in-memory, session-scoped ring
buffer (`mobile/src/utils/diagnostics.ts`, 4 unit tests) recording only
operational metadata — joined room, connection lost/restored, rider
joined/left, location started/permission-unavailable/paused/resumed — each
with a timestamp and a short message. Explicitly never records audio,
conversation content, a GPS trail, keys, or tokens. A `Diagnostics` link on
the Ride screen opens a read-only modal, newest-first. **Verified
on-device**: real events appeared with correct timestamps across two
separate rides in the same app session (confirming it's session-scoped,
not per-ride), including the airplane-mode connection-lost/restored pair
matching the audible-cue transitions above.

**Screen polish**: a `Leave ride?` confirmation (`Alert.alert`, Cancel /
Leave Ride) now guards the Leave Ride button — verified on-device that a
stray tap no longer ends the ride outright. Added a "Keep screen awake"
toggle and "Diagnostics" link in a new row below the rider count, visible
regardless of active tab. Connection status, rider count, and tabs were
already reasonably sized (`MuteButton` is already 200×200dp) so were left
alone rather than redesigned.

**Standalone road-test APK**: `mobile/android/app/build.gradle`'s `release`
build type already signed with the project's debug keystore (the RN
template default, since no separate release keystore was ever generated) —
this is **test-only signing**, not a production setup, and must not be
treated as one; a real road-test/production release needs its own
generated keystore, kept out of source control, before any wider
distribution. Built via `./gradlew assembleRelease`, which embeds the JS
bundle and assets into the APK (confirmed: `assets/index.android.bundle`,
~2.7MB, present inside the APK) — no Metro/dev-server dependency at
runtime. Exact path:
`mobile/android/app/build/outputs/apk/release/app-release.apk` (~103MB,
universal APK covering all 4 ABIs, gitignored — never commit built
APKs). **Verified exactly as required**: installed on the physical
device, all Metro/node processes killed and confirmed unreachable
(`curl` connection-refused), `adb reverse tcp:8081` removed, app
launched straight to the Join screen with no "Loading from
localhost:8081" step, Wi-Fi disabled to force mobile data (confirmed via
`dumpsys connectivity` showing only a `CELLULAR` network), joined a real
LiveKit room, and the local rider's "Speaking" indicator went live —
confirming mic capture and publish work with zero dev-server
connectivity. Foreground service (`RidezzIntercomService`) also verified
running with the correct `microphone|location` type in this exact release
build via `dumpsys activity services`, and stopped cleanly (service entry
disappears) on Leave Ride.

## Not done yet (known gaps)

- **Google Maps API key not authorized.** The key currently in
  `local.properties` is rejected by Google (`INVALID_ARGUMENT`) — needs
  "Maps SDK for Android" enabled, billing confirmed, and package
  `com.ridezz.mobile` + SHA-1
  `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25` authorized
  for it in Google Cloud Console, before map tiles/markers/"Fit Group"/
  "Center Me" can be visually verified on any device or build signed with
  this same (debug) keystore.
- **Location/map cross-device behavior untested** — a peer's marker
  appearing/moving, staleness after locking, and recovery after a network
  drop all need a second physical device, and are additionally blocked on
  the API key issue above.
- **Standalone-build two-phone regression untested** — same single-device
  limitation as every other cross-device item on this list; only the
  single-device checks described above were performed against the release
  APK.
- **No production signing key.** The standalone APK above is signed with
  the shared, publicly-known debug keystore (fixed alias/password) — fine
  for handing to known riders for tomorrow's test, not appropriate for any
  wider distribution.
- **Both-phones-locked simultaneously untested** — needs a second device.
- **Cross-device rider presence untested** — remote Speaking/Muted/quality
  indicators and join/leave/rejoin toasts, and true 10-simultaneous-rider
  load, all need multiple physical devices to verify beyond unit tests.
- **10-rider capacity enforcement is best-effort, not authoritative** —
  a race between two riders joining at the same instant could both get
  in; the future token backend is needed to close this properly.
- **No `server/` implementation.** Token issuance backend is not built;
  the app still uses LiveKit's Development Token Server directly.
- No reconnection UI beyond surfacing the SDK's own connection state; no
  retry/backoff logic has been added on top of it.
- No mute/leave controls on the ongoing notification (deliberately out of
  scope).
- No dev-only mocked-rider-row rendering mode was built (the task marked
  this optional; skipped to avoid any risk of fake data leaking into a
  real build for a first pass).
- iOS not set up/tested (Android-first per product direction).
- JDK note: system default `java` resolves to JDK 23
  (`C:\Program Files\Java\jdk-23`), no JDK 17/21 present. Build-verified
  working with this project's Gradle 9.4.1 / AGP setup.

## Verification status

`tsc --noEmit`, `eslint .`, and `jest` (59 tests, all passing) all pass.
`./gradlew assembleDebug` and `./gradlew assembleRelease` both build
successfully. Metro bundling (dev and production) resolves the full
dependency graph without errors. Verified on a real Android phone:
launches without crashing, joins a real LiveKit Cloud room, publishes/
unpublishes the microphone, survives 1 and 5 minutes locked with no
reconnect, survives a brief network interruption while locked (both as a
Metro dev build and, this session, as the standalone release APK), leaves
cleanly, correctly shows rider capacity/presence UI, preserves the
background-service lifecycle, acquires GPS location and correctly
attributes it to the local rider's real LiveKit identity, and — for this
task — plays the correct audible cue exactly once per genuine connection-
lost/restored transition, correctly toggles the keep-screen-on window flag,
correctly logs and displays session diagnostics, and runs fully
standalone (installed APK, Metro/adb-reverse torn down, mobile-data-only)
with working audio. Map tile/marker rendering still needs an authorized
Google Maps API key to verify visually (see known gaps above).

## Next milestone

Run Ridezz on the real motorcycle group ride and record field-test results
before adding further features.
