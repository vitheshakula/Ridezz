# Ridezz server API

Base URL: `<server>/api` (the mobile app's `API_URL`). All request and response bodies are JSON.
Request bodies are limited to 32 KB.

## Conventions

| Topic          | Behaviour                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Authentication | `Authorization: Bearer <token>`, using the `token` returned by any sign-in endpoint (HS256 JWT). |
| Errors         | Every error body is `{ "message": string }`, sometimes with a machine-readable `code`.            |
| Request IDs    | Send `x-request-id` (1-128 chars of `A-Z a-z 0-9 . _ : -`) or the server generates one. It is echoed in the response header and in every log line for that request. |
| Rate limits    | Sign-in/sign-up and room joins share a per-IP limit (`AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MS`). Exceeding it returns `429`. Limit headers follow the IETF draft-7 `RateLimit` format. |
| Allow list     | When `ALLOWED_EMAILS` is set, any other address gets `403` and its existing tokens stop working.  |
| Unknown routes | `404 { "message": "Not found." }`.                                                                 |
| Server errors  | `500 { "message": "Internal server error" }`. Details are only logged, never returned.           |

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
| 503    | Google sign-in is not configured                                                |

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

## Versioning

The API is unversioned and has one client, the mobile app, which ships from this repository.
Changes must stay backward compatible with the latest released app. A breaking change needs a new
path prefix (for example `/api/v2`) served alongside the old one until the old app versions are
retired.
