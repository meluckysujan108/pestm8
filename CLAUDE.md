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

**`convex` is patched** (`patches/convex@1.45.0.patch`, listed under
`pnpm.patchedDependencies`): the browser client's `setConfig` restarts a
socket that a re-authentication left stopped. Without it, a sign-in hand-over
landing while the client fetched a fresh token froze the app on "Loading…"
until it was closed (Terence, 16 Oct 2026). The patch is keyed to 1.45.0, so
an upgrade of `convex` must re-make it with `pnpm patch` or show it is no
longer needed: the test "a sign-in handed over while the socket is stopped for
a fresh token still reopens it" in `src/lib/convexClient.test.ts` fails
without it.

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

When a phone "just hangs", read its own notes before guessing from the
server's logs, which only ever show the server answering quickly:
`CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run diagnostics:recent '{"hours": 6, "email": "…"}'`.
Each phone notes coming back on screen, its socket opening, closing or being
given up and why, every sign-in token and how long it took, the "Could not
reach PestM8" notice and why, Try again and Reload (`src/lib/connectionLog.ts`,
`src/lib/socketWatch.ts`; kept thirty days, `convex/diagnostics.ts`).

Email goes through Resend from the verified domain `pestm8.com.au`, as two
senders on prod (`rare-retriever-156`):

- `RESEND_FROM_EMAIL=info@pestm8.com.au` — reports to customers
  (`convex/email.ts`); replies go to the business's own address. Every report
  email also carries a **bcc** to the business's own copy address (Settings →
  Reports → Business copy, else its business email). For Pest M8 Pest Control
  that is info@pestm8.com.au. A report whose PDF is over 6 MiB is attached as
  a lighter copy with smaller photos (`convex/emailCopy.ts`, since 30 Sept
  2026); `npx convex run emailCopy:dryRun '{"reportId": "…"}'` shows what a
  report's copy would be without sending anything.
- `RESEND_ACCOUNT_FROM_EMAIL=noreply@pestm8.com.au` — account email: the
  "Forgot password?" link, "your password was changed" and "Xero is
  connected" (`convex/accountEmails.ts`). Replies aren't read, and the email
  says so. Without it, `/forgot-password` still answers normally but nothing
  is sent (a warning is logged).

No email asks anyone to reply or write in — not "Reply to this email if…",
not "Need help? Email…" (removed 29 Sept 2026 at the product owner's
request: every question it invites is work for the business). A report
email can still be answered with the Reply button, and that reaches the
business's own address; nothing in it asks for one.

Until 2026-09-27 prod sent from Resend's test sender `onboarding@resend.dev`,
which only delivers to the Resend account owner. Every other deployment (dev,
e2e) has no key, so emailing a report there throws `EMAIL_NOT_CONFIGURED` by
design. `RESEND_WEBHOOK_SECRET` is only useful once a webhook for
`https://rare-retriever-156.convex.site/resend/webhook` is registered in
Resend; without it `POST /resend/webhook` answers 404 and a delivery's status
stops at "sent".

`RESEND_FROM_EMAIL` is required rather than optional — Resend rejects a `from`
that is a bare display name. Set it to a **bare address** (`x@domain`), never
`Name <x@domain>`: `convex/email.ts` wraps it as `${sender} <${fromEmail}>`,
so brackets in the variable produce a malformed `from`. Check what a
deployment has with `npx convex env list --prod` (it prints the key — don't
paste its output anywhere). See `docs/reports/README.md` for what each does.

Xero (the business's and each member's own organisation, contacts only so
far; `docs/xero.md`) uses **a separate Xero app per deployment**: "PestM8" on
prod (`rare-retriever-156`, redirect
`https://rare-retriever-156.convex.site/xero/callback`) and "PestM8 Dev" on
dev (`acoustic-schnauzer-237`). Never one app for both: Xero issues one token
set per Xero user and app, so a connect on dev would supersede prod's tokens
for the same Xero login. Each deployment takes:

- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` — its own app's.
- `XERO_TOKEN_KEYS` — `1:<key>` from `openssl rand -base64 32`, its own per
  deployment, never `BETTER_AUTH_SECRET`; a new key goes in front
  (`2:<new>,1:<old>`). Keep it in a password manager: losing it means
  everyone reconnects.
- optional `XERO_REDIRECT_URI` — only for a local backend, which Xero must
  know as `http://localhost:3211/xero/callback` (it refuses 127.0.0.1);
  otherwise it is `CONVEX_SITE_URL/xero/callback`.
- optional `XERO_SYNC_PAUSED=on` — the kill switch: nothing is written to
  Xero, and changes wait.
- optional `XERO_MAX_ORGS` — distinct organisations across every business,
  default 5 (Xero's free Starter tier); 50 once on Core.
- optional `XERO_TWO_STEP_REQUIRED=on` — connecting needs two-step sign-in
  on the account. Off by default since 1 Nov 2026: instead, a connect emails
  whoever's account did it, and the owner when a member connects their own
  (from `RESEND_ACCOUNT_FROM_EMAIL`).

Without the first three, a deployment is "not set up for Xero": Settings has
no Xero rows, Connect throws `XERO_NOT_CONFIGURED` and `/xero/callback`
answers 404. The e2e deployment has none **on purpose** — its spec checks
those screens. Confirm the target deployment before any
`npx convex env set XERO_*` (see the duplicate project above), and never paste
`npx convex env list` output anywhere: it prints the secret and the key.
