# Report migrations

One page per migration, in the order they must run. The runbook that matters lives
in the migration file's own header comment; this is the map and the reasoning.

## Why a signed report needs its own copy of its template

Until Phase 1, a finalised report rendered from the live template module. That was
safe for exactly one reason, stated in `convex/reports.ts` at the time: *"Undefined
for a built-in template, whose 4 `.ts` files never change."*

The word-for-word rewrite changes all four. Without a snapshot, correcting
`Chemical Aplication Method` to `Application` would alter what a document signed
last year says — retroactively, invisibly, on a legal record. Custom templates have
been snapshotted since the feature shipped, because a business could edit one at any
time. Built-ins were the exception, and the exception has expired.

## `reportSnapshotsV1` — snapshot safety

`convex/migrations/reportSnapshotsV1.ts`. Two backfills and an invariant query.

| Step | What | Command |
|---|---|---|
| Expand | Adds `reportTemplateSnapshots`, `reports.templateSnapshotId`, `reports.templateVersion`, `reportPhotos.by_storage` | `npx convex deploy` |
| Migrate | Stamps a revision on every report | `npx convex run migrations/reportSnapshotsV1:backfillTemplateVersion '{"cursor":null}'` |
| Migrate | Freezes every finalised report's wording | `npx convex run migrations/reportSnapshotsV1:backfillSnapshots '{"cursor":null}'` |
| Verify | Must report two zeros | `npx convex run migrations/reportSnapshotsV1:invariant` |

Repeat each with `--prod`. Confirm `--prod` resolves to the intended deployment
first: `.env.local` points at dev.

### No schema loosening, and no `--typecheck disable`

`notesV2.ts` needed both, and its runbook is the precedent everyone will copy. This
migration needs neither, and that is worth saying out loud so the ritual does not get
carried over. Every change here is a new table, a new index, or an optional field, so
no existing row can fail validation on the expand push.

The reason `notesV2` needed the loosening was that it made *required* fields exist
that old rows did not have. Nothing here does.

One caveat on the new index. `reportPhotos.by_storage` was added unstaged, which is
correct at dev's 124 rows. Convex's guidance is to add an index on a large populated
table with `staged: true` and enable it afterwards, so check the prod row count first
(`npx convex data reportPhotos --prod`) and stage it if the table is large. The index
exists so that deleting a stored file can ask which gallery row still holds it,
the same question `noteAttachments.by_storage` answers — necessary for a future
storage sweep, but not sufficient on its own (see Deleting a report).

### The ordering rule — and why it no longer bites

As first written, the backfill froze whatever the current modules said, so it had to
run on every deployment before the rewritten templates merged. Run afterwards, it
would have written the new prose into old reports' snapshots with nothing able to
tell.

Phase 2 removed that hazard rather than documenting it. The v1 modules are kept
byte-for-byte in `src/lib/reportTemplates/legacy/`, and the backfill and `finalise`
both freeze `templateFor(report.template, report.templateVersion)` — the revision the
report was written against. A pre-existing report has no revision, which means v1, so
production's backfill freezes v1 wording whether it runs before or after the rewrite
ships.

`src/lib/reportTemplates/seam.test.ts` pins the canonical hash of each v1 template to
the row already on dev. Production's backfill must mint those same rows, and any edit
that reaches the v1 wording fails that test first.

### Results on dev

Run 2026-09-12 against `dev:acoustic-schnauzer-237`, then again after a full e2e pass.

| | After backfill | After 90 more reports |
|---|---|---|
| Reports | 1571 | 1661 |
| Finalised | 952 | 1014 |
| Finalised without a snapshot | 0 | 0 |
| Reports without a version | 0 | 0 |
| Snapshot rows | 7 | 7 |

The snapshot count is the number to watch, and the second column is the evidence that
matters: 62 further reports were finalised through the live `finalise` path and added
**no** new rows. Four of the seven are the built-ins, one each; three are distinct
custom-template shapes. A count that climbs with every finalise would mean the
canonical serialisation is not stable and deduplication has quietly stopped working —
which is also the failure that would let two identical templates disagree.

The invariant query is a single full scan rather than a paginated one, because Convex
permits only one paginated query per function and there is no index on `status`. That
is a deliberate trade: if it ever outgrows the read limit it throws, loudly, and the
operator splits the count. A gate that errors is safe. One that silently under-reports
would answer "zero missing" about a table it only half read, and that answer is the
permission to ship the rewrite.

### Results on prod

Run 2026-09-16 against `prod:rare-retriever-156`, straight after the deploy that
shipped Phases 1 and 2 together.

| | Before | After |
|---|---|---|
| Reports | 30 | 30 |
| Reports without a version | 30 | 0 |
| Finalised | 12 | 12 |
| Finalised without a snapshot | 12 | 0 |
| Snapshot rows | 0 | 5 |

The five rows are the four built-ins at revision 1 plus one custom shape. All four
built-in hashes equal the values pinned in `seam.test.ts`, which is the evidence that
matters: production froze the same v1 wording the tests describe, so the twelve
reports signed before the rewrite still print what they were signed with. Prod was
exported first to `~/pestm8-backups/prod-2026-09-13-before-reports-v2.zip`.

18 drafts stayed on revision 1 and were not touched. They offer "Switch to the new
form" (Service Report) or "Start again" (Timber, Certificate); five Treatment Record
drafts keep working on the retired form.

### Why by reference and not inline

Not the 1 MB document limit — the worst snapshot is about 12 KB, nowhere near it.

The reports table is roughly 760 KB in total. Inlining a ~10 KB service report onto
each of its 376 finalised rows alone would add about 3.9 MB, growing the table
fivefold, and every later patch to any of those rows would rewrite the whole snapshot
with it. Content-addressed, 921 finalised built-in reports share four rows.

Stated here because the naive fix — "12 KB is safely under 1 MB, let's inline it" — is
reasonable-sounding and wrong.

### Contract, later

Its own deploy pair, only once both deployments report zero.

- Tighten `templateVersion` to `v.number()`.
- Dropping `customTemplateSnapshot` needs its rows patched to `undefined` first, using
  the `field: undefined` + cast idiom from `notesV2.ts`.
- Leave `templateSnapshotId` optional permanently. Convex cannot express "required only
  when status is finalised" without splitting the table into a status-discriminated
  union, which is not worth it.
- Leave `photoIds` alone. It is a required array on every row, read by nothing, and
  removing it is three deploys and a full-table rewrite for no benefit.

## Deferred deliberately in Phase 1

Each of these is built and tested but not yet adopted by any template, so no existing
report renders differently. The vocabulary lands first; the templates use it in the
phase named.

| Capability | Ready | Adopted in |
|---|---|---|
| `cover` field kind, and its own landscape first page | Yes | Phase 2, when `serviceReport.coverPhoto` changes from `gallery` to `cover` |
| `Presented` variant `image`, for a printed signature | Yes | Phase 4, with the signature capture rebuild |
| `gps` `format: 'lines'` | Yes | Phase 2, per the source forms |
| `note` / `heading` static blocks | Yes | Phase 2 |
| `derived` record facts | Yes | Phase 3, which adds the technician name and job record the context cannot reach today |

The cover carried one consequence to settle when it was adopted: it is a second
`<Page>`, so the footer's `Page N of M` counts it, and the first page of the
report body is "Page 2 of 3". `e2e/pdf.spec.ts` asserts that footer.

**Settled, by default rather than by decision.** `serviceReport.ts` and
`timberPestInspection.ts` both declare a `cover` field, `CoverPage.tsx` renders
its own `<Page size="A4">`, and `layout.tsx` prints `Page N of M`
unconditionally — so the cover IS page 1 and the body starts at page 2. That is
the right answer (a client counting pages counts the one with the address on
it), but it was never written down until now.

The cover is also worth explaining on its own terms. A cover photo has never once rendered as a
cover: the PDF looks for a per-row `isCover` flag, that flag is only writable through
a star button, and the gallery control hides that button whenever a field holds one
photo — which is exactly what the service report's front-page photo declares. So the
new `cover` kind resolves by field kind and photo order instead, needs no backfill,
and is unaffected by the rows already stored with `isCover: false`.

## Phase 2 — the verbatim templates

Deploy C. Expand-only, like Phase 1: a plain deploy, no loosening.

| Adds | Why |
|---|---|
| `reportTemplateSnapshots.terms`, `.print`, `.features` | A verbatim template's warranty pages and header lines live outside its sections, and must be frozen with them |
| `reports.contextSnapshot` | The verbatim forms print the client's name, the site and the inspector's licence from records. Frozen at finalise, so renaming a client next year cannot rewrite a certificate signed this year |
| `reports.deletedAt` | "Start again" on a superseded Timber or Certificate draft hides the old draft without destroying its photos |
| `reports.by_business_status_template` index | An option rename walks a business's drafts only |
| `optionSets` table | A business's own product list and other vocabularies |
| `customReportTemplates.terms`, `.print` | A clone of a verbatim form keeps its warranty pages |

### Ship the frontend and backend together

The `CLAUDE.md` deploy notes on `main` apply with force here. After this deploy:

- `saveDraft` and `finalise` refuse a write to a v2 report from a client that does not
  declare the revision, with `TEMPLATE_VERSION_MISMATCH`. A frontend still on the old
  bundle can open v2 reports but cannot save them.
- `reports.create` refuses `treatmentRecord` with `TEMPLATE_RETIRED`, which the old
  picker still offers.

Both are the intended behaviour for a stale tab, and both would break every user if
the frontend lagged the backend. Confirm Vercel's newest successful build includes
this change before deploying the backend.

### Production, in order

1. `npx convex export --prod --path <file>.zip` — a snapshot first.
2. Check the row counts that decide whether the new indexes should be staged:
   `npx convex data reports --prod` and `npx convex data reportPhotos --prod`.
3. Deploy Phase 1 and Phase 2 together (`npx convex deploy`), with the frontend.
4. Run the Phase 1 backfills and the invariant, as above. Their order relative to this
   deploy no longer matters.
5. Existing drafts need nothing. A v1 Service Report draft offers "Switch to the new
   form"; a v1 Timber or Certificate draft offers "Start again". Neither is forced — a
   technician mid-job can still finish on the old form, and it finalises against the
   v1 wording.

### What is deliberately not backfilled

`contextSnapshot` on reports finalised before it existed. Stamping today's client name
onto a report signed last year as "what was signed" would be false provenance. Those
reports keep reading live records, which is what they have always done.

### Results on dev

After the Phase 2 e2e suite, `2026-09-13`:

| | |
|---|---|
| Finalised reports | 1246 |
| Finalised without a snapshot | 0 |
| Snapshot rows | 16 |

Each rewritten form has its v1 row plus one row per v2 revision that existed while
the suite ran: before `print.omitEmpty` was added, and — for the Certificate and the
Timber report — again after the review fixes that bound the licence rows to their
own member field and required the installer's signature. Every extra row is a real
content change made during development, not a duplicate. Across roughly forty
v2 reports finalised by the suite there are no duplicates, and the deeply nested notes
survived a real insert — `freezeTemplate` swallows a failed write so signing never
blocks, which is exactly why the zero above was checked rather than assumed.

### When the legacy modules can go

Only when production reports zero finalised rows without a snapshot AND no v1 drafts
remain on any deployment. Until then they serve the backfill, unmigrated signed
reports, and the schema a v1 draft is still validated against.

## Phase 3 — start and fill

Expand-only again: a plain deploy, no loosening, no backfill.

| Adds | Why |
|---|---|
| `reports.prefill` | Which answers the app worked out rather than read off a record, and when each was confirmed. Its own column because `data` is replaced wholesale on every autosave, so nothing server-managed can live inside it |
| `jobs.startedAt` | When work actually began, stamped the first time a job goes `inProgress`. A report's start time is then a fact rather than a guess at the booking |

Neither is required, and nothing existing needs rewriting: a report without
`prefill` has no suggestions to confirm, and a job without `startedAt` falls back to
the time it was booked for, marked as a suggestion.

### Ship the frontend and backend together

`finalise` now refuses an incomplete report (`REPORT_INCOMPLETE`). An older frontend
cannot produce one, since it validated the same rules itself — except for the two it
could not see (a signature image, a required photo), where the refusal is the point.
`reports.create` gained no arguments, so a stale client still creates reports; they
simply arrive unseeded.

Open drafts on production need nothing. They keep their answers, gain no suggestions,
and are validated on the rules of the revision they were written against.

## Phase 4 — signatures that record the act, not just the image

Expand-only. `reports.signatureSlots` accepts either a bare storage id or a
record carrying `signedAt`, `method`, and optionally `signedBy`, `statement`,
`templateVersion` and `capturedByMembershipId`; every reader goes through
`storageIdOf()`. `memberships.savedSignatureStorageId` is new and optional.

`migrations/signatureRecords.ts` converts the rows already stored, and is
honest about what it cannot recover: an old row knows only the image, so
`signedAt` comes from the report's own answers where the pad left one and
falls back to the report's creation, `method` is `drawn` because that is the
only way a signature could have been made then, and the rest is left absent
rather than invented. Run on dev 2026-09-16: 246 bare ids converted, 257
signatures, zero remaining.

Contract later, once prod also reports zero: drop the `v.id('_storage')` arm.

## Phase 4 — the document, and the pipeline that draws it

Expand-only; no backfill is owed, and nothing has to run before the deploy.

New optional columns: `businesses.tradingName` / `reportBrandName` / `website`
(each falls back to the one above it, so a business that never opens the
branding settings still prints a coherent header and title band);
`reports.pdfStatus` / `pdfRenderVersion` / `pdfGeneratedAt` /
`previewStorageId`; `reportPhotos` is unchanged. `reportPdfs` is a new
append-only table. `reportContextSnapshot` gains `business.brandName`,
`business.website` and `author.name` — all optional, so snapshots frozen
before this keep resolving, and a report finalised then prints no
`Submitted by:` line rather than a name taken from whoever holds that
membership row today.

**`printSpec` gained `termsBreak`, so `convex/schema.ts` had to be widened in
the same change.** That validator is closed and `freezeTemplate` swallows its
errors by design, so a `PrintSpec` addition that misses the schema stops every
finalise from freezing its wording — silently, with finalised reports then
rendering from whatever the live template says next month. The snapshot tests
catch it; the rule is that the two move together.

### Existing finalised reports re-render on next open

`RENDER_VERSION` is 2 and rows finalised before it read as 0, so the first
person to open an older report's PDF gets one drawn by the new painter. That
is the mechanism working: what a report SAYS is frozen in its template and
context snapshots and cannot change, while how it is drawn is deliberately
not. The superseded file stays in storage — it is what somebody was sent —
and the newly drawn one becomes the report's current pointer plus its first
`reportPdfs` row.

Worth knowing before the prod deploy: a client who asks for "the same PDF you
sent me in August" will be handed the same content in the new layout until
deliveries record which `reportPdfs` row they attached (Phase 5).

## Phase 5 — a library that can be paged, searched and emptied

Expand-only in the schema, but **this one has a backfill that must run**.

`reports` gains `updatedAt` and `searchText`, three indexes
(`by_business_updated`, `by_deletedAt`, and a `search` index over
`searchText`), and `reportDeliveries` arrives as a new table. `businesses`
gains `reportCopyEmail` and `allowTechnicianRecipients`.

Both new report columns are optional, and absent values are NOT harmless:
`undefined` sorts below every number on `by_business_updated`, so an
unbackfilled report sits at the bottom of a descending list forever, and one
with no `searchText` cannot be found at all.
`migrations/reportsLibrary.ts` carries the runbook — snapshot production
first, run `backfill`, then `invariant` must report `withoutUpdatedAt: 0` and
`withoutSearchText: 0`. Run on dev 2026-09-17: 3725 reports, both zero.

`updatedAt` is backfilled to `finalisedAt ?? createdAt`, the closest true
thing available — nothing recorded when a draft was last edited, and stamping
"now" would shuffle a business's entire history to the top of its own list on
the day the migration ran.

### Deleting a report

Only a draft can be deleted, and only into Recently Deleted. A finalised
report is a record the business is required to keep — three years under WA's
pesticide regulations, ten where a termite certificate is involved — so
`softDelete` refuses one outright, and the nightly purge restores rather than
destroys anything that was finalised while sitting in the trash. The purge
cron (`0 19 * * *` for notes, `20 19 * * *` for reports) deletes a draft's
rows and its server-rendered preview, and **no other stored file**. A draft's
photo and signature ids arrive from the client, and the same blob can sit
under other reports — an amendment's photos share the original's files, and a
technician's saved signature is one blob reused on every report they sign — in
places that are not indexed by storage id. A reference check over
`reportPhotos.by_storage` alone therefore proved nothing, and an earlier purge
that trusted it could delete the signature from finalised certificates.
Orphaned draft files cost kilobytes; reclaiming them needs a sweep that checks
every reference, which is not built.

## The v2 templates changed after v2 shipped, and were not bumped to v3

Production deployed Phases 1 and 2 together on 2026-09-16, so the v2 verbatim
templates have been live there since. Phases 3-7 then changed all three
template modules **without bumping `version`**, which is exactly the thing
`types.ts` warns about: "a wording change that forgets to bump this is
indistinguishable from no change at all."

This was checked rather than assumed, and the decision is to leave them at 2.

**What actually changed in the three modules after v2 shipped.** Filtering the
branch diff to things that reach a document: `semantic` markers
(`sendCopyToClient`, `startTime`, `finishTime`, `weather`, `safetyGate`,
`emailTo`), `quick: 'allYes'`, `summary`, `width`, `carryOver`, `auto`, and
`print.termsBreak`. None of those is wording — they are what a question MEANS
to the app, which answers it reads back on the finalise sheet, and how it
prints. Two signature `statement` strings were added (the Certificate's
installer certification and client acknowledgment, and the Timber report's
client acceptance). Those ARE printed wording.

**Who it could reach.** Only a draft written against v2 and not yet signed —
a finalised report renders from its own frozen snapshot and cannot move.
Production, read on 2026-09-17:

```
v1-draft 18 · v1-finalised 12 · v2-draft 2 · total 32
```

Both v2 drafts are `timberPestInspection`, zero signatures between them, zero
and one day old. The only wording they gain is the client acceptance statement
above a pad nobody has signed yet — a statement the source form has and the
app was missing.

**So: no bump.** Going to v3 would push those two drafts through the
"switch or start again" path, and keep a v2 legacy module alive forever, in
order to protect two unsigned drafts from a correction that improves them. The
rule the bump exists for — never retroactively change what somebody signed —
is not engaged, because nobody has signed.

Re-check this before the NEXT deploy rather than trusting it: the query above
is one line, and the answer changes as soon as a v2 report is finalised on
production.

## Phase 6 — what the business owns

Five schema changes, **all expand-only**: new optional columns and two new
tables. There is no backfill and no invariant to check, because every absent
value already reads as the right default — no starred options, no remembered
answers, no saved phrases, no policy.

| Change | Table | Absent means |
|---|---|---|
| `options[].usual` | `optionSets` | not one of the usual few |
| `archived` | `optionSets` | nothing withdrawn |
| `reportPrefs.recent` | `memberships` | this member has no habits yet |
| `requireReportToComplete` | `businesses` | the policy is off |
| `reportSnippets` (new table) | — | no saved phrases |
| `templateSettings` (new table, Phase 5) | — | the form's own wording |

Deploy is a single `npx convex deploy`. Nothing to run afterwards.

Two bounds are worth knowing before the table grows:

- `reportSnippets` is capped at 200 rows per business **on save**, and
  `snippets.list` reads exactly that many. The two numbers are the same
  constant on purpose: a phrase saved past the read window would be accepted
  and then invisible to everybody.
- `memberships.reportPrefs.recent` holds at most five values per option-set
  key over nineteen keys, written only when a picker closes on a changed
  answer. It cannot grow with use.

## Phase 7 — saving a form and issuing one

Expand-only again: `customReportTemplates` gains `draft`, `publishedVersion`,
`publishedAt` and `updatedByMembershipId`, and `customReportTemplateVersions`
is new.

**No backfill is needed, and that is by construction.** The published content
stays in the columns it has always been in (`sections`, `boilerplate`, and the
rest), so every existing row is already a published v1 and every existing
reader keeps working untouched. `publishedVersion` absent means 1.

The one thing to know: `draft.sections` is stored as `v.any()` and is
**deliberately not validated on write**. A form halfway through being edited is
not a valid form, and refusing to save it is what made the old editor report
"check your connection" about a connection that was fine. `publish` is where
the shape is checked.

`reports` also gains `version`, `supersedesReportId`, `supersededByReportId`
and `amendmentReason`, all optional. `version` absent means 1, which is what
every report issued before amendments existed was; `finalise` stamps it from
now on. No backfill: a report with no `version` and no supersede links is a
first issue that was never corrected, which is the truth about all of them.

### Contract, later

Once no deployment holds a pre-Phase-7 row that was written by the old editor:

- Nothing to tighten. `draft` is optional by design, and `publishedVersion`
  stays optional for the same reason `templateSnapshotId` does — Convex cannot
  express "required only for rows created after a date".
