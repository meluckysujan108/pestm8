<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Building UI

Before writing or changing anything that renders, **read
`docs/design-system.md`**: which shared component to use, the tokens, the
states every screen needs, and the copy rules. It is checked against the code
(`src/lib/designSystem.test.ts`, and the design rules in `eslint.config.js`),
so keep it true: a new token or shared component goes in the guide in the same
commit. See what you built with `pnpm ui:shots` (`tools/ui-harness/README.md`),
in both themes. The `pestm8-ui` skill has the working steps.

## Deploying this app

Two separate deploys, and they must stay in step: the Convex backend
(`npx convex deploy`) and the frontend (Vercel, building `main` from
github.com/meluckysujan108/pestm8).

**Production is the Convex deployment `rare-retriever-156`** (team
`sujan-neupane`, project `pestm8`); personal dev is
`acoustic-schnauzer-237`. A duplicate project — `sujan pest m8`, with
`joyous-otter-223` (prod) and `efficient-lemming-413` (dev) — was created
by accident and left empty; if `.env.local` names either of those, this
checkout is pointed at a project nothing serves, and `npx convex deploy`
will push to a deployment no client reads. Confirm the target before any
deploy, migration, or env-var change.

**Regenerate `pnpm-lock.yaml` in the same commit that changes
`package.json`.** Vercel runs `pnpm install` with CI's default
`--frozen-lockfile`, so a stale lockfile fails the build outright
(`ERR_PNPM_OUTDATED_LOCKFILE`). Vercel then keeps serving the *previous*
build, so the site silently runs old code while `main` looks correct and
`git status` is clean — there is no error anywhere except the Vercel build
log. Verify with `pnpm install --frozen-lockfile --lockfile-only`.

**Ship the frontend and backend together when function signatures change.**
`npx convex deploy` takes effect immediately; Vercel is a separate build
that may be hours stale or failing. If a function's args changed, the live
frontend's calls fail argument validation and the app shows a bare
"Server Error" with no clue as to why. Before deploying the backend, check
the commit of Vercel's newest *successful* deployment — if it lags `main`,
fix that first. (This is how the notes rewrite broke prod: the backend
shipped, the frontend build had been failing on the stale lockfile for
hours, and the old notes page kept calling `notes:list({businessId})`
against a backend that now required `filter` and `paginationOpts`.)

**Schema changes over rows that already exist in prod** need
expand → migrate → contract; `convex/migrations/notesV2.ts` is a worked
example with the sequence in its header comment. Snapshot first:
`npx convex export --prod --path <file>.zip`.

Useful for read-only inspection of a deployment, including prod:
`npx convex run --prod --inline-query 'return (await ctx.db.query("notes").collect()).length'`
Add `--component betterAuth` or `--component prosemirrorSync` to read a
component's own tables (Better Auth users live there, not in the app's).

Report email is **live on prod** (since 2026-09-24): `RESEND_API_KEY` and
`RESEND_FROM_EMAIL=onboarding@resend.dev` are set there. That is Resend's test
sender, which only delivers to the Resend account owner's own address, so
real customers get nothing until a domain is verified in Resend and
`RESEND_FROM_EMAIL` moves to an address on it. Every other deployment (dev,
e2e) still has neither, so emailing a report there throws
`EMAIL_NOT_CONFIGURED` by design (`convex/email.ts`).
`RESEND_WEBHOOK_SECRET` is unset everywhere, so `POST /resend/webhook` answers
404 and a delivery's status stops at "sent" — delivered/bounced never arrive.

`RESEND_FROM_EMAIL` is required rather than optional — Resend rejects a `from`
that is a bare display name. Set it to a **bare address** (`x@domain`), never
`Name <x@domain>`: `convex/email.ts` wraps it as `${sender} <${fromEmail}>`,
so brackets in the variable produce a malformed `from`. Check what a
deployment has with `npx convex env list --prod` (it prints the key — don't
paste its output anywhere). See `docs/reports/README.md` for what each does.
