# Deployment and operations

## Environments

| Environment | App flavor | Server                     | Database                    |
| ----------- | ---------- | -------------------------- | --------------------------- |
| dev         | `dev`      | A developer's machine      | Local PostgreSQL            |
| staging     | `staging`  | Shared hosted test server  | Its own PostgreSQL database |
| prod        | `prod`     | Production server          | Production PostgreSQL       |

Each environment has its own `JWT_SECRET`, LiveKit project or keys, Google OAuth clients and
database. Never share secrets or data between environments.

## Server pipeline

`render.yaml` defines the hosted environments as a Render Blueprint:

| Service              | Database            | Deploys                                              |
| -------------------- | ------------------- | ---------------------------------------------------- |
| `ridezz-api-staging` | `ridezz-db-staging` | Automatically from `master` once all CI checks pass  |
| `ridezz-api`         | `ridezz-db`         | Manually, after the same commit has been checked on staging |

Each environment also has a Key Value (Redis) instance for shared rate-limit counters, wired
in as `REDIS_URL`.

Each deploy runs `npm ci && npm run build`, then `npm run prisma:migrate:deploy` as the
pre-deploy step (a failed migration stops the deploy), then starts the new instance and only
routes traffic to it once `GET /health/ready` answers `200`. `JWT_SECRET` is generated per
environment; the LiveKit, Google, Sentry and allow-list values are entered in the Render
dashboard (`sync: false`) and never committed. Choose paid plans for production, since free
instances sleep and free databases expire.

### Least-privilege database access

Render's generated `DATABASE_URL` belongs to the database owner. To run the server with a
data-only role, create the roles as described in `docs/database.md`, then in the dashboard set
`DATABASE_URL` to the `ridezz_app` connection string and `MIGRATION_DATABASE_URL` to the owner's.
Migrations keep running as the owner; the server can no longer change the schema.

## Server release

1. Merge to `master` with CI green; staging deploys automatically.
2. Back up the target database (the hosting provider's snapshot or `pg_dump`).
3. Build and migrate:

   ```sh
   npm ci
   npm run build
   npm run prisma:migrate:deploy
   ```

4. Start with `npm start`. The platform health check should call `GET /health/ready`, which only
   returns `200` once the database is reachable.
5. Watch the logs for `server_started` and for `http_error` or `level: "error"` entries.

The process handles `SIGTERM`, so rolling restarts finish in-flight requests within
`SHUTDOWN_TIMEOUT_MS`.

### Configuration checklist

- `DATABASE_URL` uses TLS (`sslmode=require`) in staging and prod.
- `JWT_SECRET` is at least 32 random characters and unique per environment.
- `CORS_ORIGINS` is set if any browser client exists.
- `ALLOWED_EMAILS` is set while the app is in private testing.
- `LOG_LEVEL` is `info` (or `warn`) in production.

The server validates required values, formats and ranges at startup and exits with a
`server_config_invalid` log line if something is wrong; the items above that are policy (TLS,
uniqueness of secrets) are checked by whoever deploys.

### Rollback

- **Code:** in Render, use *Rollback* on the previous successful deploy (or redeploy its commit).
- **Database:** migrations are forward-only. Write additive migrations (new nullable columns, new
  tables) so the previous build keeps working against the new schema, and remove old columns in a
  later release. If a migration must be undone, restore the backup taken in step 2.

## Mobile release

1. Bump `versionCode` and `versionName` in `mobile/android/app/build.gradle`.
2. Fill in `mobile/.env.prod` (HTTPS `API_URL`; the build refuses anything else).
3. Build the bundle: `npm run build:android:prod`.
4. Upload `android/app/build/outputs/bundle/prodRelease/app-prod-release.aab` to the Play Console
   internal testing track, test it, then promote it to production.

Staging builds (`npm run build:android:staging`) go to testers through a Play testing track or
Firebase App Distribution.

A private release keystore is required before the first Play Store upload; the repository's
release build type still uses the public debug keystore.

## Monitoring and alerts

| What                         | Where                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| Liveness / readiness         | `GET /health`, `GET /health/ready`; Render restarts instances that fail it |
| Response times               | `durationMs` on every `http_request` log line; Render's response-time metrics |
| CPU, memory                  | Render service metrics                                                 |
| Database load, connections   | Render PostgreSQL metrics                                              |
| Errors                       | Sentry (with `SENTRY_DSN`), plus `level` `error` / `fatal` log lines, each with a `requestId` |
| Security events              | `refresh_token_reuse_detected` warnings (a refresh token was replayed) |
| Rate-limit store             | `cache` in `GET /health/ready`; `redis_error` log lines                |
| Business events              | `user_registered`, `user_signed_in`, `user_sign_in_failed`, `room_hosted`, `room_joined`, `room_destination_updated` |

Alerts to configure in Render: failed deploys, failed health checks and service restarts (email
or Slack notifications). For log-based alerts (for example more than five `error` lines in five
minutes), forward the log stream to a log provider such as Better Stack, Datadog or Grafana Loki.

In Sentry, alert on new issues and on spikes in event volume. Not yet in place: error tracking in
the mobile app (it needs the native Sentry SDK and an Android build) and distributed tracing.
