# Deploying the owner views

Two releases, and they deploy in **opposite orders**. Getting either one
backwards breaks something for someone in the field, silently.

| Release | Branch                                      | What it does                                                                                                                                      | Order              |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **A**   | `claude/owner-view-switching-access-c170ed` | The owner is on everyone's roster; job forms only offer who you can book; client book open to all; certificates finalised by the person they name | **Frontend first** |
| **B**   | `claude/owner-view-dropdown` (on top of A)  | The view menu: God view / Just my jobs / someone's account                                                                                        | **Backend first**  |

Every production command below is prefixed with
`CONVEX_DEPLOYMENT=prod:rare-retriever-156`. Never pass `--prod` from a
worktree: `.env.local` there names a dev deployment, and `npx convex deploy`
resolves that to _its project's_ production. Check where a deploy will land
with `--dry-run` first — it prints the URL.

## Before either

0. **Deploy only what `main` already has, plus this.** Both branches were
   rebased onto `main` after the reports work (PR #9) landed; a backend
   deployed from a branch that predates it would take PR #9's functions away
   from a frontend that calls them. Before every `npx convex deploy`:
   ```bash
   git fetch origin && git merge-base --is-ancestor origin/main HEAD && git status --short
   ```
   must exit 0 with a clean tree. (Checked read-only on 2026-09-18:
   production already runs PR #9's backend — `deliveries`, `snippets`,
   `templateSettings`, `reports.list`/`search`/`counts` — so neither release
   ships reports code for the first time.)
1. **Target.** `CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex deploy --dry-run`
   must name `rare-retriever-156`. Anything else — stop.
2. **Snapshot.**
   `CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex export --include-file-storage --path ~/pestm8-pre-owner-views-<A|B>.zip`
3. **Vercel is current.** The newest _successful_ Vercel deployment must be
   the tip of `main`. If it lags, fix that first (CLAUDE.md).

## Release A — frontend first

Why: the old new-job form preselects the roster's first row, which is the
oldest member — the owner. Once the backend puts the owner on everyone's
roster, a subcontractor on the old build gets the owner preselected and every
booking is refused (non-owners may only book themselves). The new form only
offers people you may book, and defaults to you.

1. PR green → merge → wait for the Vercel build **of that commit** to go green.
2. Hard-reload the PWA on the owner's phone and the subcontractor's phone (iOS
   keeps the old shell otherwise). The backend also sorts each person's own
   row first as a backstop, so a phone that misses this books onto its holder
   rather than the owner — but do not rely on it.
3. From `main` itself (`git checkout --detach origin/main` after the merge),
   `CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex deploy`

A phone still on the old build that tries to finalise a certificate naming
someone else gets the old generic "could not finalise — try again" rather than
the new explanation. The fix is the same either way: name yourself in the
technician/inspector/installer fields, or hard-reload.

What changes for people the moment the backend lands:

- Everyone sees the owner by name — on the calendar, in @mentions, in the
  staff filter. Email, phone and licence numbers go only to the owner and to
  contractors; everyone sees their own.
- Every member sees every client, and can edit them (the owner's call: one
  business). Archiving a client is still owner/contractor only. The Team
  screen's "Can see all clients" toggle is gone; its stored value is inert.
- A timber pest inspection or termite certificate that **names anyone other
  than its writer** — as inspector, installer or certifying installer — cannot
  be finalised (`TECHNICIAN_NOT_SIGNER`). The writer names themselves in each,
  or the named person writes it. So a termite certificate with a different
  installer and certifying installer can no longer be finalised at all; if the
  business needs that, the rule has to be relaxed for the installer field.
  Old v1 reports, which have no inspector field, are unaffected.
- A draft report shows a subcontractor their teammates by name only; licence
  numbers and phones appear for people the report already names.

## Release B — backend first

Additive: a new `sessionViews` table, `views.*` functions, a new optional field
on `access.me`, and a second hourly cron. The old frontend never creates a view
row, so nothing about it changes.

1. Confirm Vercel's newest successful deployment is the tip of `main`
   (Release A's commit, at least).
2. Rebase the Release B branch on that `main` if it moved, get the PR green,
   and from that exact PR head commit (precondition 0 must pass):
   `CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex deploy`
3. Merge → wait for Vercel.

## After both

1. Read-only: the owner has no leftover legacy "view as" selection —
   ```bash
   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run --inline-query \
     'return (await ctx.db.query("memberships").collect()).filter(m => m.role === "owner" && m.viewingAsMembershipId).length'
   ```
   `0` expected. (Choosing any view in the new menu clears one anyway.)
2. **With the owner, on his phone:** open the menu beside the + and pick his
   own name ("Just my jobs"). The schedule title reads "My jobs". His desktop
   stays in God view — the choice is per sign-in, and signing out resets it.
3. **The owner enters his licence number** in Settings → Profile. He needs it
   to finalise his own certificates, and it is safe to have on file now:
   nobody else can finalise a certificate that names him.

## Rolling back

**Release A — backend first, then the frontend if needed.** The Release A
frontend works against the old backend by design. Never roll the frontend back
alone while the Release A backend is live: the old form would preselect the
now-visible owner for every subcontractor. Rolling the backend back re-hides
the owner and restores the "can see all clients" toggle's effect, with each
person's stored value exactly as it was.

**Release B — clear the views, then redeploy the previous backend.** Release
A's backend (`85d03a1`, `main` before #13 merged as `27ad9d0`) does not declare
`sessionViews` and has no `views:clearAll`, so the clearing has to happen while
Release B's backend is still live:

1. Clear every chosen view, then check it took:
   ```bash
   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run views:clearAll
   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run --inline-query \
     'return (await ctx.db.query("sessionViews").collect()).length'
   ```
   The second must print `0`. Skipped, the rows would sit unread in a table
   the old schema no longer lists — harmless while A is live, but the day B is
   redeployed they would quietly put those devices back into "Just my jobs".
2. Revert #13 on `main` (`git revert -m 1 27ad9d0`, through a PR), so that
   `main` and production agree and precondition 0 still holds, and deploy the
   backend from that revert commit. In a hurry, `git checkout --detach 85d03a1`
   and deploy from there instead.
3. Expect `No large indexes are deleted by this push`. The push drops
   `sessionViews.by_session` and `sessionViews.by_real`; the CLI only stops to
   ask about deleting indexes on large tables, and this one is empty. The empty
   table itself stays behind, undeclared, which Convex allows — tables outside
   the schema are simply not validated.

The order of frontend and backend does not matter for this rollback. The view
menu renders only when `access.me` reports a view, which Release A's backend
never does, so Release B's frontend on Release A's backend shows no menu and
calls nothing that is missing.

If only the **frontend** is rolled back, clear the views first (step 1), or a
phone left in "Just my jobs" stays narrowed with no menu to undo it.
`views:clearAll` returns how many it deleted and touches nothing else. The escape hatch in
the field is Settings → Profile → Sign out, then sign back in: a view belongs
to one sign-in.
