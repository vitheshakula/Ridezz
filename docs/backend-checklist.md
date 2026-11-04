# Backend checklist compliance

Status of `server/` against the CDE backend checklist (153 practices).

- **Met:** in place, with the evidence listed.
- **N/A:** the practice does not apply to this backend today; the reason is given and
  `docs/architecture/backend.md` records the decision.
- **Partial / Gap:** not fully in place; listed again under *Open items*.

## 1. Backend architecture

| # | Status | Evidence |
| - | ------ | -------- |
| 1 | Met | Layered: routes → services → domain rules / Prisma (`docs/architecture/backend.md`) |
| 2 | Met | Middleware, routes, services, domain rules and integrations are separate modules |
| 3 | Met | Controllers in `src/routes`, use cases in `src/services`; Prisma Client is the repository layer (decision 1) |
| 4 | Met | Routes only parse input, call one service and map tagged results to HTTP |
| 5 | Met | Single-purpose modules; dependencies passed in as interfaces (`GoogleVerifier`, `PasswordCrypto`, `GoogleCertsClient`) |
| 6 | Met | Services take Prisma and collaborators as parameters; no module-level singletons except the logger |
| 7 | Met | `createApp({ prisma, env, verifyGoogleIdToken })` injects all dependencies |
| 8 | Met | See *Source layout* in `server/README.md` |
| 9 | Met | No speculative layers, cache, queue or microservices (decisions 1, 7, 8) |
| 10 | Met | `docs/architecture/backend.md` decisions table |

## 2. API design and development

| # | Status | Evidence |
| - | ------ | -------- |
| 11 | Met | Resource-oriented JSON over HTTP; action endpoints (`/rooms/join`) only where a resource verb does not fit |
| 12 | Met | `GET` for reads, `POST` for creation and sign-in, `PATCH` for partial destination updates |
| 13 | Met | 200/201/400/401/403/404/409/429/500/503 as listed per endpoint in `docs/api.md` |
| 14 | Met | Shared response types (`Session`, `UserEnvelope`, `RoomAccess`, `Destination`) |
| 15 | Met | `/api/v1`, with `/api` as a compatibility alias (decision 4) |
| 16 | Met | Every handler type-checks and validates its body and path parameters |
| 17 | Met | `toAuthUser` and explicit response builders; no Prisma row is returned |
| 18 | N/A | No collection endpoints exist. Any future list endpoint must add `limit`/`cursor` |
| 19 | Met | `{ message, code }` everywhere via `sendError` (`src/errors.ts`) |
| 20 | Met | OpenAPI 3.1 in `src/openapi.ts`, served at `/api/v1/openapi.json`, checked by `src/openapi.test.ts` |
| 21 | Met | Generic 4xx/5xx messages; internal errors and stack traces are only logged |
| 22 | Met | Additive-only policy within a version (`docs/api.md`, *Versioning and compatibility*) |

## 3. Input validation and error handling

| # | Status | Evidence |
| - | ------ | -------- |
| 23 | Met | Validation in routes and `src/auth/validation.ts`, `src/rooms/destination.ts` |
| 24 | Met | `errorHandler` in `src/http.ts`, `asyncHandler` for async routes |
| 25 | Met | 500 responses are generic; tested in `src/http.test.ts` |
| 26 | Met | Human-readable `message` plus stable `code` |
| 27 | Met | `req.body ?? {}` and `typeof` checks on every field; tests send missing and wrong-typed fields |
| 28 | Met | Lengths (names, passwords in bytes), formats (Gmail, room code), coordinate ranges |
| 29 | Met | Google outages return `503 SERVICE_UNAVAILABLE`; database outages fail readiness |
| 30 | Met | `withRetry` for transient Google failures (`src/integrations/retry.ts`) |
| 31 | Met | 5 s timeout on Google requests |
| 32 | Met | Every `catch` logs, maps to a specific result, or rethrows |

## 4. Database management

| # | Status | Evidence |
| - | ------ | -------- |
| 33 | Met | Prisma calls live in services only (plus the health check service) |
| 34 | Met | Prisma Client; the one raw query is a tagged-template `SELECT 1` |
| 35 | Met | No string-built SQL anywhere |
| 36 | Met | `prisma/migrations`, `npm run prisma:migrate:*`; `db push` removed |
| 37 | Met | Unique indexes on lookup keys, index on `Room.hostId` (`docs/database.md`) |
| 38 | Met | One lookup per need; profile/room-code assignment only when missing |
| 39 | Met | No list or nested queries, so no N+1 paths |
| 40 | Met | Atomic single statements (`upsert`, conditional `updateMany`) with unique-constraint retries; no multi-statement writes need a transaction today |
| 41 | Met | Prisma connection pool, sized with `connection_limit` |
| 42 | Met | Auth middleware selects five columns; responses are mapped DTOs |
| 43 | Met | Unique constraints, foreign key with `ON DELETE RESTRICT` |
| 44 | Met | `docs/database.md`, *Backup and recovery* (provider PITR, pre-migration snapshot, quarterly restore test) |

## 5. Authentication and authorization

| # | Status | Evidence |
| - | ------ | -------- |
| 45 | Met | Password and Google sign-in; unknown emails are compared against a dummy hash so timing does not reveal which accounts exist |
| 46 | Met | JWT HS256 with algorithm pinned; Google ID tokens verified against the client id |
| 47 | Met | Ownership-based authorization (host-only destination changes); no roles needed (decision 6) |
| 48 | Met | `requireAuth` on every user and room route; allow list re-checked per request |
| 49 | Met | Host status computed on the server from the token's user, ignoring body fields (tested) |
| 50 | Met | bcrypt, cost 10 |
| 51 | Partial | 30-day expiry, no refresh tokens (decision 5) |
| 52 | Met | Per-account limit on password sign-in, per-IP limits on all sign-in routes |
| 53 | Met | Rate limits on sign-in, sign-up, Google sign-in and room joins |
| 54 | Partial | LiveKit tokens grant one room for 6 hours; the server and its migrations share one database role |

## 6. Security best practices

| # | Status | Evidence |
| - | ------ | -------- |
| 55 | Met | No secrets in code; CI secret scan (gitleaks) |
| 56 | Met | Environment variables, Render secret store (`sync: false`) |
| 57 | Met | See 23 and 28; names and destination labels are trimmed and length-capped |
| 58 | Met | ORM only, no shell execution, no `eval` |
| 59 | Met | `CORS_ORIGINS` allow list; closed by default in staging/production (decision 10) |
| 60 | Met | TLS at the platform edge; `sslmode=require` for the database; the app refuses non-HTTPS URLs |
| 61 | N/A | The server fetches no user-supplied URLs |
| 62 | Met | No headers, bodies, query strings, tokens or credentials in logs; redaction in `safeErrorDetails` |
| 63 | Met | Dependabot weekly |
| 64 | Met | `npm audit` in CI, CodeQL, dependency review |
| 65 | Met | helmet |
| 66 | Met | TLS in transit; provider-managed encryption at rest; passwords hashed |
| 67 | Met | Only `express.json` parsing of plain JSON |
| 68 | Met | 32 KB JSON body limit |

## 7. Logging and monitoring

| # | Status | Evidence |
| - | ------ | -------- |
| 69 | Met | JSON lines (`src/logger.ts`) |
| 70 | Met | `debug`, `info`, `warn`, `error`, `fatal` (= critical), set with `LOG_LEVEL` |
| 71 | Met | ISO-8601 `timestamp` on every line |
| 72 | Met | `x-request-id` accepted or generated, echoed, and logged with each request |
| 73 | Met | Registration, sign-in (success and failure), room hosted/joined, destination changed |
| 74 | Met | Only user ids and room codes are logged, never emails, passwords or tokens |
| 75 | Gap | No error-tracking service (Sentry or similar) |
| 76 | Met | `durationMs` per request; platform response-time metrics |
| 77 | Met | Render service and database metrics (`docs/deployment.md`) |
| 78 | Met | `/health` and `/health/ready` |
| 79 | Partial | Platform alerts documented; log-based alerting needs a log provider |

## 8. Performance and scalability

| # | Status | Evidence |
| - | ------ | -------- |
| 80 | Met | Async I/O throughout; bcrypt uses its async API |
| 81 | Met | The only sync crypto (`hashSync` for the dummy hash) runs once at startup |
| 82 | N/A | Every request is a few indexed single-row reads; nothing worth caching (decision 7) |
| 83 | N/A | As 82; Redis would be added first for shared rate-limit counters (decision 9) |
| 84 | Met | Indexed single-row queries only |
| 85 | N/A | No collection endpoints |
| 86 | N/A | No long-running work |
| 87 | N/A | No asynchronous workflows |
| 88 | Met | Prisma pool (`docs/database.md`) |
| 89 | Met | No unbounded in-memory state; timers are `unref`ed |
| 90 | Met | `SIGTERM`/`SIGINT` handling with timeout (`src/index.ts`) |
| 91 | Met | Stateless JWT auth, no sessions |
| 92 | Partial | Can run multiple instances, but rate-limit counters are per instance (decision 9) |

## 9. External service and integration management

| # | Status | Evidence |
| - | ------ | -------- |
| 93 | Met | Google in `src/auth/google.ts`, LiveKit in `src/services/livekitService.ts` |
| 94 | Met | 5 s Google timeout |
| 95 | Met | Exponential backoff with full jitter |
| 96 | Met | 3 attempts maximum; permanent errors not retried |
| 97 | N/A | Decision 8 |
| 98 | Met | Google payload checked for `sub` and `email`; verification checks signature and audience |
| 99 | Met | `503 SERVICE_UNAVAILABLE` instead of a misleading sign-in failure |
| 100 | Met | Readiness reflects database availability; Google failures degrade only Google sign-in |
| 101 | Met | Credentials only in environment variables |
| 102 | Met | Hosting a room is an upsert; Google sign-up is find-or-create; joins are reads |

## 10. Testing

| # | Status | Evidence |
| - | ------ | -------- |
| 103 | Met | `src/**/*.test.ts` |
| 104 | Met | `test/integration` against a real PostgreSQL database |
| 105 | Met | Every endpoint is exercised over HTTP |
| 106 | Met | Tokens (expired, forged, `alg: none`, wrong secret), allow list, host-only updates |
| 107 | Met | Missing, wrong-typed, oversized and malformed inputs |
| 108 | Met | Google unreachable, database unavailable, unexpected exceptions |
| 109 | Met | OpenAPI contract test against the mounted routes and error codes |
| 110 | Met | 85% line/branch/function floor for unit tests, enforced in CI |
| 111 | Met | `.github/workflows/ci.yml` |
| 112 | Met | Tests use fakes or a dedicated `ridezz_test*` database that the suite verifies before use |

## 11. Configuration and environment management

| # | Status | Evidence |
| - | ------ | -------- |
| 113 | Met | `APP_ENV` (development, test, staging, production) with separate Render services and databases |
| 114 | Met | `.env` gitignored; secret scan in CI |
| 115 | Met | `loadEnv` validates every value; the process exits on invalid config |
| 116 | Met | Single typed `Env` object from `src/config/env.ts` |
| 117 | Met | Business code receives values through `Env`, never reads `process.env` |
| 118 | Met | `server/.env.example`, documented in `server/README.md` |
| 119 | Met | Staging and production defined together in `render.yaml` |

## 12. Dependency and package management

| # | Status | Evidence |
| - | ------ | -------- |
| 120 | Met | Runtime dependencies are all imported; tooling in `devDependencies` |
| 121 | Met | `package-lock.json`, `npm ci` everywhere |
| 122 | Met | Stable, maintained releases only; pending major upgrades are tracked under 127 |
| 123 | Met | Dependabot |
| 124 | Met | `npm audit`, dependency review |
| 125 | Met | `depcheck` reports no unused packages |
| 126 | Met | Small dependency set; no utility libraries for things the platform provides |
| 127 | Partial | Dependabot and `npm outdated` surface deprecations; Express 5 and Prisma 6 upgrades are not done yet |

## 13. Background jobs and asynchronous processing

| # | Status | Evidence |
| - | ------ | -------- |
| 128-135 | N/A | The backend has no background jobs or queues (decision 7). When one is added it must be idempotent, track status, retry with backoff, dead-letter failures and be observable. |

## 14. Documentation and maintainability

| # | Status | Evidence |
| - | ------ | -------- |
| 136 | Met | `server/README.md` |
| 137 | Met | `docs/api.md`, OpenAPI document |
| 138 | Met | `docs/database.md` with an ER diagram |
| 139 | Met | Configuration table in `server/README.md` |
| 140 | Met | `docs/deployment.md` |
| 141 | Met | Diagrams in `docs/architecture/backend.md`, `README.md` and `docs/database.md` |
| 142 | Met | *External integrations* in `docs/architecture/backend.md` |
| 143 | Met | PR template checklist; OpenAPI drift fails CI |

## 15. CI/CD and deployment

| # | Status | Evidence |
| - | ------ | -------- |
| 144 | Met | CI builds the server |
| 145 | Met | ESLint, TypeScript, Prettier, CodeQL |
| 146 | Met | Unit and integration tests on every pull request |
| 147 | Met | `npm audit`, dependency review, gitleaks |
| 148 | Met | `render.yaml`: staging deploys after checks pass |
| 149 | Met | Separate staging and production services and databases |
| 150 | Met | `prisma migrate deploy` as the pre-deploy step |
| 151 | Met | `healthCheckPath: /health/ready` |
| 152 | Met | Render rollback; additive-migration rule (`docs/deployment.md`) |
| 153 | Partial | Production deploys manually after staging; enforcing that `master` only changes through reviewed PRs needs branch protection in GitHub settings |

## Open items

| # | Item | Suggested next step |
| - | ---- | ------------------- |
| 51 | No refresh tokens | Short-lived access tokens plus rotating refresh tokens before public launch |
| 75 | No error tracking | Add Sentry (server and app) behind an optional `SENTRY_DSN` |
| 79 | Log-based alerts | Forward Render logs to a log provider and alert on `error`/`fatal` |
| 92 | Per-instance rate limits | Redis store for `express-rate-limit` when running more than one instance |
| 127 | Major upgrades | Plan Express 5 and Prisma 6 upgrades |
| 54 | Shared database role | Give the running server a role limited to reading and writing data, and run migrations with a separate owner role |
| 153 | Branch protection | Protect `master`: require PRs, one approval and passing CI and Security checks |
