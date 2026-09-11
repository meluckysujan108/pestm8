# Deploying PestM8

Two pieces deploy separately, and an environment is a **matched pair** of them.

| Piece        | Runs on | Contains                                                                                                  |
| ------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| **Backend**  | Convex  | Schema, queries/mutations/actions, file storage, Better Auth component, HTTP routes on the `.site` domain |
| **Frontend** | Vercel  | The Nitro server build — SSR, route loaders, and the `/api/auth/*` proxy                                  |

**The frontend cannot go on Convex hosting.** Convex hosting serves static
assets; this app builds a Nitro server (`vite.config.ts` runs `nitro()` beside
`tanstackStart()`) and `src/routes/api/auth/$.ts` registers real server
handlers. Those handlers are not optional — this Nitro build emits only the
last `Set-Cookie` on a response, so the proxy exists to drop the Convex JWT
cookie and keep the session cookie. Serve the app statically and nobody can
sign in.

## The environments

| Environment | Convex project                   | `SITE_URL` on it        | Frontend                 | Deployed by                     |
| ----------- | -------------------------------- | ----------------------- | ------------------------ | ------------------------------- |
| Local       | your `npx convex dev` deployment | `http://localhost:3000` | `pnpm dev`               | you                             |
| CI          | `pestm8-ci`                      | `http://localhost:3000` | `pnpm dev` in the runner | `.github/workflows/e2e.yml`     |
| Preview     | `pestm8-staging`                 | the branch's Vercel URL | Vercel Preview           | Vercel, per pull request        |
| Production  | `pestm8`                         | your production origin  | Vercel Production        | CI, via the `production` branch |

Convex preview deployments are a paid-plan feature, so on the free plan the
equivalent is a **separate Convex project** per environment — each gets its own
production deployment and its own deploy key.

Each deployment needs its **own** `BETTER_AUTH_SECRET`
(`openssl rand -base64 32`). Never reuse production's.

## What actually deploys production

**Production is the `production` branch, not `main`.**

The `promote` job in `.github/workflows/ci.yml` is the only thing that moves
it, and it runs only after `verify` passes and E2E has not failed. A commit
that reaches `main` without passing those gates never reaches production — the
app stays on the last good commit.

This is deliberately standing in for GitHub branch rules, which are a paid
feature on a private repository. Gating the _deploy_ rather than the _push_
costs nothing, and is arguably the stronger guarantee: branch rules stop a bad
commit from landing, whereas this stops a bad commit from being **served** even
if it lands.

To make Vercel honour it:

**Vercel → Project Settings → Git → Production Branch: `production`**

Pushes to `main` then produce _preview_ deployments, which is useful in itself —
main stays continuously build-tested — while production only moves when CI says so.

> **Order matters.** Change the Production Branch setting only after you have
> seen the `promote` job succeed once and the `production` branch exists. Flip
> it early and production simply stops receiving deploys.

Rolling back becomes a git operation:

```bash
git push --force-with-lease origin <last-good-sha>:production
```

Vercel redeploys that commit. This does **not** roll back Convex — see
[docs/RUNBOOK.md](./docs/RUNBOOK.md).

### Alternative, if you would rather not add a branch

Keep Vercel's production branch as `main`, disable its automatic deploys with a
`vercel.json`, and have CI deploy through the Vercel CLI instead:

```json
{ "git": { "deploymentEnabled": { "main": false } } }
```

That needs `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as GitHub
secrets. The branch approach is preferred here because it needs no extra
credentials and makes "what is in production" a git ref you can look at.

## Environment variables

`VITE_`-prefixed variables reach the client by being **inlined at build time**,
not read at runtime. The same two are also read at runtime by the server
(`src/lib/auth-server.ts`). So they must be present **when the build runs**, not
merely in the runtime environment. Set them only at runtime and you get a
half-working deploy: the server authenticates fine while every page throws in
the browser. `scripts/check-env.mjs` fails the build instead.

### On Vercel

Set per-environment in Project Settings → Environment Variables:

| Variable               | Production                  | Preview                                 |
| ---------------------- | --------------------------- | --------------------------------------- |
| `CONVEX_DEPLOY_KEY`    | production key for `pestm8` | production key for **`pestm8-staging`** |
| `VITE_CONVEX_URL`      | prod `.cloud` URL           | staging `.cloud` URL                    |
| `VITE_CONVEX_SITE_URL` | prod `.site` URL            | staging `.site` URL                     |

> **The one mistake that breaks production.** Putting the _production_
> `CONVEX_DEPLOY_KEY` in the **Preview** environment makes every pull request
> deploy its unreviewed backend onto the live database. Check the Environment
> column on that variable twice.

Build Command: `bash scripts/vercel-build.sh`. Output directory: `.output`.

### On each Convex deployment

Set with `npx convex env set <NAME> <value>` against that deployment:

| Variable             | Value                                            |
| -------------------- | ------------------------------------------------ |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`, unique per deployment |
| `SITE_URL`           | the exact origin the frontend is served from     |
| `RESEND_API_KEY`     | for report email (`convex/email.ts`)             |
| `RESEND_FROM_EMAIL`  | sender address                                   |

`SITE_URL` must match the frontend origin **exactly** — scheme, host, no
trailing slash. Better Auth rejects callbacks from origins that don't match,
which presents as sign-in appearing to work and then bouncing back to `/login`.
This has already caused one production outage. On preview builds
`scripts/vercel-build.sh` sets it for you from `VERCEL_BRANCH_URL`; on
production it is set once and left alone.

`.env.example` also lists `VITE_SITE_URL`. Only `scripts/seed.mjs` reads it.

## GitHub secrets

| Secret                                          | Used by               | Points at        |
| ----------------------------------------------- | --------------------- | ---------------- |
| `CONVEX_CI_DEPLOY_KEY`                          | `e2e.yml`             | `pestm8-ci`      |
| `CI_CONVEX_URL`, `CI_CONVEX_SITE_URL`           | `e2e.yml`             | `pestm8-ci`      |
| `STAGING_CONVEX_URL`, `STAGING_CONVEX_SITE_URL` | `ci.yml` build step   | `pestm8-staging` |
| `CONVEX_PROD_DEPLOY_KEY`                        | `backup.yml` **only** | `pestm8`         |

`CONVEX_PROD_DEPLOY_KEY` is the only credential in this repository that can
touch production, and nothing but the backup workflow reads it.

## First deploy of a new environment

There is a sequencing knot: a deployment's `SITE_URL` must be the frontend's
origin, but you don't know that origin until the frontend has deployed once.

1. `npx convex deploy` — creates the deployment, prints its URL. Both frontend
   variables derive from it (`.cloud` for `VITE_CONVEX_URL`, the same
   deployment on `.site` for `VITE_CONVEX_SITE_URL`).
2. `npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"`.
3. Deploy the frontend with the two `VITE_` variables set **before** the first
   build — the build inlines them.
4. `npx convex env set SITE_URL https://<the origin the host assigned>`.

Sign-in works from step 4 onward. Repeat step 4 whenever the origin changes — a
custom domain, or moving hosts.

## Verifying a deploy

The failure modes here are all quiet, so check them directly:

- **Load any route.** A blank page with `VITE_CONVEX_URL is not set` in the
  console means the build ran without the variables inlined. Re-run the build
  with them set; redeploying the same artifact won't fix it.
- **Sign in.** Bouncing back to `/login` after apparently-successful
  credentials means `SITE_URL` doesn't match the origin.
- **`curl https://<origin>/sw.js`** should return JavaScript, not HTML or a
  redirect. Existing on disk and being reachable are different things.
- **`/api/auth/*` must be served by the Nitro server.** If the host serves
  `.output/public` statically and ignores `.output/server`, this 404s and no
  session ever persists.

## Rolling back

See [docs/RUNBOOK.md](./docs/RUNBOOK.md).
