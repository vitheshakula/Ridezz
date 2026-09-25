# Ridezz server

Node + Express + Prisma (SQLite). Handles rider accounts and sign-in, creates ride rooms, and
issues the short-lived LiveKit tokens the mobile app joins them with, so the LiveKit API secret
never lives on a phone.

```sh
npm install
cp .env.example .env      # then fill it in
npx prisma migrate deploy
npm run dev               # tsx watch
npm test                  # real routes against a throwaway database
npm run build && npm start
```

## Authentication

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/register` (`/signup`) | – | `{ name, email, password }` -> `{ token, user }`. Gmail addresses only, password 8-72 bytes. |
| `POST /api/auth/login` | – | `{ email, password }` -> `{ token, user }`. |
| `POST /api/auth/google` | – | `{ idToken, mode }` from Google Sign-In -> `{ token, user }`. `mode` is `"login"` (default: existing accounts only, else 404 `ACCOUNT_NOT_FOUND` and nothing is created) or `"signup"` (finds or creates). |
| `GET /api/auth/google/config` | – | `{ clientId }` the app must request its Google token for. |
| `GET /api/auth/me` | Bearer | The signed-in rider. |
| `POST /api/rooms/create`, `/join` | Bearer | Room + LiveKit token. |

`user` is `{ id, email, name, emailVerified }`. Send `Authorization: Bearer <token>` on protected
routes; tokens last 30 days.

- **Passwords** are stored only as bcrypt hashes (cost 10).
- **Email + password accounts are unverified** (`emailVerified: false`): a Gmail-shaped address
  proves nothing about who typed it. Only Google sign-in verifies ownership. Sending a
  verification code needs an outgoing-mail provider, which isn't set up.
- **Signing in with Google as an address that already has a password account** links them and
  **deletes the password**, since whoever created that account never proved they own the mailbox.

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
3. **Android** client -- same place, type *Android*:
   - Package name: `com.ridezz.mobile`
   - SHA-1 certificate fingerprint of the key the app is signed with. For the checked-in debug
     keystore: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
     (`keytool -list -v -keystore mobile/android/app/debug.keystore -alias androiddebugkey -storepass android`).
   - A release build signed with a different key needs its own SHA-1 added.

   This client has no secret and nothing to copy; it only authorizes the app. If it is missing or
   its SHA-1 is wrong, Google Sign-In fails on the phone with `DEVELOPER_ERROR`.
