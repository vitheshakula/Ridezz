# Ridezz

Ridezz is a budget motorcycle group-intercom app. Up to 10 riders join one
persistent voice room and talk continuously over mobile data/Wi-Fi, while the
phone stays locked in a pocket and audio routes through whatever the rider is
already wearing (Bluetooth helmet headset, Bluetooth earbuds, wired
earphones, or the phone speaker/mic).

Bluetooth in this app is **only** an audio accessory connection — it is never
used for rider-to-rider networking. All rider-to-rider audio travels over
WebRTC via LiveKit.

## Architecture

```
Ridezz/
├── mobile/   React Native (TypeScript) Android-first app
├── server/   Node.js + TypeScript backend (LiveKit token issuance)
```

- **mobile/** — Bare React Native app (not Expo Go) so native WebRTC and
  background-audio behavior work correctly. Uses LiveKit's React Native SDK
  (`@livekit/react-native`, `@livekit/react-native-webrtc`, `livekit-client`)
  for realtime audio over WebRTC.
- **server/** — Will issue short-lived LiveKit access tokens so API secrets
  never live in the mobile app. Not built out yet; the mobile app currently
  targets LiveKit's development token flow for early bring-up.
- **LiveKit Cloud** — hosts the SFU/media infrastructure. No custom WebRTC
  SFU is implemented in this repo.

## Current MVP scope

1. Enter rider name
2. Enter/join a room
3. Continuous full-duplex voice for up to 10 riders
4. Large mute/unmute button
5. Connected rider list
6. Connection state: Connected / Reconnecting / Disconnected
7. Automatic reconnection where supported
8. Audio continues while the phone is locked/backgrounded
9. Bluetooth/wired/system audio routing
10. Leave ride

Explicitly out of scope for now: accounts/signup, a database, maps,
messaging, GPS tracking, SOS, social features, and ride history.

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for what's actually done.

## Local development setup

Prerequisites:

- Node.js and npm
- Android SDK (`ANDROID_HOME` / `ANDROID_SDK_ROOT`) with an installed
  platform + build-tools, and either a device or emulator
- A JDK compatible with the installed Android Gradle Plugin (currently
  verify against the version in `mobile/android`)

Install and run the mobile app:

```sh
cd mobile
npm install
npx react-native run-android
```

## Planned LiveKit integration

The mobile app depends on:

- `@livekit/react-native` — React Native SDK / room APIs
- `@livekit/react-native-webrtc` — native WebRTC bindings
- `livekit-client` — core LiveKit client used by the RN SDK

Joining a real room requires a LiveKit access token, generated either via
LiveKit Cloud's development token flow (short-term, for bring-up only) or by
the `server/` token service (production path). LiveKit API secrets must
never be embedded in the mobile app — only short-lived tokens are sent to
clients.

## Android-first testing strategy

The first real milestone is two Android phones, on separate mobile-data
connections, joining the same room, talking simultaneously over
earbuds/headsets, muting/unmuting, and continuing to work with both screens
locked. iOS is not a target until the Android path is proven.
