# Contributing to Ridezz

## Branching

`master` is the production branch. It only changes through reviewed pull requests; nobody pushes
to it directly.

| Branch            | Use                                              |
| ----------------- | ------------------------------------------------ |
| `master`          | Releasable code. Protected.                      |
| `feat/<topic>`    | New features, e.g. `feat/ride-history`           |
| `fix/<topic>`     | Bug fixes                                        |
| `chore/<topic>`   | Tooling, dependencies, refactors without behaviour change |
| `docs/<topic>`    | Documentation only                               |

Branch from the latest `master`, keep the branch short-lived, and rebase or merge `master` into it
before asking for review. Personal long-running branches (one per developer) make merges painful;
use one branch per change instead.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <summary in the imperative, under 72 characters>

<why the change is needed and anything a reviewer should know>
```

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`.
- Scopes: `mobile`, `server`, `android`, `connectivity`, `ci`, or omit for repository-wide work.
- One logical change per commit. Formatting-only changes go in their own commit.
- Never commit `.env` files, keystores (other than the public debug keystore), API keys or tokens.
  CI runs a secret scan on every pull request.

## Pull requests

1. Open a pull request against `master` and fill in the template.
2. CI must pass: formatting, lint, type check, unit tests with coverage, server integration tests,
   the Android build, CodeQL, the secret scan and dependency review.
3. At least one other developer must approve. Reviewers check readability, security, test
   coverage, unnecessary complexity, performance and that docs are updated.
4. Squash-merge, using a Conventional Commit title.
5. Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything user-visible.

## Before you push

From the package you changed (`mobile/` or `server/`):

```sh
npm run format
npm run lint
npm run typecheck
npm run test:coverage
```

For server changes that touch routes or the database, also run `npm run test:integration` against
a local `ridezz_test*` database (see `server/README.md`). For native Android changes, run
`cd mobile/android && ./gradlew testDevDebugUnitTest assembleDevDebug`.

## Code standards

- TypeScript strict mode; no `any` in application code.
- Prettier formats everything (`printWidth` 100). Do not hand-format.
- No `console` calls: use the logger (`server/src/logger.ts`, `mobile/src/utils/logger.ts`).
  Never log tokens, passwords, positions or message contents above `debug`.
- Configuration comes from environment files read in one place (`server/src/config/env.ts`,
  `mobile/src/config/appConfig.ts`); never hardcode URLs, keys or credentials.
- Name constants instead of using magic numbers, and keep functions small and single-purpose.
- Lint suppressions need a reason after `--`, for example
  `/* eslint-disable no-bitwise -- bit-packed wire format */`.
- Every bug fix comes with a test that fails without the fix. New behaviour comes with unit tests
  for both the happy path and invalid input.
- Database changes go through a Prisma migration (`npm run prisma:migrate:dev`), reviewed with the
  code. Never edit a migration that has been applied anywhere.
