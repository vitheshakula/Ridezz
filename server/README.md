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
| `GET /api/user/profile` | Bearer | `{ user }` with the rider's permanent `roomCode` (assigned now if they have none). |
| `POST /api/rooms/create`, `/join` | Bearer | Room + LiveKit token. `create` hosts the rider's own permanent room. |

`user` is `{ id, email, name, emailVerified, roomCode }`. Send `Authorization: Bearer <token>` on protected
routes; tokens last 30 days.

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
voice channel at any time, and 90,000 codes can be tried. Rate limiting joins, or letting a host
approve joiners, would close that; neither exists yet.

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
   - Package name: `com.rideaze.mobile`
   - SHA-1 certificate fingerprint of the key the app is signed with. For the checked-in debug
     keystore: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
     (`keytool -list -v -keystore mobile/android/app/debug.keystore -alias androiddebugkey -storepass android`).
   - A release build signed with a different key needs its own SHA-1 added.

   This client has no secret and nothing to copy; it only authorizes the app. If it is missing or
   its SHA-1 is wrong, Google Sign-In fails on the phone with `DEVELOPER_ERROR`.
