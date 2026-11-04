# Ridezz Hackathon Audit

Audit date: 2026-09-24. Branch audited: `vithesh` (HEAD `cda6443`, up to date with `origin/vithesh`, working tree clean). This is the most current branch in the repo — `master` and `Mahesh` sit one commit behind at `c8fd76e`; `jaswant` is further behind. No modifications were made to the repository while producing this audit.

## Executive Summary

The product has grown well beyond what the repo's own docs describe. `README.md` and `PROJECT_STATUS.md` (last updated 2026-08-22) describe an unauthenticated, database-free, maps-free voice-intercom MVP using LiveKit's development token flow. The actual code on `vithesh` today has: JWT-based signup/login, a Prisma/SQLite backend, server-issued LiveKit tokens, 6-character room codes persisted in a DB, and a full MapLibre/MapTiler map (replacing the previously-blocked Google Maps integration). **None of this newer work is documented anywhere in the repo.**

The core voice-intercom engineering (LiveKit WebRTC, Android foreground service for lock-screen survival, presence, audio cues, diagnostics) is mature, physically verified on real hardware per `PROJECT_STATUS.md`, and still intact in the code. That is the strongest asset for a demo.

Two things stand between "builds on my machine" and "works on a judge's table" right now, both fixable well within two days:

1. **`server/node_modules` does not exist.** The backend cannot start until `npm install` (and a Prisma migrate) is run — nobody has done this in this checkout.
2. **The mobile app's API URL is hardcoded to `http://localhost:.../api`.** On a real Android phone (this project's only tested target) that address does not reach a laptop running the backend. Every login/signup/create-room/join-room call will fail over Wi-Fi or mobile data as configured today.

The third major finding: **there is no AI feature anywhere in this repository.** Zero AI-related packages, imports, prompts, or endpoints exist in `mobile/` or `server/`. If the hackathon rubric rewards an AI component, this is currently a hard zero, not a partially-working one.

## Current Architecture

```
mobile/ (React Native 0.87 + TypeScript, bare RN, Android-first)
  Auth screens (Login/Signup/ForgotPassword-stub)
        │  axios POST /api/auth/{signup,login}
        ▼
server/ (Express + TypeScript, single file: server/src/index.ts)
        │  bcrypt hash/compare, JWT mint (not verified anywhere), Prisma ORM
        ▼
  Prisma / SQLite  (server/prisma/schema.prisma — User, Room)
        │
        │  POST /api/rooms/{create,join}  → mints a LiveKit AccessToken
        ▼
  LiveKit Cloud (external WebRTC SFU — wss://…livekit.cloud)
        │  serverUrl + token handed back to the phone
        ▼
mobile/src/screens/RideScreen.tsx → <LiveKitRoom> (audio-only, WebRTC)
  ├─ Android foreground service (mobile/android/.../RidezzIntercomService.kt) — keeps mic alive when locked
  ├─ mobile/src/hooks/useRiderLocations.ts → LiveKit data channel (topic "ridezz.location")
  └─ mobile/src/components/RiderMap.tsx → MapLibre GL, tiles from MapTiler (external, key in mobile/.env)
```

Duplicated/abandoned path (does not run today): `mobile/src/services/livekit.ts` + `mobile/src/config/devConfig.ts` implement LiveKit's **development-token-server** flow directly from the client (no backend involved). This was the *entire* architecture as of `PROJECT_STATUS.md`. It is now dead code — nothing imports `joinRoom()` from `livekit.ts` except the file itself — superseded by the `server/`-issued token flow in `JoinScreen.tsx`. It is harmless to leave in place but will confuse anyone reading the code cold.

## Technology Stack

- **Mobile**: React Native 0.87.0 (bare, not Expo), TypeScript 6, React 19.2.3, package id `com.ridezz.mobile`.
- **Realtime audio**: `@livekit/react-native` 2.12, `@livekit/react-native-webrtc` 144.1.2, `livekit-client` 2.22 (client), `livekit-server-sdk` 2.18 (server-side token minting).
- **Maps**: `@maplibre/maplibre-react-native` 11.3.10 + MapTiler hosted style/tiles (replaced `react-native-maps` + Google Maps, which is no longer a dependency).
- **Location**: `@react-native-community/geolocation` 3.4.0 (TurboModule).
- **Auth/session**: `jsonwebtoken`, `bcryptjs`, `@react-native-async-storage/async-storage` (client-side token/profile persistence).
- **Backend**: Express 4 (server) — note `mobile/package.json` *also* lists `express`, `@prisma/client`, `bcryptjs`, `jsonwebtoken`, `cors`, `dotenv` as mobile dependencies, which is almost certainly leftover/copy-paste noise: React Native cannot run an Express server or Prisma's native engine binaries, and nothing in `mobile/src` imports any of them (verified by grep — zero hits).
- **Database**: Prisma 5.22 ORM over SQLite (`server/prisma/schema.prisma`).
- **Build/test tooling**: TypeScript, ESLint (`@react-native/eslint-config`), Jest 29, Gradle/AGP (Android), CocoaPods scaffold (iOS, untouched/untested).

## Repository Structure

```
Ridezz/
├── README.md              — stale, describes pre-backend/pre-auth/pre-maps MVP
├── PROJECT_STATUS.md       — stale, last updated 2026-08-22, extremely detailed for what it covers
├── package-lock.json       — orphaned: 91-byte empty lockfile with no matching root package.json
├── mobile/                 — the React Native app (see Technology Stack)
│   ├── src/{screens,components,hooks,services,utils,context,config,polyfills,types}
│   ├── android/             — native Android project incl. 3 custom native modules
│   ├── ios/                 — untouched RN template scaffold, never built/tested
│   └── __tests__/           — 5 Jest suites (1 currently broken — see below)
└── server/                 — Express + Prisma backend
    ├── src/index.ts         — the entire backend (auth + rooms), one file
    └── prisma/               — schema + 2 migrations (User, Room)
```

No dedicated `docs/` folder, no CI configuration (no `.github/workflows`), no Docker/deployment config anywhere in the repo.

## What Currently Works

Verified either by direct code inspection, passing automated tests, or prior physical-device verification recorded in `PROJECT_STATUS.md` (still consistent with the current code for the parts that haven't changed):

- **LiveKit WebRTC voice intercom** — `mobile/src/screens/RideScreen.tsx`, full-duplex, mute/unmute, connection-state UI. Untouched since the physically-verified sessions in `PROJECT_STATUS.md`.
- **Android background/lock-screen survival** — `mobile/android/app/src/main/java/com/ridezz/mobile/RidezzIntercomService.kt`, correctly registered in `MainApplication.kt`, manifest declares `foregroundServiceType="microphone|location"`.
- **Rider presence, audio cues, keep-awake, diagnostics log** — `mobile/src/hooks/*`, `mobile/src/services/{audioCues,diagnosticsLog,keepAwake}.ts`, all covered by passing unit tests.
- **Room create/join against a real backend** — `mobile/src/screens/JoinScreen.tsx` → `server/src/index.ts` `/api/rooms/create` and `/api/rooms/join`, which generate a 6-character room code, persist it via Prisma, and mint a real LiveKit `AccessToken`. Logic is sound; it just can't be reached from a phone right now (see P0 below).
- **Signup/Login** — `server/src/index.ts` `/api/auth/signup` and `/api/auth/login`, bcrypt-hashed passwords, JWT minted on login, session persisted client-side via `AuthContext.tsx` + AsyncStorage.
- **MapLibre/MapTiler map rendering** — `mobile/src/components/RiderMap.tsx`. This is a real migration away from the Google Maps integration that `PROJECT_STATUS.md` describes as permanently blocked on Google Cloud Console authorization. Code-wise this looks complete (markers, freshness coloring, Fit Group / Center Me, haversine distance) — it just hasn't been re-verified on a physical device since the migration (no note of this in the repo).
- **TypeScript compiles clean** for `mobile/` (`npx tsc --noEmit` → no output/errors).
- **ESLint passes clean** for `mobile/` (`npx eslint .` → no findings).
- **4 of 5 Jest suites pass**, 60/60 individual tests green: `riderPresence.test.ts`, `riderLocation.test.ts`, `connectionCues.test.ts`, `diagnostics.test.ts`.

## Partially Working Features

- **Map visual verification** — code is complete and TypeScript/lint-clean, but there is no record (test, screenshot, or note) of it having been run on-device since the MapLibre migration. Given the amount of trouble the *previous* Google Maps integration caused (`PROJECT_STATUS.md`'s entire "Google Maps authorization" saga), this needs a real-device check before relying on it in the demo.
- **JWT auth** — tokens are correctly minted and hashed passwords correctly checked server-side, but no route on the server actually verifies a JWT (no auth middleware exists in `server/src/index.ts`), and the mobile client never attaches an `Authorization` header — `JoinScreen.tsx`'s calls to `/api/rooms/create`/`/join` send only a raw `userId` in the JSON body. Functionally the login/signup/room flow still works end-to-end because nothing requires the token, but the auth layer provides no actual protection today.
- **10-rider capacity enforcement** — client-side only (`mobile/src/utils/riderPresence.ts`), explicitly documented as best-effort/racy; the server does not enforce it when minting tokens or creating rooms.

## Broken Features

- **`mobile/__tests__/App.test.tsx`** fails to run under Jest: `Cannot use import statement outside a module`, tracing to `@react-native-async-storage/async-storage`'s ESM build being pulled in transitively through `App.tsx` → `AuthContext.tsx`. `mobile/jest.config.js` has no `transformIgnorePatterns` override for this package. This is a test-infrastructure break, not a runtime app break — the app itself is unaffected.
- **`Dashboard.tsx`'s logged-in room-entry UI is unreachable dead code.** `mobile/App.tsx:42` routes any logged-in user (`user` truthy) straight to `JoinScreen`, never to `Dashboard`'s post-login branch (`mobile/src/screens/Dashboard.tsx:71-108`). That branch's `handleJoinRide` also builds a payload (`{roomName, riderName}`) that doesn't match the `RideSession` shape (`{serverUrl, token, riderName, roomCode}`) that `onJoined`/`RideScreen` expect — if this code path were ever wired up as-is it would misbehave immediately. Currently harmless because it's unreachable, but it's a trap for whoever touches navigation next.
- **The backend cannot start in this checkout** — see P0 #1 below.

## Missing Features

Mapped against the product concepts requested:

| Concept | Status |
|---|---|
| Onboarding/login | Implemented (`LoginPage.tsx`, `SignupPage.tsx`) |
| User profile | Minimal — rider name + email only, no profile screen/editing |
| Create ride | Implemented (`JoinScreen.tsx` "create" mode → `/api/rooms/create`) |
| Join ride/group | Implemented (`JoinScreen.tsx` "join" mode → `/api/rooms/join`) |
| Group management | Not implemented (no kick/host controls, no member list beyond in-room presence) |
| Ride lobby (pre-start staging) | Not implemented — joining a room connects directly into the live LiveKit room, no waiting/lobby state |
| Live trip screen | Implemented (`RideScreen.tsx`) |
| Rider locations | Implemented (`useRiderLocations.ts`, LiveKit data channel) |
| Map/navigation | Implemented for map display (`RiderMap.tsx`); no turn-by-turn navigation (never in scope) |
| Route creation/sharing | Not implemented |
| Group communication (voice) | Implemented — this is the core product |
| Voice/intercom/WebRTC | Implemented, mature, physically verified previously |
| Text messaging | Not implemented (zero references in code) |
| Emergency/SOS | Not implemented (zero references in code) |
| Low-network/offline functionality | Not implemented beyond LiveKit's own reconnection resilience |
| Ride history | Not implemented (Room rows persist in DB but nothing reads/lists them) |
| **AI functionality** | **Not implemented — zero AI code anywhere in the repo** |
| Notifications | Only the always-on Android foreground-service notification (not a general push/alert system) |
| Backend APIs | Implemented (`server/src/index.ts`) but currently non-runnable in this checkout (P0) |
| Persistence/database | Implemented (Prisma/SQLite) but the actual `.db` file doesn't exist yet locally (never migrated) |
| Deployment | Not implemented — no Docker, no hosting config, no CI, server has only ever been run locally |

## AI Feature Status

**There is no AI feature in this repository.** A full-repo grep for AI-related terms (`openai`, `anthropic`, `gemini`, `gpt-`, `claude`, `llm`, `chatbot`, `assistant`, `ai\.`) across `mobile/src`, `server/src`, and every `package.json` in the repo returned zero matches. There is no AI SDK dependency, no prompt file, no AI-facing endpoint, no UI element referencing an AI feature. This is a real, current gap — not a broken or mocked implementation. If a judge asks to see the AI feature, there is currently nothing to show.

## End-to-End Journey Results

- **Journey A (open app → create/join ride → lobby → start → trip screen)**: Code path is `App.tsx` → `Dashboard`/`LoginPage`/`SignupPage` → `JoinScreen` → `RideScreen`. There is no separate "lobby" screen — joining connects directly into the live LiveKit room. **Blocked today** by the `localhost` API URL (P0 #2): the axios calls in `LoginPage.tsx`, `SignupPage.tsx`, and `JoinScreen.tsx` will fail on a real device unless the backend is reachable from the phone. Once that's fixed and the backend is actually running (P0 #1), the code path itself looks correct.
- **Journey B (two riders join the same room)**: `server/src/index.ts` `/api/rooms/join` mints a LiveKit token scoped to the same `room.code` for any rider who supplies the correct 6-character code — this should correctly put two callers in the same LiveKit room. Presence UI (`RiderRow.tsx`, `useRiderPresenceToasts.ts`) was physically two-phone-verified per `PROJECT_STATUS.md` prior to the backend rewrite; not re-verified two-phone since, but the underlying LiveKit-side logic is unchanged.
- **Journey C (map/location updates, group visibility)**: Code-complete (`useRiderLocations.ts`, `RiderMap.tsx`) but not visually re-verified on-device since the Google Maps → MapLibre/MapTiler migration (see Partially Working, above).
- **Journey D (group communication/intercom)**: This *is* the voice intercom — same as the core of Journey A/B. Works at the code level; blocked by the same P0s.
- **Journey E (AI feature)**: **No code path exists.** Nothing to trace.

## P0 Critical Issues

**P0-1 — Backend cannot start: `server/node_modules` does not exist.**
- File(s): `server/` (whole directory — confirmed via direct listing, not just `npm ls`)
- Feature affected: everything behind the backend — login, signup, create room, join room
- Observable failure: `npm run dev`/`npm run build` would fail immediately (module resolution); confirmed indirectly — `npx tsc` inside `server/` resolved to an unrelated npm package named `tsc` instead of the local TypeScript install, because there is no local `node_modules/typescript`
- Likely root cause: `npm install` was never run in `server/` in this checkout (or `node_modules` was deleted and not regenerated); `server/.env` is present and looks correctly filled in, so this is purely a missing-install issue, not a config issue
- Scope of repair: **SMALL** — `npm install` in `server/`, then `npx prisma migrate deploy` (or `migrate dev`) to actually create the SQLite file, since no `.db` file exists on disk yet either

**P0-2 — Mobile app's backend URL is `localhost`, unreachable from a real device.**
- File(s): `mobile/.env` (`API_URL`), consumed in `mobile/src/screens/JoinScreen.tsx:126,131`, `mobile/src/screens/LoginPage.tsx:36`, `mobile/src/screens/SignupPage.tsx:47`
- Feature affected: onboarding/login, signup, create ride, join ride — i.e. everything except the now-dead direct-LiveKit dev-token path
- Observable failure: on a physical Android phone (this project's only tested target per `PROJECT_STATUS.md`) or a standard emulator, `http://localhost:<port>/api` refers to the device itself, not the machine running `server/`; every auth/room request will time out or connection-refuse
- Likely root cause: `.env` value was set for same-machine development (e.g. a browser-based test) and never updated for on-device testing; on-device testing needs either the dev machine's LAN IP (same Wi-Fi), `adb reverse tcp:<port> tcp:<port>` (USB-tethered only), or a public tunnel/deployment
- Scope of repair: **SMALL** for a demo (swap `API_URL` to a reachable LAN IP or a quick tunnel such as ngrok before the event; requires re-testing once changed)

**P0-3 — No AI feature exists anywhere in the codebase.**
- File(s): N/A — absence confirmed repo-wide
- Feature affected: any AI-judged criterion of the hackathon
- Observable failure: there is nothing to demo
- Likely root cause: never started
- Scope of repair: **LARGE** relative to 2 days if a real, integrated AI feature is expected from scratch — see Two-Day Feasibility for a scoped-down suggestion

## P1 Major Issues

**P1-1 — `Dashboard.tsx` authenticated branch is dead/inconsistent code.**
- File(s): `mobile/App.tsx:42`, `mobile/src/screens/Dashboard.tsx:71-108`
- Feature affected: none currently (unreachable), but a real trap if anyone "fixes" navigation without checking this
- Scope: SMALL to either delete the dead branch or fix its payload shape and actually route to it

**P1-2 — `App.test.tsx` Jest suite fails to run.**
- File(s): `mobile/__tests__/App.test.tsx`, `mobile/jest.config.js`
- Feature affected: test coverage / CI confidence for the top-level `App` component, not the running app
- Scope: SMALL — add a `transformIgnorePatterns` override for `@react-native-async-storage/async-storage` (a very common RN/Jest fix)

**P1-3 — Backend has no automated tests and JWT auth is unenforced.**
- File(s): `server/src/index.ts` (no auth middleware anywhere), `server/` (no test files exist at all)
- Feature affected: security posture, not demo functionality
- Scope: not worth fixing before the hackathon (see "Do Not Touch")

## P2/P3 Issues

- **P2 — Branding inconsistency.** The Android launcher name/app label and the foreground-service notification say **"Rideaze"** (`mobile/app.json:3`, `mobile/android/app/src/main/res/values/strings.xml:2`, `mobile/android/app/src/main/java/com/ridezz/mobile/RidezzIntercomService.kt`), while every in-app screen — Dashboard, Login, Signup, JoinScreen, RideScreen — hardcodes **"RIDEZZ"/"Ridezz"** in its UI text. A commit titled "Rename Ridezz to Rideaze" (`bd329e8`) only partially propagated. A judge will see both names within seconds of opening the app.
- **P2 — Hardcoded secret fallbacks in server source.** `server/src/index.ts:14,16,17` fall back to literal strings (`'ridezz_super_secret_jwt_key_2026'`, `'devkey'`, `'secret'`) if the corresponding env vars are unset. `.env` is present and filled in, so these fallbacks aren't currently active, but they're a code smell worth knowing about if the environment changes on demo hardware.
- **P2 — `mobile/package.json` lists backend-only packages** (`express`, `@prisma/client`, `bcryptjs`, `jsonwebtoken`, `cors`, `dotenv`) as mobile dependencies with zero corresponding imports in `mobile/src`. Harmless (adds install time/weight only) but confusing.
- **P3 — Orphaned root `package-lock.json`** (91 bytes, empty `packages: {}`, no root `package.json` to match it) and an orphaned `.gitignore` entry for `backend/node_modules/` (there is no `backend/` folder — it's `server/`). Cosmetic repo-hygiene noise.
- **P3 — `mobile/README.md` is the unmodified React Native CLI template README** — no project-specific instructions.

## Demo-Ready Features

| Feature | Current status | Demo safe? | Dependency/risk |
|---|---|---|---|
| Voice intercom (LiveKit WebRTC) | Working, previously physically verified | Yes, once P0-1/P0-2 fixed | Needs backend reachable + LiveKit Cloud credentials valid |
| Signup/Login | Working end-to-end | Yes, once P0-1/P0-2 fixed | Same as above |
| Create/Join room via code | Working end-to-end | Yes, once P0-1/P0-2 fixed | Same as above |
| Rider presence (join/leave/speaking/muted) | Working, unit-tested, previously two-phone-verified | Yes, with a second device | Needs 2 phones for the full effect |
| Foreground service (lock-screen survival) | Working, previously physically verified | Yes | Android-only |
| Audio cues, keep-awake, diagnostics log | Working, unit-tested | Yes | Low risk, nice-to-show polish |
| Map (MapLibre/MapTiler) | Code-complete, not re-verified on-device post-migration | Risky until re-verified | 5-minute on-device smoke test needed |
| AI feature | Does not exist | No | N/A |
| Text messaging / SOS / ride history / group management | Not implemented | No | N/A |

## Current Best Demo Flow

The smallest currently-working end-to-end flow, **once P0-1 (`npm install` + migrate) and P0-2 (fix `API_URL`) are addressed**:

1. Sign up a rider (`SignupPage.tsx` → `/api/auth/signup`)
2. Log in (`LoginPage.tsx` → `/api/auth/login`)
3. Create a room from one phone (`JoinScreen.tsx`, "Create Room" tab)
4. Join the same 6-character code from a second phone
5. Talk over the live intercom, observe presence rows, mute/unmute, switch to the Map tab

This exercises real auth, a real database, a real backend, and the mature, previously-verified LiveKit voice path — it is the strongest thing this repo can show right now.

## Two-Day Risk Assessment

The engineering risk is low for the parts that already work (voice intercom is the hardest problem in this app and it's done). The schedule risk is concentrated in two places: (1) getting the backend reachable from real demo hardware, which is a same-day fix but must be tested on the actual demo network before the event, not assumed; (2) the total absence of an AI feature, which is either a scope decision (accept the gap) or a real 1-day build if the team wants something to show.

## Recommended Hackathon Scope

**MUST HAVE FOR DEMO**
- Run `npm install` in `server/`, run a Prisma migration to create the SQLite file, confirm `npm run dev` actually starts (P0-1).
- Point `mobile/.env`'s `API_URL` at something reachable from the demo phones on the actual venue network (LAN IP, tunnel, or a small cloud deploy) and re-test the full login→create→join flow on real hardware (P0-2).
- Re-verify the MapLibre/MapTiler map on a real device for 5 minutes — it's the one recently-changed piece with zero on-device confirmation.
- Decide, as a team, whether an AI feature is expected by the judging criteria. If yes, scope it small (see below) rather than skipping it silently.

**SHOULD HAVE**
- Fix `mobile/jest.config.js`'s `transformIgnorePatterns` so `App.test.tsx` runs again (quick, and it's the kind of thing a judge glancing at CI/tests would notice).
- Either delete or fix `Dashboard.tsx`'s unreachable/broken authenticated branch so nobody trips on it mid-hackathon.
- Pick one name — "Ridezz" or "Rideaze" — and make it consistent across `app.json`, `strings.xml`, the notification, and all in-app screen text.

**ONLY IF TIME REMAINS**
- A minimal AI feature that's honest about its scope and reliable on stage — e.g., a small LiveKit data-channel or REST-triggered assistant that does one clearly-demoable thing (a post-ride summary, a voice-to-text safety tip, a route/ETA suggestion) rather than an ambitious multi-feature AI layer. Given 2 days and everything else on this list, keep it to a single call to a hosted LLM API with a tight, demo-scripted prompt — not a new subsystem.
- Ride history screen (the `Room` rows already exist in the DB; listing them is a small, additive UI task).
- Basic JWT verification middleware on the room routes, if there's spare time and the team wants to show real auth enforcement.

**DO NOT TOUCH BEFORE HACKATHON**
- The LiveKit/WebRTC audio pipeline, the Android foreground service, and the native Kotlin modules (`RidezzIntercomService.kt`, `RidezzAudioCuesModule.kt`, `RidezzKeepAwakeModule.kt`) — this is the most mature, most physically-verified part of the app. There is no reason to touch it and real risk in doing so with two days on the clock.
- Do not attempt to rebuild or replace the map integration again — it was already migrated once (Google Maps → MapLibre) to escape an unresolvable external blocker; the new stack looks sound, just verify it, don't redesign it.
- Do not restructure the backend into multiple files/services or add new architecture (queues, microservices, etc.) — `server/src/index.ts` is a single file doing exactly what's needed; keep it that way through the event.

## Areas We Should NOT Touch

- `mobile/src/polyfills/` (Hermes `DOMException`/`TextEncoder` fixes) — hard-won, documented fixes for real Hermes startup crashes. Do not remove or "clean up."
- `mobile/android/app/src/main/java/com/ridezz/mobile/*.kt` — all three custom native modules are working and manifest-registered correctly.
- The LiveKit `publishDefaults`/`audioCaptureDefaults` tuning in `mobile/src/screens/RideScreen.tsx:102-131` — these are deliberate, documented audio-quality choices (Opus bitrate, DTX, AEC/AGC/noise suppression), not defaults to second-guess under time pressure.

## Git / Repository State

- Current branch: `vithesh`, up to date with `origin/vithesh`, working tree clean, nothing uncommitted.
- `vithesh` is the most current branch (HEAD `cda6443`, "Migrate maps to MapLibre and MapTiler"); `master` and `Mahesh` are both one commit behind at `c8fd76e`; `jaswant` is further behind. No divergent/abandoned duplicate feature branches were found — the branch structure looks like normal, already-merged feature work, not confusion to clean up.
- No baseline "known-good" tag exists, but the current HEAD itself is a reasonable safe baseline: TypeScript and ESLint are clean, 60/60 non-broken unit tests pass, and the working tree has no local modifications.
- No secrets appear to be committed: `.env` files are correctly gitignored at both root and per-package level (`.gitignore:5-7`, `server/.gitignore:1-2`, plus a root-level catch-all `**/.env`), and only `.env.example` files (placeholder values) are tracked. The one intentionally-tracked "secret-looking" file, `mobile/android/app/debug.keystore`, is the standard public Android debug-signing key (fixed alias/password) per `PROJECT_STATUS.md` — not a real secret.
- No generated/build files appear committed (`node_modules/`, `dist/`, `*.apk`, Android `build/`/`.gradle/`/`.cxx/` are all gitignored and were not found tracked).
- Repo-hygiene noise found (not urgent, listed under P3 above): an orphaned root `package-lock.json` with no matching root `package.json`, and a stale `.gitignore` entry (`backend/node_modules/`) referencing a folder name (`backend/`) that doesn't exist — the folder is `server/`.

## Exact Next Actions

1. `cd server && npm install`
2. `cd server && npx prisma migrate deploy` (creates the SQLite DB file the schema/migrations already define)
3. `cd server && npm run dev` and confirm it actually listens (watch for the `🚀 Ridezz Server running on http://localhost:<PORT>` log)
4. Update `mobile/.env`'s `API_URL` to an address reachable from the demo phones on the venue's actual network, then rebuild/reinstall the app and retest signup → login → create room → join room on two real devices
5. Open the Map tab on a real device and confirm MapLibre tiles actually render (not just "doesn't crash")
6. As a team, make an explicit go/no-go call on building a small AI feature, scoped to fit the "ONLY IF TIME REMAINS" budget above

---

## CURRENT DEMO READINESS: MEDIUM

- The hardest engineering problem in this app — reliable two-way WebRTC voice intercom that survives a locked screen on real hardware — is done and was already physically verified before the backend rewrite, which is a strong foundation most hackathon teams don't have two days out.
- But right now, today, in this exact checkout, the app cannot complete a login or create a room on a real phone: the backend has no `node_modules` (P0-1) and the client points at `localhost` (P0-2) — both are small, well-understood fixes, not open engineering problems, which is why this isn't rated LOW.
- It isn't rated HIGH because there is a total, unambiguous absence of any AI feature, the map stack changed very recently with zero on-device confirmation since, and every piece of repo documentation (`README.md`, `PROJECT_STATUS.md`, `server/README.md`) describes an architecture that predates roughly half of what's actually in the code today — so nothing here should be taken on faith without the on-device recheck listed in Exact Next Actions.
- Automated verification that *is* current and trustworthy: `npx tsc --noEmit` clean, `npx eslint .` clean, 60/60 non-broken Jest tests passing in `mobile/`.
