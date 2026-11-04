# Security policy

## Reporting a vulnerability

Do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/vitheshakula/Ridezz/security/advisories/new),
with steps to reproduce and the affected version or commit. You should get a reply within a week.

## How the project protects riders

- Secrets (JWT secret, LiveKit API secret, database URL, Google client) live only in server
  environment variables. The app receives short-lived LiveKit tokens, never the API secret.
- Passwords are stored as bcrypt hashes. Login, sign-up and room joins are rate limited per IP.
- Every request body is size-limited and validated; database access goes through Prisma's
  parameterized queries.
- Logs never contain headers, request bodies, tokens or database credentials. Release builds of
  the app drop debug logs, which are the only ones allowed to contain positions or message text.
- Staging and production builds refuse to start without an HTTPS backend URL.
- CI runs CodeQL, a secret scan, dependency review and `npm audit` on every pull request, and
  Dependabot proposes dependency updates weekly.

## Known limitations

- Release builds are still signed with the public debug keystore. A private release keystore is
  required before any Play Store release.
- Room codes are short and permanent: any signed-in rider who learns one can join that room.
