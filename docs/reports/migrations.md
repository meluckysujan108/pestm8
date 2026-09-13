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
has no reader yet — it exists so that deleting a stored file can ask which report
still prints it, the same question `noteAttachments.by_storage` answers.

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

The cover carries one consequence to settle when it is adopted: it is a second
`<Page>`, so the footer's `Page N of M` will count it, and the first page of the
report body becomes "Page 2 of 3". `e2e/pdf.spec.ts` asserts that footer. Nothing is
affected today because no template declares a `cover` field, but Phase 2 must decide
whether a title page is numbered before it changes `serviceReport`.

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
