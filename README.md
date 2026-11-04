# Ridezz

Ridezz is a group intercom app for motorcycle riders. Up to 10 riders join one ride room with a
5-digit code and talk hands-free over LiveKit voice while the phone stays in a pocket. Audio goes
through whatever the rider wears: a Bluetooth helmet headset, earbuds, wired earphones or the
phone itself. The app also shares live positions and a ride destination, and raises hazard,
hard-braking and crash alerts. When mobile data drops, alerts keep moving rider to rider over
Google Nearby Connections.

[![CI](https://github.com/vitheshakula/Ridezz/actions/workflows/ci.yml/badge.svg)](https://github.com/vitheshakula/Ridezz/actions/workflows/ci.yml)
[![Security](https://github.com/vitheshakula/Ridezz/actions/workflows/security.yml/badge.svg)](https://github.com/vitheshakula/Ridezz/actions/workflows/security.yml)

## Repository layout

| Path                | Contents                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `mobile/`           | React Native (TypeScript) Android app with Kotlin native modules        |
| `server/`           | Node.js + Express + Prisma (PostgreSQL) API: accounts, rooms, LiveKit tokens |
| `docs/api.md`       | HTTP API reference (OpenAPI at `/api/v1/openapi.json`)                  |
| `docs/database.md`  | Schema, indexes, migrations, backups                                    |
| `docs/backend-checklist.md` | Backend best-practice compliance report                        |
| `render.yaml`       | Staging and production hosting blueprint                                |
| `docs/architecture` | Architecture overview, backend design and decisions, connectivity notes |
| `docs/deployment.md`| Deployment, rollback and operations                                     |
| `docs/history`      | Earlier project status reports and audits, kept for reference           |
| `.github/`          | CI, security scanning, Dependabot and pull request template             |

## How it fits together

```
 Android app ──HTTPS──▶ Ridezz server ──▶ PostgreSQL
     │                      │
     │                      └─ issues short-lived LiveKit tokens
     ├──WebRTC──▶ LiveKit Cloud (voice, location, hazard data)
     └──Nearby Connections──▶ other riders' phones (offline alerts)
```

The LiveKit API secret lives only on the server; the app receives short-lived room tokens. See
[`docs/architecture/overview.md`](docs/architecture/overview.md) for the design decisions.

## Getting started

Prerequisites: Node.js 22 (`.nvmrc`), PostgreSQL 16, a LiveKit project, and for the app JDK 17
plus the Android SDK.

1. **Server**

   ```sh
   cd server
   npm ci
   cp .env.example .env
   npm run prisma:migrate:deploy
   npm run dev
   ```

   Fill in `.env` first; every variable is described in [`server/README.md`](server/README.md).

2. **Mobile app**

   ```sh
   cd mobile
   npm ci
   cp .env.dev.example .env.dev
   npm start
   npm run android
   ```

   The app has `dev`, `staging` and `prod` environments; see [`mobile/README.md`](mobile/README.md).

## Quality checks

Each package runs the same checks locally and in CI:

```sh
npm run format:check && npm run lint && npm run typecheck && npm run test:coverage
```

The server also has `npm run test:integration`, which needs a dedicated PostgreSQL test database.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the branching model, commit style and review rules,
and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).
