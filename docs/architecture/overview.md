# Architecture overview

## Components

| Component        | Technology                                 | Responsibility                                                     |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Mobile app       | React Native 0.87, TypeScript, Kotlin       | UI, voice, location sharing, hazard/braking/crash detection, offline mesh |
| Server           | Node.js, Express, Prisma                   | Accounts, sign-in, ride rooms, LiveKit token issuance              |
| Database         | PostgreSQL 16                              | Users and rooms                                                    |
| LiveKit Cloud    | WebRTC SFU                                 | Voice and online data channels (location, hazards)                 |
| Nearby Connections | Google Play Services                     | Phone-to-phone delivery of alerts when there is no data connection |
| MapTiler, OSRM   | Hosted APIs                                | Map tiles, geocoding and road routes                               |

## Server layering

```
routes/      HTTP only: parse and validate input, map results to status codes
services/    Use cases (register, sign in, create or join a room) on top of Prisma
auth/        Pure rules: validation, allow list, tokens, room codes
config/      Environment parsing and validation, Passport setup
http.ts      Request IDs, request logging, central error handler
logger.ts    Leveled JSON logging
```

Routes never talk to Prisma directly for business rules; services return tagged results
(`{ kind: 'duplicate' }`, `{ kind: 'conflict' }`) that routes turn into status codes. Dependencies
(Prisma, config, the Google verifier) are passed into `createApp`, which keeps every layer
testable with fakes.

## Mobile structure

The app keeps platform code behind small interfaces so the logic can be unit tested in Jest:

- `src/config/appConfig.ts` is the only reader of build configuration.
- `src/transports` adapts LiveKit and Nearby to one transport interface.
- `src/connectivity` holds the offline mesh protocol, independent of React and of the transports.
  Its design is described milestone by milestone in this folder:
  [client API](ride-connectivity-client-m1.md),
  [delivery acknowledgements](delivery-acknowledgements-m2.md),
  [persistent outbox](persistent-outbox-m3.md),
  [route recovery](route-recovery-m4.md) and
  [hardening](connectivity-hardening-m5.md).
- `src/hazards`, `src/braking` and `src/crash` contain detection and alert policy; the sensor
  pipeline for crash detection runs natively in Kotlin (`android/app/src/main/java/.../crash`).

## Key decisions

| Decision | Reason |
| -------- | ------ |
| LiveKit Cloud instead of a self-hosted SFU | Reliable group voice without operating media servers. |
| The server issues LiveKit tokens (6 h) | The LiveKit API secret never ships in the app. |
| Bare React Native, not Expo Go | Native WebRTC, background audio, foreground services and custom Kotlin modules. |
| Nearby Connections for offline alerts | Riders often lose data in the hills; alerts must still reach the group. Bluetooth is only used for audio accessories. |
| Permanent 5-digit room code per rider | Easy to say over the intercom and reuse every ride. Trade-off: anyone who knows the code can join (see `SECURITY.md`). |
| Gmail-only accounts, optional allow list | Matches Google Sign-In and keeps private testing closed. |
| JWT (HS256, 30 days) without server sessions | Simple stateless auth; the allow list is re-checked on every request so access can still be revoked. |
| PostgreSQL with committed Prisma migrations | Reviewed, repeatable schema changes across environments. |
| One config module per package, validated at startup | Misconfiguration fails fast instead of at the first request. |
| `dev` / `staging` / `prod` Android flavors | Separate backends and application ids, installable side by side. |
