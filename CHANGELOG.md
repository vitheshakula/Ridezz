# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- Versioned API under `/api/v1`; `/api` stays as an alias for existing app builds.
- Every error response carries a stable `code` next to `message`.
- OpenAPI 3.1 document at `/api/v1/openapi.json`, with a contract test against the mounted routes.
- Per-account limit on password sign-in attempts (`AUTH_ACCOUNT_RATE_LIMIT_MAX`).
- `APP_ENV`; browser origins are refused in staging and production unless listed in
  `CORS_ORIGINS`.
- Timeout and bounded retries with backoff and jitter for Google sign-in, returning
  `503 SERVICE_UNAVAILABLE` when Google is unreachable.
- Business event logs (sign-up, sign-in, rooms hosted and joined, destination changes).
- Index on `Room.hostId`.
- Render Blueprint (`render.yaml`) for staging and production, database and backend architecture
  docs, and a backend checklist compliance report.
- Android `dev`, `staging` and `prod` flavors, each with its own application id, app name and
  env file.
- Server health checks: `GET /health` and `GET /health/ready`.
- Leveled JSON logging with timestamps on the server, and a leveled logger in the app that drops
  debug output in release builds.
- Graceful server shutdown on `SIGTERM`/`SIGINT`.
- Startup validation of `LOG_LEVEL` and `SHUTDOWN_TIMEOUT_MS` on the server, and of `API_URL` and
  `ROUTING_URL` (HTTPS required) in staging and prod app builds.
- `ROUTING_URL` setting for the road-routing service.
- CI for both packages, the Android build, CodeQL, secret scanning, dependency review and
  Dependabot.
- API reference, architecture overview, deployment guide, contributing guide and security policy.

### Changed

- The app reads configuration through `react-native-config` instead of `react-native-dotenv`.
- Prettier `printWidth` is 100 and applies to both packages; ESLint now also covers the server.
- Server integration tests moved to `server/test/integration`.
- `prisma db push` was replaced by migration scripts.

### Removed

- Source code comments, the unused `dotenv` dependency in the app, and the archived SQLite
  migrations (still available in git history).

### Fixed

- The server integration suite tripped its own auth rate limit and failed 19 tests.
- npm audit fixes in both packages; the server has no known production vulnerabilities.
