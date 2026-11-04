# Ridezz server API

Base URL: `<server>/api/v1`. Every endpoint is also served under the unversioned `<server>/api`
prefix, which existing app builds use. All request and response bodies are JSON, and request bodies
are limited to 32 KB.

The machine-readable OpenAPI 3.1 document is served at `GET /api/v1/openapi.json` (source:
`server/src/openapi.ts`). A unit test fails if it drifts from the routes the server mounts.

## Conventions

| Topic          | Behaviour                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Authentication | `Authorization: Bearer <token>`, using the `token` returned by any sign-in endpoint (HS256 JWT). |
| Errors         | Every error body is `{ "message": string, "code": string }`. Show `message` to riders; branch on `code`. |
| Request IDs    | Send `x-request-id` (1-128 chars of `A-Z a-z 0-9 . _ : -`) or the server generates one. It is echoed in the response header and in every log line for that request. |
| Rate limits    | Sign-in/sign-up and room joins each have a per-IP limit (`AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MS`), and password sign-in also has a per-email limit (`AUTH_ACCOUNT_RATE_LIMIT_MAX`). Exceeding either returns `429 RATE_LIMITED`. Limit headers follow the IETF draft-7 `RateLimit` format. |
| Allow list     | When `ALLOWED_EMAILS` is set, any other address gets `403` and its existing tokens stop working.  |
| Unknown routes | `404 NOT_FOUND`.                                                                                  |
| Server errors  | `500 INTERNAL_ERROR`. Details are only logged, never returned.                                    |

### Error codes

| Code                         | Status | Meaning                                                   |
| ---------------------------- | ------ | --------------------------------------------------------- |
| `INVALID_REQUEST`            | 4xx    | Malformed JSON, oversized body or other unparseable input |
| `VALIDATION_FAILED`          | 400    | A field is missing or invalid                             |
| `UNAUTHENTICATED`            | 401    | Missing, invalid or expired token                         |
| `INVALID_CREDENTIALS`        | 401    | Wrong email or password                                   |
| `GOOGLE_ONLY_ACCOUNT`        | 401    | The account signs in with Google                          |
| `GOOGLE_TOKEN_REJECTED`      | 401    | Google did not accept the ID token                        |
| `EMAIL_NOT_VERIFIED`         | 401    | Google has not verified the email                         |
| `NOT_ALLOWED`                | 403    | Not on the allow list                                     |
| `EMAIL_DOMAIN_NOT_SUPPORTED` | 403    | Not a Gmail account                                       |
| `FORBIDDEN`                  | 403    | Signed in, but not allowed to do this                     |
| `NOT_FOUND`                  | 404    | Unknown route                                             |
| `ACCOUNT_NOT_FOUND`          | 404    | No account for this Google account (login mode)           |
| `ROOM_NOT_FOUND`             | 404    | No hosted room with this code                             |
| `EMAIL_TAKEN`                | 409    | An account with this email exists                         |
| `GOOGLE_ACCOUNT_CONFLICT`    | 409    | The email is linked to another Google account             |
| `ROOM_CODE_CONFLICT`         | 409    | The room code belongs to someone else                     |
| `RATE_LIMITED`               | 429    | Too many requests                                         |
| `GOOGLE_SIGN_IN_DISABLED`    | 503    | Google sign-in is not configured                          |
| `SERVICE_UNAVAILABLE`        | 503    | Google could not be reached; retry later                  |
| `INTERNAL_ERROR`             | 500    | Unexpected server error                                   |

### Shared types

```ts
interface User {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  roomCode: string | null;
}

interface Session {
  token: string;
  user: User;
}

interface RoomAccess {
  roomCode: string;
  roomId: string;
  isHost: boolean;
  token: string;
  serverUrl: string;
  destinationName: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
}
```

## Health

| Method | Path            | Auth | Success                                  | Failure                                                 |
| ------ | --------------- | ---- | ---------------------------------------- | ------------------------------------------------------- |
| GET    | `/health`       | No   | `200 { "status": "ok" }`                 | None                                                    |
| GET    | `/health/ready` | No   | `200 { "status": "ok", "database": "ok" }` | `503 { "status": "unavailable", "database": "unavailable" }` |

The health endpoints are mounted at the server root, not under `/api`.

## Authentication

### `POST /api/auth/signup` (alias `POST /api/auth/register`)

Request: `{ "name": string, "email": string, "password": string }`

- `name`: 2-24 characters after trimming.
- `email`: a Gmail address, stored lowercased.
- `password`: at least 8 characters and at most 72 bytes.

| Status | Body / meaning                                   |
| ------ | ------------------------------------------------ |
| 201    | `Session`                                        |
| 400    | Missing field or failed validation               |
| 403    | Address not on the allow list                    |
| 409    | An account with this email already exists        |

### `POST /api/auth/login`

Request: `{ "email": string, "password": string }`

| Status | Body / meaning                                        |
| ------ | ----------------------------------------------------- |
| 200    | `Session`                                             |
| 400    | Email or password missing                             |
| 401    | Invalid credentials, or the account is Google-only    |
| 403    | Address not on the allow list                         |

### `GET /api/auth/google/config`

| Status | Body / meaning                             |
| ------ | ------------------------------------------ |
| 200    | `{ "clientId": string }`                   |
| 503    | Google sign-in is not configured           |

### `POST /api/auth/google`

Request: `{ "idToken": string, "mode"?: "login" | "signup" }` (default `login`).

| Status | Body / meaning                                                                  |
| ------ | ------------------------------------------------------------------------------- |
| 200    | `Session`                                                                       |
| 400    | Missing token or invalid mode                                                   |
| 401    | Token rejected, or the Google email is not verified                             |
| 403    | Not a Gmail account, or not on the allow list                                   |
| 404    | `mode: "login"` with no matching account (`code: "ACCOUNT_NOT_FOUND"`)          |
| 409    | The email is already linked to a different Google account                       |
| 503    | Google sign-in is not configured (`GOOGLE_SIGN_IN_DISABLED`), or Google is unreachable after retries (`SERVICE_UNAVAILABLE`) |

### `GET /api/auth/me` and `GET /api/user/profile`

Auth required. `200 { "user": User }`, or `401` without a valid token.

## Ride rooms

All room endpoints require authentication. Room codes are the rider's permanent 5-digit code.

### `POST /api/rooms/create`

Request: `{ "riderName"?: string, "destinationName"?: string, "destinationLat"?: number, "destinationLng"?: number }`

Creates the signed-in rider's room, or reuses it if it already exists. `riderName` defaults to the
account name and is cut to 24 characters. A destination is stored only when both coordinates are
valid (latitude -90..90, longitude -180..180).

| Status | Body / meaning                                   |
| ------ | ------------------------------------------------ |
| 201    | `RoomAccess` with `isHost: true`                 |
| 409    | The room code is owned by someone else           |
| 500    | `{ "message": "Failed to create room." }`        |

### `POST /api/rooms/join`

Request: `{ "roomCode": string, "riderName"?: string }`

| Status | Body / meaning                                   |
| ------ | ------------------------------------------------ |
| 200    | `RoomAccess` (`isHost` is true for the creator)  |
| 400    | Invalid room code                                |
| 404    | Room not found                                   |
| 429    | Rate limit exceeded                              |

### `PATCH /api/rooms/:roomCode/destination`

Request: `{ "destinationName"?: string, "destinationLat": number, "destinationLng": number }`

| Status | Body / meaning                                                         |
| ------ | ---------------------------------------------------------------------- |
| 200    | `{ "destinationName", "destinationLat", "destinationLng" }`            |
| 400    | Invalid room code or destination                                       |
| 403    | Only the ride creator can change the destination                       |
| 404    | Room not found                                                         |

## Versioning and compatibility

The current version is `v1`. Within a version, changes are additive only: new endpoints, new
optional request fields, new response fields and new error codes. Clients must ignore fields they
do not know. A breaking change ships as `/api/v2` alongside `/api/v1`, and the old version stays
until no supported app build uses it. The unversioned `/api` prefix is an alias of `v1` for app
builds released before versioning; new app code should call `/api/v1`.
