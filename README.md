# PestM8

Calendar-first job scheduling and compliance reporting for small Australian
pest control businesses. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
product and architecture spec — it is the source of truth for this codebase.

## Getting started

```bash
pnpm install --frozen-lockfile
```

Provision a Convex deployment. This is interactive: it opens a browser to log
in or create a Convex account, then writes `CONVEX_DEPLOYMENT` and
`VITE_CONVEX_URL` into `.env.local`.

```bash
npx convex dev
```

Fill in the remaining values in `.env.local`. `VITE_CONVEX_SITE_URL` is the
same deployment as `VITE_CONVEX_URL` but on the `.site` domain rather than
`.cloud` — it is where the Better Auth HTTP routes are mounted.

Set the deployment-side auth secrets:

```bash
npx convex env set BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
```

```bash
npx convex env set SITE_URL http://localhost:3000
```

Two auth switches are **off unless set**, and both belong on production only:

| Env var               | Effect                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_INVITE_ONLY=on` | Sign-up requires a live invitation token. Without it anyone can create an account (they join nothing, but the account exists). |
| `AUTH_RATE_LIMIT=on`  | Database-backed rate limiting on sign-in, sign-up and password reset.                                                          |

They stay off in dev and e2e because the test suite creates ~150 accounts per
run. Before turning `AUTH_RATE_LIMIT` on, check what client IP actually reaches
Convex through the Vercel proxy — if it resolves to nothing, every request
shares one bucket and a tight limit locks out the whole business at once.

Two switches run the other way — **on unless set**, because a security check
should not disappear when an environment variable goes missing:

| Env var                 | Effect                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AUTH_BREACH_CHECK=off` | Stops checking passwords against Have I Been Pwned. Set on the e2e deployment only.                                     |
| `AUTH_MFA_REQUIRED=off` | Two-step sign-in (authenticator app + recovery codes) stops being compulsory. Set on the e2e deployment only.           |

With `AUTH_MFA_REQUIRED` unset, every app function refuses a signed-in account
that has not set up two-step sign-in (`MFA_ENROLMENT_REQUIRED`, which the client
turns into the `/two-step` set-up screen), nobody can switch it off, and a code
is asked for at every sign-in — there is no "trust this device". A technician
who loses their phone signs in with a recovery code; one who has lost both is
reset by the business owner from Settings → Team. The e2e suite signs up
accounts that cannot read an authenticator app, so that deployment needs
`off` (`e2e/globalSetup.ts` refuses to run the suite without it). Setting up
two-step sign-in signs the account out on every other device, and ten wrong
codes in a row lock the account's code check for 15 minutes.

**Releasing compulsory two-step sign-in to a deployment that has users.**
Enforcement starts the moment the backend deploys, for every open app — so
stage it rather than let it land on a stale frontend or mid-shift:

1. `npx convex env set AUTH_MFA_REQUIRED off` on that deployment, BEFORE
   deploying the backend. Nothing is refused yet.
2. Deploy the backend, then the frontend, and confirm Vercel's newest
   _successful_ build is this commit (the frontend must have `/two-step` and
   the set-up prompt before anyone is refused; see CLAUDE.md on stale builds).
3. Give open apps time to pick up the new bundle — the service worker only
   offers a reload, it never forces one. Out of hours is best.
4. `npx convex env remove AUTH_MFA_REQUIRED`. Anyone already inside the app
   sees a "Set up two-step sign-in" card over the page they are on (nothing
   they typed is thrown away); everyone else is sent to set-up at their next
   sign-in. Tell the team beforehand that they will need an authenticator app.

Every password set or changed otherwise costs one live HTTPS call to
`api.pwnedpasswords.com`, and the e2e suite makes ~120 of them per run — an
outage of that service once failed 54 of 127 tests. Production keeps the check
on; it refuses a breached password as before, but an *unreachable* service no
longer refuses anything, so a third party being down cannot lock anyone out of
`/change-password` or `/reset-password`.

Then, with `npx convex dev` running in one terminal:

```bash
pnpm dev
```

## Access-control tests

The matrix in ARCHITECTURE.md §6.5 is the most important suite in this
repository — it asserts tenant and role isolation at the Convex function
level, not just in the UI. Only the invoice and Xero rows are `test.fixme`,
since neither feature exists yet.

Permission rules themselves are unit-tested with `convex-test` (`pnpm test`),
which needs no deployment and runs in milliseconds. Playwright covers the
journeys a person actually walks; per-permission cases belong in the unit
suite.

```bash
npx playwright install chromium
```

```bash
pnpm test:e2e
```

### Which deployment the suite runs against

A run creates roughly 150 real accounts and 100 businesses and never cleans up,
so it must never touch production. `e2e/fixtures.ts` and `scripts/seed.mjs`
refuse anything that is not a `dev:` deployment, and refuse the production
deployment names outright.

This branch uses its own Convex project, **`pestm8-e2e`** (deployment
`warmhearted-cricket-924`), rather than the shared personal dev deployment —
two branches with different schemas cannot share one deployment, and test junk
does not belong in the deployment used for manual QA. Its `SITE_URL` and
`BETTER_AUTH_SECRET` are set on the deployment itself.

Run the suite against a **production build**, not the dev server:

```bash
pnpm build && npx vite preview --port 3000
```

That exercises the service worker and the `__Secure-` cookie names, which only
exist over a real build, and it sidesteps a Vite dep-optimiser bug in the
current dependency set (see `optimizeDeps.exclude` in `vite.config.ts`).

## Commands

| Command                     | Does                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `pnpm dev`                  | Vite dev server on :3000 (needs `npx convex dev` alongside) |
| `pnpm build`                | Production build                                            |
| `pnpm generate-routes`      | Regenerate `routeTree.gen.ts` after adding routes           |
| `pnpm typecheck`            | `tsc --noEmit` over the app and `convex/`                   |
| `pnpm test`                 | Vitest + convex-test unit suite (no deployment needed)      |
| `pnpm test:e2e`             | Playwright access-control suite                             |
| `pnpm lint` / `pnpm format` | ESLint + Prettier                                           |
