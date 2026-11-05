# Ridezz server

Node + Express + Prisma (PostgreSQL). Handles rider accounts and sign-in, creates ride rooms, and
issues the short-lived LiveKit tokens the mobile app joins them with, so the LiveKit API secret
never lives on a phone.

The Prisma migration history targets PostgreSQL. Schema changes always go through a reviewed
migration (`npm run prisma:migrate:dev`), never `prisma db push`.

```sh
npm ci
cp .env.example .env      # then replace DATABASE_URL with a PostgreSQL URL and fill in the rest
npm run prisma:migrate:deploy
npm run dev               # tsx watch
npm run build && npm start
```

## Scripts

| Script                          | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `npm run dev`                   | Start with reload on change                                    |
| `npm run build` / `npm start`   | Compile to `dist/` and run it                                  |
| `npm run lint`                  | ESLint                                                         |
| `npm run typecheck`             | TypeScript, including tests                                    |
| `npm run format` / `format:check` | Prettier                                                     |
| `npm run test:unit`             | Unit tests in `src/**/*.test.ts` (no database needed)          |
| `npm run test:coverage`         | Unit tests with an 85% line/branch/function threshold          |
| `npm run test:integration`      | HTTP + PostgreSQL tests in `test/integration` (see below)      |
| `npm test`                      | Unit, then integration tests                                   |
| `npm run prisma:migrate:dev`    | Create a migration from a schema change (development only)     |
| `npm run prisma:migrate:deploy` | Apply committed migrations (deployments, CI)                   |

## Configuration

All settings come from environment variables (`.env` locally, the platform's secret store when
deployed), are read only in `src/config/env.ts`, and are validated at startup.

| Variable                      | Required | Default       | Purpose                                                        |
| ----------------------------- | -------- | ------------- | -------------------------------------------------------------- |
| `APP_ENV`                     | No       | `development` | `development`, `test`, `staging` or `production`               |
| `JWT_SECRET`                  | Yes      |               | Signs login tokens; at least 32 characters                     |
| `DATABASE_URL`                | Yes      |               | PostgreSQL URL the server runs with; add `sslmode=require` and `connection_limit` |
| `MIGRATION_DATABASE_URL`      | No       | `DATABASE_URL` | Owner role used only by `npm run prisma:migrate:deploy` (see `docs/database.md`) |
| `LIVEKIT_API_KEY`             | Yes      |               | LiveKit project key                                            |
| `LIVEKIT_API_SECRET`          | Yes      |               | LiveKit project secret                                         |
| `LIVEKIT_URL`                 | Yes      |               | LiveKit WebSocket URL (`ws://` or `wss://`)                    |
| `PORT`                        | No       | `5000`        | HTTP port                                                      |
| `LOG_LEVEL`                   | No       | `info`        | `debug`, `info`, `warn`, `error` or `fatal`                    |
| `SHUTDOWN_TIMEOUT_MS`         | No       | `10000`       | Forced exit after this long during shutdown                    |
| `CORS_ORIGINS`                | No       |               | Comma-separated browser origins. Unset: any origin in development/test, none in staging/production |
| `AUTH_RATE_LIMIT_WINDOW_MS`   | No       | `900000`      | Window for both rate limits                                    |
| `AUTH_RATE_LIMIT_MAX`         | No       | `100`         | Sign-in/sign-up and room-join requests per IP per window       |
| `AUTH_ACCOUNT_RATE_LIMIT_MAX` | No       | `10`          | Password sign-in attempts per email per window                 |
| `ROOM_JOIN_RIDER_RATE_LIMIT_MAX` | No    | `30`          | Room joins per signed-in rider per window                      |
| `REDIS_URL`                   | No       |               | `redis://` or `rediss://`; shares rate-limit counters across instances. Unset: in-memory per instance |
| `ACCESS_TOKEN_TTL_SECONDS`    | No       | `900`         | Access token lifetime under `/api/v1`                          |
| `REFRESH_TOKEN_TTL_DAYS`      | No       | `30`          | Refresh token lifetime                                         |
| `SENTRY_DSN`                  | No       |               | Enables error tracking in Sentry                               |
| `SENTRY_RELEASE`              | No       | `RENDER_GIT_COMMIT` | Release name attached to Sentry events                   |
| `ALLOWED_EMAILS`              | No       |               | Allow list; unset means any Gmail account                      |
| `GOOGLE_CLIENT_ID`            | No       |               | Enables Google sign-in                                         |

## Source layout

| Path                 | Responsibility                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `src/routes`         | Controllers: parse input, call a service, map the result to HTTP     |
| `src/services`       | Business use cases on top of Prisma                                  |
| `src/auth`, `src/rooms` | Pure domain rules: validation, tokens, room codes, destinations   |
| `src/integrations`   | External services: retry with backoff, Redis rate-limit store, Sentry error tracking |
| `src/rateLimit.ts`   | The one rate-limiter factory every limit is built with               |
| `src/config`         | Environment parsing and Passport setup                               |
| `src/errors.ts`      | Error codes and the `{ message, code }` error body                   |
| `src/http.ts`        | Request IDs, request logging, central error handler                  |
| `src/openapi.ts`     | OpenAPI 3.1 document, served at `/api/v1/openapi.json`               |
| `test/integration`   | HTTP + PostgreSQL tests                                              |

See [`docs/architecture/backend.md`](../docs/architecture/backend.md) for the design and
[`docs/database.md`](../docs/database.md) for the schema.

## Operations

- **Health checks:** `GET /health` (process is up) and `GET /health/ready` (database reachable,
  `503` otherwise; also reports `cache: ok | unavailable` when Redis is configured, without failing
  on it). Point the platform's health check at `/health/ready`.
- **Rate limits** fail open: if Redis is unreachable, requests are served and `redis_error` is
  logged, rather than the API going down with the cache.
- **Error tracking:** with `SENTRY_DSN` set, unexpected errors and fatal events go to Sentry with
  the request id, method, path and user id only. Request bodies, headers, cookies, query strings
  and emails are never sent.
- **Logging:** one JSON object per line on stdout/stderr with `timestamp`, `level`, `event` and,
  for requests, the `requestId`. Set `LOG_LEVEL` to `debug`, `info` (default), `warn`, `error` or
  `fatal`. Headers, query strings, bodies, tokens and database credentials are never logged.
- **Shutdown:** `SIGTERM` and `SIGINT` stop accepting connections, finish in-flight requests and
  disconnect from the database and Redis, flush pending Sentry events, forcing an exit after `SHUTDOWN_TIMEOUT_MS` (default 10 s).
- **Configuration** is validated at startup; the process exits with a `server_config_invalid` log
  line when anything required is missing or malformed.

## PostgreSQL migration history

`prisma/migrations/20261002_postgresql_baseline` is the initial PostgreSQL migration generated
from the current Prisma schema. For a new, empty PostgreSQL database, deploy the committed history:

```sh
npx --no-install prisma migrate deploy
```

Do not execute the baseline SQL against an existing database that already contains these tables.
Before adopting this history for such a database, take a recoverable backup or branch and verify
that its schema is equivalent to the baseline. Only then mark the baseline as already applied:

```sh
npx --no-install prisma migrate resolve --applied 20261002_postgresql_baseline
```

That resolve step is a deployment operation and has not been performed by this repository change.
It must be run separately against the intended database after review.

## Integration-test database

The route integration tests require a dedicated, isolated PostgreSQL database supplied through
`TEST_DATABASE_URL`. They never fall back to the application's `DATABASE_URL`.

The database name must begin with `ridezz_test`, for example:

```sh
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/ridezz_test npm run test:integration
```

Names such as `ridezz_test_local` and `ridezz_test_ci` are also accepted. The test setup verifies
both the URL and PostgreSQL's reported `current_database()` before deleting any application test
rows. Never point `TEST_DATABASE_URL` at a development, shared, or production database.

Tests deploy the committed migrations with `npx --no-install prisma migrate deploy`; they do not
use `db push` or `migrate reset`.

## Authentication

The full request/response reference is in [`docs/api.md`](../docs/api.md), and the machine-readable
OpenAPI document is served at `GET /api/v1/openapi.json`. Access tokens last 15 minutes (30 days on
the legacy `/api` prefix) and are renewed with rotating refresh tokens; see *Sessions* there.

- **Passwords** are stored only as bcrypt hashes (cost 10).
- **Email + password accounts are unverified** (`emailVerified: false`): a Gmail-shaped address
  proves nothing about who typed it. Only Google sign-in verifies ownership. Sending a
  verification code needs an outgoing-mail provider, which isn't set up.
- **Signing in with Google as an address that already has a password account** links them and
  **deletes the password**, since whoever created that account never proved they own the mailbox.

## Room codes

Every rider has one permanent 5-digit `roomCode` (`10000` to `99999`), unique across accounts and
never changed.

- **Issued** at sign-up (password or Google). Accounts from before this existed get theirs the next
  time they sign in, call `GET /api/user/profile` or `/api/auth/me`, or host a ride.
- **It is the room's code.** `POST /api/rooms/create` no longer generates anything random: the room
  is the host's own code, so a rider hosts the same room every time and hosting again reuses it
  (with the new destination, or none) instead of creating another. Others join with
  `POST /api/rooms/join { roomCode }`. A rider's code opens nothing until they have hosted once
  (`404` before that).
- **Collisions**: each candidate is checked against the database first, and the unique index on
  `User.roomCode` catches a race between two sign-ups, which simply draw again.

Because the code is short and permanent, anyone signed in who learns it can join that rider's
voice channel at any time. Joins share the per-IP auth rate limit, which slows guessing the 90,000
codes but does not stop a distributed attempt; letting a host approve joiners would close that.

## Restricting who can use it

Set `ALLOWED_EMAILS` in `server/.env` (comma/space/newline separated) and only those addresses can
register or sign in -- password and Google alike. Tokens already issued to anyone else stop working
at once. Unset, any Gmail account is welcome.

Google Cloud's *Test users* list does not do this job. Google enforces it (not always for plain
sign-in), and the server never sees it -- so an account you left off that list can still get a valid
Google token and be accepted here.

## Google Cloud setup (once)

You need two OAuth clients **in the same project**:

1. **OAuth consent screen** -- APIs & Services > OAuth consent screen. User type *External*. While
   the app is in *Testing*, add every Google account that will sign in under *Test users*.
2. **Web application** client -- Credentials > Create credentials > OAuth client ID > *Web
   application*. Its **Client ID** is `GOOGLE_CLIENT_ID` in `server/.env`. (The server checks that
   each Google token was issued for this ID.)
3. **Android** client -- same place, type *Android*, **one per app environment** (each flavor has
   its own application id, see `mobile/README.md`):
   - Package name: `com.rideaze.mobile` (prod), `com.rideaze.mobile.staging` (staging),
     `com.rideaze.mobile.dev` (dev)
   - SHA-1 certificate fingerprint of the key the app is signed with. For the checked-in debug
     keystore: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
     (`keytool -list -v -keystore mobile/android/app/debug.keystore -alias androiddebugkey -storepass android`).
   - A release build signed with a different key needs its own SHA-1 added.

   This client has no secret and nothing to copy; it only authorizes the app. If it is missing or
   its SHA-1 is wrong, Google Sign-In fails on the phone with `DEVELOPER_ERROR`.
