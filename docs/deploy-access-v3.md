# Deploying the access model

The branch changes who can see and do what, over rows that already exist in
production. It is an **expand → migrate → contract** change (CLAUDE.md), and
only the first two steps are in this PR.

Nothing here is optional. The code is safe; an out-of-order rollout is not.

## 0. Confirm the target — before anything else

`.env.local` in a fresh worktree has pointed at the empty duplicate project
before. Deploying there pushes to a backend no client reads, and the failure
is silent: the app keeps working, on the old code.

```bash
npx convex env list --prod | head -1 && grep CONVEX .env.local
```

Production is **`rare-retriever-156`** (team `sujan-neupane`, project
`pestm8`). If you see `joyous-otter-223` or `efficient-lemming-413`, stop.

## 1. Snapshot

```bash
npx convex export --prod --include-file-storage --path ~/pestm8-pre-accessv3.zip
```

This is the only rollback for the data. Step 6 depends on it existing.

## 2. Check Vercel is not already behind

`npx convex deploy` takes effect immediately; Vercel is a separate build that
may be hours stale or failing on a lockfile. Open the Vercel dashboard and
find the commit of the newest **successful** deployment. If it is not the tip
of `main`, fix that first — deploying the backend on top of a stale frontend
is how the notes rewrite broke prod.

## 3. Deploy the backend

```bash
npx convex deploy
```

Every column this adds is optional, and every new reader falls back to the
legacy columns, so the live PWA keeps working unchanged. Two things do not,
for the length of the window in step 4.

## 4. The invitation window — keep it short, and do not invite during it

Between this deploy and Vercel finishing its build, the old Team screen is
still in everyone's browser. Two functions it calls have deliberately stopped
working, because both were the invite hijack:

| Old call                       | Now                          | What the owner sees                                                                                               |
| ------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `memberships.inviteByEmail`    | throws `APP_UPDATE_REQUIRED` | **Nothing.** That screen has no error handler. The button appears to work; the email field simply does not clear. |
| `memberships.claimInvitations` | returns `[]`                 | Nothing — `/` routes off `businesses.listForUser`, so existing members are unaffected.                            |

So: **do not invite anyone between steps 3 and 5.** An invitation sent in the
window is not sent, and nothing says so. Existing members are not affected at
all; they keep working through the window.

The silence cannot be fixed from the backend — it is the _old_ build that
discards the error — which is why this is a runbook line and not a code change.

## 5. Ship the frontend

Merge to `main` and wait for Vercel to go green. Hard-reload the PWA once
(iOS keeps the old shell otherwise). From here `inviteByEmail` is gone from
the UI; invitations are single-use links from `invitations.create`.

## 6. Migrate

```bash
npx convex run migrations/accessV3:backfillMemberships '{"cursor":null}' --prod
```

Each batch schedules the next, so one command finishes the job. It writes only
where a field is absent, so it cannot overwrite a decision made in the new UI,
and it is safe to re-run. Verify:

```bash
npx convex run --prod --inline-query \
  'return (await ctx.db.query("memberships").collect()).filter(m => !m.grants).length'
```

Must be `0`. Rehearsed on a snapshot of real production data (4,557 rows):
**0 access changes, idempotent on a second run.**

## 7. Turn the doors on

```bash
npx convex env set AUTH_INVITE_ONLY on --prod
npx convex env set AUTH_RATE_LIMIT on --prod
```

Then confirm from a signed-out browser that `/login` still signs you in and
that sign-up without a token is refused.

## 8. Fill in the licence numbers — regulated finalises depend on it

Settings → Team, licence field on each member's row. A timber pest inspection
or termite management certificate **cannot be finalised** by someone whose
licence number is blank; the report now says which of the two people is
missing one rather than "it may already be locked".

`licenceExpiresOn` is optional and unknown reads as valid, so leaving expiry
blank locks nobody out.

## 9. Set the shape of the business

Still in Settings → Team, and all of it reversible:

1. Promote the contractors (`role` → Contractor).
2. Put each subcontractor under their contractor ("Works under").
3. Set the three toggles per person. Moving someone between teams clears their
   "access contractor's account" grant by construction — it named the
   contractor who granted it — so re-grant it after a move, not before.
   ("Can see all clients" was retired on 2026-09-18: the client book is open
   to everyone in the business. See `docs/deploy-owner-views.md`.)

## Rolling back

**Before step 6** — redeploy the previous backend commit. The new columns are
unread by the old code; nothing needs undoing.

**After step 6** — the migration only ever writes absent fields, so it has not
destroyed anything, but the old code reads `canViewAllJobs` and the new code
reads `grants`, and from here they can diverge. Roll the frontend back first,
then the backend, then reconcile from the step 1 snapshot if any toggle was
changed in the new UI in the meantime.

## What is deliberately not done yet

**CONTRACT** — dropping `canViewAllJobs`, `canViewOtherAccounts`,
`viewingAsMembershipId`, `grants.clientDirectory` (inert since the client
book opened to everyone) and `lib/access.ts`.

It is meant to be gated on telemetry rather than a date, and **that telemetry
does not exist yet**. There is no `__APP_BUILD__`, and no legacy function
counts its own callers, so today there is no way to answer the only question
that matters: has the last old PWA stopped calling these? An iPhone nobody has
reopened in three weeks is still a client.

So CONTRACT is blocked on building the gate first — a counter on each legacy
reader and a build identifier reported through `access.me` — not on waiting.
Dropping the columns before then is a guess, and the failure mode is
"nobody can see anyone else's schedule" on a Monday morning.
