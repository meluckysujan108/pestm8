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
| `AUTH_RATE_LIMIT=on`  | Database-backed rate limiting on sign-in, sign-up, password reset and the two-step endpoints (codes: 10 a minute per IP).      |

They stay off in dev and e2e because the test suite creates ~150 accounts per
run. Before turning `AUTH_RATE_LIMIT` on, check what client IP actually reaches
Convex through the Vercel proxy — if it resolves to nothing, every request
shares one bucket and a tight limit locks out the whole business at once.

One switch runs the other way — **on unless set**, because a security check
should not disappear when an environment variable goes missing:

| Env var                 | Effect                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `AUTH_BREACH_CHECK=off` | Stops checking passwords against Have I Been Pwned. Set on the e2e deployment only. |

**Two-step sign-in** (authenticator app + ten recovery codes) is optional:
each person turns it on or off in Settings → Profile, with their password.
Once on, a code is asked for at every sign-in — there is no "trust this
device". A technician who loses their phone signs in with a recovery code; one
who has lost both is reset by the business owner from Settings → Team. Turning
it on signs the account out on every other device, and ten wrong codes in a
row lock the account's code check for 15 minutes.

`AUTH_MFA_REQUIRED=on` makes it compulsory on that deployment: every app
function then refuses a signed-in account that has not set it up
(`MFA_ENROLMENT_REQUIRED`, which the client turns into the `/two-step` set-up
screen), and nobody can switch it off. Nothing sets it today. Before turning
it on where people are working, deploy the frontend first, give open apps time
to pick up the new bundle, and tell the team they will need an authenticator
app. The e2e suite's accounts cannot read one, so `e2e/globalSetup.ts` refuses
to run against a deployment where it is on.

**Sessions last until sign-out**: 400 days, renewed on every use (at most once
a day), so anyone who opens PestM8 at least once a year stays signed in.
Signing out, removal from the team and a two-step reset still end sessions
(`SESSION_LIFETIME` in `convex/auth.ts`).

Every password set or changed otherwise costs one live HTTPS call to
`api.pwnedpasswords.com`, and the e2e suite makes ~120 of them per run — an
outage of that service once failed 54 of 127 tests. Production keeps the check
on; it refuses a breached password as before, but an _unreachable_ service no
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
