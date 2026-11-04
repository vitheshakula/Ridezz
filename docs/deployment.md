# Deployment and operations

## Environments

| Environment | App flavor | Server                     | Database                    |
| ----------- | ---------- | -------------------------- | --------------------------- |
| dev         | `dev`      | A developer's machine      | Local PostgreSQL            |
| staging     | `staging`  | Shared hosted test server  | Its own PostgreSQL database |
| prod        | `prod`     | Production server          | Production PostgreSQL       |

Each environment has its own `JWT_SECRET`, LiveKit project or keys, Google OAuth clients and
database. Never share secrets or data between environments.

## Server release

1. Merge to `master` with CI green.
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

The server validates all of this at startup and exits with a `server_config_invalid` log line if
something is wrong.

### Rollback

- **Code:** redeploy the previous build or commit.
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

## Monitoring

- Health: `GET /health/ready` from the hosting platform or an uptime monitor.
- Errors: alert on `level` `error` or `fatal` in the log stream; each entry has a `requestId` that
  matches the `x-request-id` response header the client saw.
- Not yet in place: crash reporting for the app (for example Firebase Crashlytics or Sentry) and
  metrics dashboards.
