# PestM8

Calendar-first job scheduling and compliance reporting for small Australian
pest control businesses. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
product and architecture spec — it is the source of truth for this codebase.

## Getting started

```bash
pnpm install
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

Then, with `npx convex dev` running in one terminal:

```bash
pnpm dev
```

## Access-control tests

The matrix in ARCHITECTURE.md §6.5 is the most important suite in this
repository — it asserts tenant and role isolation at the Convex function
level, not just in the UI. Job-scoped rows are `test.fixme` until Phase 2.

```bash
npx playwright install chromium
```

```bash
pnpm test:e2e
```

## Commands

| Command         | Does                                                            |
| --------------- | --------------------------------------------------------------- |
| `pnpm dev`      | Vite dev server on :3000 (needs `npx convex dev` alongside)     |
| `pnpm build`    | Production build                                                |
| `pnpm verify`   | Everything CI checks: format, lint, both typechecks, DST checks |
| `pnpm format`   | Fix formatting and auto-fixable lint                            |
| `pnpm test:e2e` | Playwright access-control suite                                 |
| `pnpm seed`     | Fill a dev deployment with a realistic business                 |

`src/routeTree.gen.ts` is regenerated automatically by `pnpm dev` and
`pnpm build` — there is no separate command to run, and you should not edit it
by hand. (Do not use `tsr generate` from `@tanstack/router-cli`: it does not
emit the TanStack Start `Register` declaration the committed file carries, so
it silently strips SSR router typing.)
