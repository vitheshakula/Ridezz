# Ridezz mobile

React Native (TypeScript) app for Ridezz, Android first. Riders sign in, host or join a ride room
with a 5-digit code, and talk over LiveKit voice while sharing location, a destination and hazard
alerts. Offline, alerts travel rider to rider over Google Nearby Connections.

## Requirements

- Node.js 22 (see `/.nvmrc`)
- JDK 17 and the Android SDK (`ANDROID_HOME`), with a device or emulator
- A running Ridezz server (see `../server/README.md`)

## Quick start

```sh
npm ci
cp .env.dev.example .env.dev   # point API_URL at your server
npm start                      # Metro, in its own terminal
npm run android                # builds and installs the dev flavor
```

On a physical phone, `localhost` is the phone itself. Use `adb reverse tcp:5000 tcp:5000`, your
computer's LAN address, or an HTTPS tunnel in `API_URL`.

## Environments

The Android app has three environments, built as Gradle product flavors (`android/app/build.gradle`):

| Flavor    | Application id               | App name          | Env file        | Points at                     |
|-----------|------------------------------|-------------------|-----------------|-------------------------------|
| `dev`     | `com.rideaze.mobile.dev`     | Rideaze Dev       | `.env.dev`      | Your local server             |
| `staging` | `com.rideaze.mobile.staging` | Rideaze Staging   | `.env.staging`  | The shared hosted test server |
| `prod`    | `com.rideaze.mobile`         | Rideaze           | `.env.prod`     | Production                    |

Each flavor has its own application id, so all three can be installed on one phone side by side.
Combined with the build types this gives variants such as `devDebug`, `stagingRelease` and
`prodRelease`.

**Setup:** copy each example you need and fill it in (the real files are gitignored):

```sh
cp .env.dev.example .env.dev
cp .env.staging.example .env.staging
cp .env.prod.example .env.prod
```

The values are read by [`react-native-config`](https://github.com/react-native-config/react-native-config)
and baked into the native build, so **after changing an env file, rebuild the app** -- restarting
Metro is not enough. App code reads them only through `src/config/appConfig.ts`, which also exposes
`APP_ENV` (`'dev' | 'staging' | 'prod'`).

| Task                                   | Command                         |
|----------------------------------------|---------------------------------|
| Run dev on a device (default)          | `npm run android`               |
| Run staging / prod in debug mode       | `npm run android:staging` / `npm run android:prod` |
| Build a staging release APK            | `npm run build:android:staging` |
| Build the prod release bundle (AAB)    | `npm run build:android:prod`    |

Always name the flavor in Gradle tasks (`assembleStagingRelease`, not `assembleRelease`), and build
one flavor per Gradle run: the env file is chosen once per run from the task name, so the build
refuses flavorless or mixed-flavor task lists rather than baking in the wrong backend.

Google Sign-In needs an Android OAuth client for each application id you use (see
`server/README.md`, *Google Cloud setup*). Release builds are still signed with the debug keystore,
which is fine for testing but must be replaced before a Play Store release.

iOS has no flavors yet; an iOS build reads `.env` and reports itself as `dev`.

## Scripts

| Script                   | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `npm start`              | Metro bundler                                   |
| `npm run android[:env]`  | Build, install and launch a debug build         |
| `npm run lint`           | ESLint (`@react-native` config, no raw console) |
| `npm run typecheck`      | TypeScript                                      |
| `npm run format` / `format:check` | Prettier                               |
| `npm test`               | Jest unit tests                                 |
| `npm run test:coverage`  | Jest with the coverage threshold                |

Kotlin unit tests for the crash-detection pipeline run with
`cd android && ./gradlew testDevDebugUnitTest`.

## Project layout

| Path                   | Contents                                                      |
| ---------------------- | ------------------------------------------------------------- |
| `src/screens`          | Screens and navigation targets                                |
| `src/components`       | Reusable UI (map, rider list, controls)                       |
| `src/context`          | React contexts (auth session)                                 |
| `src/hooks`            | Ride, location and presence hooks                             |
| `src/services`         | API client, routing, geocoding, voice and connectivity wiring |
| `src/connectivity`     | Offline mesh protocol: framing, acknowledgements, outbox, relay |
| `src/transports`       | Nearby and LiveKit transport adapters                         |
| `src/hazards`, `src/braking`, `src/crash` | Hazard alerts, hard-braking and crash detection |
| `src/config`           | Environment configuration (`appConfig.ts`)                    |
| `src/utils`            | Pure helpers (validation, geometry, logging)                  |
| `__tests__`            | Jest tests; `__mocks__` holds native module mocks             |
| `android/`             | Native Android project and Kotlin modules                     |
| `scripts/vosk-grammar` | Generator for the offline speech grammar                      |

Design notes for the connectivity layer are in `../docs/architecture`.

## Sessions

`src/services/AuthService.ts` stores the access token and refresh token
(`src/services/sessionTokens.ts`). When the server answers `401`, the API client refreshes once,
shared between all requests that failed at the same moment, and retries them. If the refresh token
is rejected, the tokens are cleared and `AuthContext` signs the rider out; if the server is merely
unreachable, the session is kept. Logging out revokes the refresh token on the server.

Point `API_URL` at `/api/v1` to get 15-minute access tokens. An `.env` that still ends in `/api`
works too, with 30-day access tokens.

## Logging

Use `createLogger(scope)` from `src/utils/logger.ts`, never `console` directly (ESLint enforces
this). Debug messages are dropped in release builds, so anything that identifies a rider, such as
positions or dictated messages, must be logged at `debug` only.

## iOS

The iOS project exists from the React Native template but is untested and has no flavors.
