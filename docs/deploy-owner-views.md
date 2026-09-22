# Deploying the owner views

Three releases, and they do not all deploy in the same order. Getting one
backwards breaks something for someone in the field, silently.

| Release | Branch                                      | What it does                                                                                                                                      | Order              |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **A**   | `claude/owner-view-switching-access-c170ed` | The owner is on everyone's roster; job forms only offer who you can book; client book open to all; certificates finalised by the person they name | **Frontend first** |
| **B**   | `claude/owner-view-dropdown` (on top of A)  | The view menu: God view / Just my jobs / someone's account                                                                                        | **Backend first**  |
| **C**   | `claude/write-as-actor` (on top of B)       | Jobs, series and reports written inside someone's account act as that account, are recorded as on its behalf, and stop at the switch's 12 hours   | **Frontend first** |

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
   `CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex export --include-file-storage --path ~/pestm8-pre-owner-views-<A|B|C>.zip`
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

## Release C — frontend first

Function behaviour only: no schema change, no argument changes. Two queries
gain a field — `memberships.listForBusiness` rows carry `bookable`, and
`auditLog.forEntity` rows carry `onBehalfOfName` — and the Release C frontend
reads both as optional. Without `bookable` its pickers fall back to the rule
the older backend enforces (`canBookOnto`: owner onto anyone, everyone else
onto themselves), so it is correct against the old backend and the new one.

Why frontend first: the old pickers offer by that older rule on the REAL
person. Once the backend decides on the account being worked in, an owner
inside Kevin's account on the old build is still offered everyone, and every
booking onto anyone but Kevin is refused with a bare error. (The form defaults
to Kevin, so only a deliberate change of assignee hits it.)

And a second reason. Writes now fail closed on a switch that has died — a
revoked grant, a team move — where they used to ignore switches entirely. The
Release C banner closes such a switch the moment it sees one. An older build
only says "you are back in your own account", while every booking and report
save refuses (`SWITCH_REVOKED`, `SWITCH_TEAM_CHANGED`) until the row's 12 hours
are up. The escape on an old build is Settings → Profile → Sign out and back
in: a switch belongs to one sign-in.

The Release C builder also starts sending `base` with each autosave, which the
production backend has accepted since PR #9, so that half is safe in either
order.

1. Release B's backend **and** frontend are live (Vercel's newest successful
   deployment is B's merge commit or later).
2. **Read-only**, to know what the switch has already written under the old
   rules — reports it attributed to the owner rather than the account:
   ```bash
   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run --inline-query \
     'return (await ctx.db.query("auditLog").collect()).filter(r => r.action === "switch.start").length'
   ```
   `0` means nobody has ever switched, and there is nothing to think about.
   Otherwise, reports the owner wrote while switched stay his (Kevin never
   sees them); that is unchanged by this release, and nothing rewrites them.
3. PR green → merge → wait for the Vercel build **of that commit** to go
   green. Hard-reload the owner's phone.
4. From `main` itself (precondition 0 must pass),
   `CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex deploy`

What changes for people the moment the backend lands:

- **Inside someone's account, the owner has that account's reach, not his
  own.** He books and moves work only onto that person, edits only their jobs,
  series and drafts, and bins only their drafts. To dispatch anyone else he
  switches back. The pickers show exactly that.
- **A report he starts inside Kevin's account is Kevin's**: in Kevin's list,
  finishable by Kevin, and still editable by the owner while he is in there.
  It used to be the owner's, and vanished from Kevin's account.
- **Everything he writes there is on record as done on Kevin's behalf** — an
  audit row per job/series change and per draft binned or restored, and one
  per report per switch for its edits. A report's Activity tab reads
  "Terence, in Kevin's account".
- **The owner, as himself, may edit anyone's draft** (`canEditReport`'s owner
  rule; it used to be the author only). The report's Activity tab records it
  once a day as "Edited by the owner". He may finalise their service reports,
  but **not a regulated certificate** — timber pest, termite, treatment record
  or a custom form: only the person whose licence it prints can
  (`HOLDER_MUST_FINALISE`). A phone on an older build shows the generic "could
  not finalise" message for that refusal.
- **A certificate's technician signature must be its holder's own.** Whoever
  may edit a draft may sign on it, so the owner or a helper can take the
  client's acknowledgement — but a technician's line drawn from someone else's
  sign-in blocks finalising (`HOLDER_MUST_SIGN`) until the holder signs it
  again themselves.
- **Two people on one draft keep each other's answers** (frontend). Autosave
  merges per answer instead of replacing the draft; the same answer changed
  two ways says so and asks for a reload. Finalising still sends the
  finaliser's screen whole: **if someone else has edited a draft since you
  opened it, reload before finalising**, or their changes are overwritten.
- **Corrections follow the same reach.** Inside someone's account he may
  correct and reissue that account's finalised reports (`amend` decides on the
  account being worked in); a regulated certificate among them is still
  finalised only by its holder (`SWITCHED_REGULATED`, `HOLDER_MUST_FINALISE`,
  `HOLDER_MUST_SIGN`), and a correction never carries the original's
  signatures over.
- **A contractor books onto their own team**, and edits and stops their team's
  jobs and series. (Previously owner-or-yourself.)
- **A switch past its 12 hours writes nothing** — booking, editing or filling
  a report refuses with `SWITCH_EXPIRED` until they switch back or start
  again. Reads catch up within the hour, when the sweep removes the row.

## After A and B

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

**Release C — backend first, then the frontend if needed**, for Release A's
reason: the Release C frontend works against the older backend by design, but
the Release B frontend against the Release C backend offers a switched owner
people the server refuses. Rolling back is safe for the data: a report
written in someone's account stays authored by that account, and the older
backend treats it exactly like one they started themselves — theirs to edit,
nobody else's. The extra audit rows are only rows.

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
