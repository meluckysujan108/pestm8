# Reports

The compliance layer. A report is a form the business is legally required to
issue, filled in on a phone in someone's back garden and delivered as a
document a client keeps for years. Three things follow from that and explain
most of the design: the wording is not ours to change, the finished document is
immutable, and the technician's attention is the scarcest thing in the system.

Four companion pages:

| | |
|---|---|
| `fidelity.md` | what the three Pest M8 forms say, and why, clause by clause |
| `templates.md` | authoring a template: the kinds, the contract, publishing |
| `compliance.md` | what the law and the standards require, and what is deliberately not built |
| `migrations.md` | one page per migration, in the order they must run |

This file is how the machinery works.

## The shape of it

```
templates (data)  →  builder (fill)  →  finalise (freeze)  →  document (paint)
src/lib/            src/components/     convex/reports.ts     buildReportModel
reportTemplates/    reports/                                  ↓           ↓
                                                        ReportDocument  ReportPdf
```

A template is **data**, not code: `sections → fields`, each field a kind the
builder knows how to render and `present()` knows how to read back. Adding a
state-specific variant or a fourth document type is a new definition file, never
a change to the builder (ARCHITECTURE §5.3).

Four modules carry the rules, and everything else paints:

| Module | Owns |
| --- | --- |
| `visibility.ts` | which questions are being asked right now (`visibleWhen`) |
| `present.ts` | what one stored ANSWER reads as — codes to labels, dates to prose, a signature to its image |
| `documentModel.ts` | what the DOCUMENT is made of — sections, headings, blocks, cover, footer |
| `validate.ts` | whether it can be locked, in the same code the server runs |

`buildReportModel()` is pure and holds no React, so the Convex Node action, the
browser and a vitest all build the identical model. Both painters — the DOM one
in `ReportDocument.tsx` and the react-pdf one in `pdf/ReportPdf.tsx` — do
nothing but draw it. They used to decide these things separately, and two
painters agreeing by hand is how a PDF comes to disagree with the screen it was
approved on.

## Where answers come from

Never re-ask what the system knows — but always print it. Three classes, and
the difference matters on a document someone signs:

- **Bound** — printed from a record, never stored in `data`. The client's name
  and phone, the site address, the business block. A `derived` field. Live while
  it is a draft, frozen into `contextSnapshot` at finalise, so renaming a client
  next year does not rewrite a report issued this year.
- **Fact** — read off a record into `data` at create, then editable and printed
  as-is: the job's date, `jobs.startedAt`, the assigned technician, the first
  treatment row from the job type. Not marked, because asking a technician to
  confirm what their own client record says is a tax on being helpful.
- **Suggestion** — something the app worked out: the forecast weather, a booked
  start time, answers copied from the last visit. Carries
  `reports.prefill[key]`, renders as a dashed "Suggested" chip, blocks finalise
  until confirmed — and pressing `Next` on its section is the confirmation. A
  guess never prints under a signature.

`seedFromContext()` decides all of it, on the server, at create. The GPS field
is the one client-side exception: `auto` takes a reading when the question is
first shown, but only where the browser already holds a granted permission.

## What the business owns

The forms are reproduced word for word, which means their wording is not the
business's to change. Three things are — and each one is the difference
between a form that fits this business and one it works around.

**Option libraries** (`convex/optionSets.ts`, Settings › Reports). The
nineteen vocabularies the forms draw on: products, treatments, application
methods, what a next visit interval may say, how a building is described. An
owner adds, renames, reorders, stars the usual few, stops offering one, or
resets to the form's own list. Owner only: a vocabulary prints on every
technician's signed documents.

- **Renaming rewrites open drafts** in the same transaction, including inside
  repeater cells (`rewriteDraftsForRename`). Inline rather than scheduled,
  because renames chain — A→B then C→A — and jobs running out of order cannot
  tell an original A from a C renamed a moment ago.
- It is **best-effort against a technician editing that draft right now**;
  their next save carries the old word back. Said out loud in the settings
  copy rather than solved with a locking scheme a one-technician draft does
  not need.
- **Pinned values cannot be renamed.** A template that matches an option by
  value — a locked item, an exclusive one, an answer a `visibleWhen` tests —
  would have its behaviour changed, not its wording. `pinnedValues()` collects
  them from the built-ins *and* the business's own templates; the editor greys
  them rather than letting the mutation refuse afterwards. None of the three
  Pest M8 forms pins anything today: they print these lists and nothing more.
- Finalised reports are never touched. They carry their own frozen copy of
  every list inside `templateSnapshotId`.

**One policy** (`businesses.requireReportToComplete`, Settings › Reports) — a
job whose type has a form cannot be marked complete until its report is
*finalised*. Off by default, because it is a policy and not a fact: plenty of
jobs issue no report. A draft does not satisfy it — "there is a half-filled
draft somewhere" is the state it exists to catch — and a job type
`suggestTemplate` has no form for is never held up, because a quote visit
blocked at Complete is how a business learns to switch a policy off.

**Template settings** (`convex/templateSettings.ts`) — cover title and
subtitle, the footer's form name, and which signatures a report needs before
it can lock. That is the whole writable surface; email is not part of it. A
delivery's subject is computed per report (`deliveries.subjectFor`) and its
recipients come from the form's own semantics plus `businesses.reportCopyEmail`
— a business column, not a template one. Anything that would change a question
or an answer is on the other side of the line: a clone.

**Phrases** (`convex/snippets.ts`) — saved wording for the long-answer boxes,
of which the three forms have twenty-eight, twenty-three of them on the Timber
report alone. Any member may add one, which is the difference from an option library:
a library IS the answer, a controlled vocabulary printed as a chosen value, so
only an owner changes it; a phrase is a head start on an answer the technician
could type anyway. Tapping one **adds** it to what is written rather than
replacing it — the standard wording and the one thing that was different about
today are both wanted.

## Fewer taps the second time

Two mechanisms, both of which cost nothing to set up.

**What a picker offers first.** `optionSets.usual` unions the business's own
`usual` flags with `memberships.reportPrefs.recent[key]` — five deep, per
member, learned when a picker closes rather than on every tap — and the sheet
puts them under "Usually" above the rest of the list. Per member because the
list a rodent technician reaches for is not the termite crew's, and neither
should have to say so in Settings.

**Copy from last visit.** `reports.lastAtProperty` reads the 40 newest reports
at the address, keeps the ones `canCarryFrom` allows — finalised, not deleted,
the same form AND the same revision of it — and ranks those by when they were
*signed* rather than started. The overview then offers what is still worth
taking, by name.

The bound is applied before the filter, so at a site with weekly service
reports an annual inspection can fall outside the window and simply not be
offered. Narrowing it wants a `by_property_template` index, which is a staged
index on a populated table and therefore a deploy of its own.

The revision check is the one that matters for correctness: a report signed
before the verbatim rewrite holds v1's strings, and carrying those into a v2
draft would put answers in no list the form offers onto a document somebody
signs. The
form decides what may be carried: a field says `carryOver` when its answer is
about the PLACE — what gets treated, what was found, how the house is built —
and stays silent when it is about the DAY. Dates, times, weather, GPS,
comments, photos and signatures are never carried, because a stale one under a
signature is worse than a blank: a blank reads as unanswered, "Sunny, 9:15 am"
reads as observed.

Everything copied lands as a `lastVisit` suggestion, so it is still confirmed
before it prints, and nothing is copied over an answer already given. The
mutation hands the patch back as well as writing it — the builder holds the
answers in its own state and autosaves them wholesale, so a patch it does not
know about is one its next save erases — and the builder flushes immediately,
or the copy sits in the draft mirror and greets the technician with a restore
prompt.

## Finalising

`reports.finalise` is the only one-way door in the app.

1. Re-validates everything the browser validated, in the same `validateReport`,
   and refuses with `REPORT_INCOMPLETE` carrying the issue paths.
2. Freezes the wording: the resolved template is content-hashed into
   `reportTemplateSnapshots` and referenced by `templateSnapshotId`. Reports
   finalised against identical wording share one row.
3. Freezes the records into `contextSnapshot`, including the business's names
   and logo.
4. Allocates `reportNumber` from `businesses.nextReportNumber` — at finalise,
   not at create, so a draft abandoned in a van does not burn a number from a
   sequence a client may quote back.
5. Schedules `reportPipeline.afterFinalise`.

Afterwards the report renders **only** from its own snapshots. A finalised
report is never edited.

## Correcting one

`reports.amend` is how a mistake on a signed document gets fixed: it issues a
NEW report carrying the **same `reportNumber` at the next `version`**, and
marks the original `supersededByReportId`. Both ends say so on screen — the
replaced one so nobody works from it, the replacement so its reason travels
with it rather than sitting in an audit log nobody reads. The footer's
`Version:` line is what tells the two apart on paper.

The answers come forward so the correction is the edit rather than the whole
form again. Three things deliberately do not:

- **The signature.** It was applied to a specific document, and moving it to a
  different one is forgery with extra steps. The amendment is signed again —
  which also means it cannot be locked until somebody does.
- **The lock.** An amendment starts as a draft and is finalised like anything
  else. Amending never unlocks the original.
- **The deliveries.** What the client was sent stays sent; re-sending is a
  decision about the new document.

Photographs *are* carried: they are evidence of what was on site that day, and
the day has not changed. The rows are new and point at the same stored files,
which the purge's `by_storage` check already understands.

A report that has already been superseded cannot be amended again
(`ALREADY_SUPERSEDED`) — that would fork one number into two live documents.
Amend the current version instead.

## Drawing the PDF

`reportPipeline.renderIfNeeded()` is the single path, and every caller goes
through it: the pipeline scheduled at finalise, the PDF tab, a download, an
email send.

- `internal.reports.claimPdf` takes the job, or reports that the file is
  already current, or that someone else holds it. A caller who arrives while a
  render runs waits for it — tapping Download a second after Finalise is the
  normal case. A claim that never settles goes stale after five minutes.
- Every rendered file becomes a `reportPdfs` row with the renderer and template
  version that drew it. Superseded files are kept: a client emailed a report in
  August must still be shown the file they were actually sent.
- `RENDER_VERSION` in `convex/reports.ts` is the painter's version. Bumping it
  re-renders every report on its next open, which is how a fix to the document
  reaches files already drawn.
- A scheduled action runs with **no identity**, so it reads through
  `internal.reports.getForRender` and `photosForRender` rather than the public
  queries, which would refuse it.
- A draft can be rendered too, through `reportPdf.preview`: the same document
  stamped `DRAFT` on every page, one per report, deleted the moment the real
  one exists.

## The page

The anatomy `fidelity.md` refers to, matching the document the client already
receives. Layout differences from the vendor's output are logged in that file's
**Layout decisions** table.

**Cover** (`pdf/CoverPage.tsx`) — a portrait page, the landscape front-page
photo banded across the top ~46%, a white wave cut through it with a grey
trailing curve, the logo, then a red rule, the form's title at 38pt, a second
red rule, the subtitle, the full site address and the date the form records. No
photo: the band is a red gradient rather than half a page of white.
`objectFit: cover` here and only here — this is a designed band, not evidence.

**Every body page** (`pdf/layout.tsx`) — the logo left and the business block
right, both `fixed`; at the foot, the form name and `Page N of M` over a 1.5pt
red rule, then `Submitted by: … @ 11:35:53 28 Aug 2026`, `Version:` and
`Submission ID:`. Those three labels are the source form's, over PestM8's own
values.

**First body page** — a solid red title band, `{brand} {form name} for {year}`
with the document's date fenced off at its right end. The AS forms print their
own header lines and standards reference instead; a band above them would say
the same thing twice.

**Sections** — red 15pt headings in the form's own case, red bold sub-headings
for a `heading` block, notes in a hairline-left inset (`important` gets a red
rule and a bold `IMPORTANT:`; `statement` is set in Helvetica-Oblique). Nothing
forces a page break except the terms: the vendor's per-section breaks left pages
two-thirds blank.

**Answers** (`pdf/tables.tsx`) — a 38/62 split, the label column tinted
`#FFF2F2`, dotted separators, each row `wrap={false}` so a label is never
orphaned from its answer. A toggle or choice whose template declares a flagged
answer gets a 5pt bar: green when it is not the flagged one, amber when it is,
red for `semantic: 'safetyGate'`. A repeater is lifted out of the row flow into
its own table with a red header row that repeats across a page break.

**Evidence** — photos at their own aspect inside a 240pt height cap, three to a
row for portrait sets and two for landscape, chunked in JS so a twelve-photo
set cannot be clipped off the page. Signatures print the drawn image with the
signer named beneath.

The plan had those column counts the other way round; the arithmetic decides
it. A 4:3 portrait at 3-up is 163.76 x 218.35pt and fits under the cap; at
2-up it would want 250 x 333, hit the 240 cap, and letterbox inside a box
taller than the picture.

**"Uncropped" is asserted, not assumed.** A centre-crop removes the very thing
a photo was taken to show, and it does it silently — nothing in the text layer
or the image count would notice. `ReportPdf.test.tsx` reads each drawn image's
CTM back out of the rendered PDF: a square source in a 163.76 x 218.35pt tile
is drawn at 163.76 under `objectFit: 'contain'` and at 218.35 under `'cover'`,
so the drawn width alone separates them. Flipping the property fails the test
at exactly that number.

**Rule 8** — a signed document omits what was never answered, and now also the
sub-heading left standing over nothing and the section left with nothing at
all. A draft still shows the em dash, because the technician needs to see what
is open.

### Two things react-pdf will catch you with

- `lineHeight` resolves against the font size **on its own style object**, and
  the default is 18pt. `{ lineHeight: 1.4 }` on a wrapper with no `fontSize`
  double-spaces every wrapped paragraph in the document. Always state them
  together.
- A `lineHeight` on `Page` itself breaks `fixed` + `position: absolute`, and the
  footer silently renders nothing. It lives on a body wrapper instead.

## Sending it

A send is a `reportDeliveries` row, written before the provider is called and
naming the `reportPdfs` row it attached. That is what makes "which file did the
client receive on 28 August?" answerable once the renderer has moved on.

- **Who it goes to** comes from the form, through the semantics rather than the
  labels: `sendCopyToClient` means the client's address, `emailTo` means
  whatever was typed into the form's own "Email Report To". `finalise` opens
  those deliveries in the same transaction that locks the report, and the
  render pipeline sends them once there is a file to attach.
- **Who may send where.** A technician may send to addresses already on the
  client record — the client, their contacts, the business itself. Anywhere
  else is `pendingApproval` until an owner says yes, unless the business sets
  `allowTechnicianRecipients`. The held row IS the request, so approving is a
  decision about something real rather than a send retyped from memory, and
  who asked and who allowed are kept as separate facts.
- **How many.** Twenty per member per hour, counted from the delivery rows
  themselves — they are already the exact record of every send, so a separate
  token bucket would be a second, less accurate account of the same events.
- **What "Sent" means.** That Resend accepted it. The webhook at
  `POST /resend/webhook` moves a row to `bounced` when it did not land, and
  clears the report's `emailedAt` if no other delivery of it survived — a
  report the client never received is not a sent one.

### Configuring it

Three environment variables, none of which are set on any deployment today, so
sending fails with `EMAIL_NOT_CONFIGURED` by design:

| Variable | What it is |
| --- | --- |
| `RESEND_API_KEY` | The business's own Resend key |
| `RESEND_FROM_EMAIL` | An address on a domain verified with Resend. Required, not optional: Resend rejects a `from` that is a bare display name, and the business's own address goes in `reply-to` |
| `RESEND_WEBHOOK_SECRET` | The `whsec_…` for the endpoint, registered in Resend against this deployment's `.site` origin |

Set them with `npx convex env set`, and confirm the deployment first —
`.env.local` points at dev.

The webhook signature is verified by hand (`convex/lib/svix.ts`) rather than
with the `svix` package: this runs in Convex's default runtime, where Web
Crypto is already there. The parts that are easy to get wrong — the timestamp
window in both directions, checking every offered signature rather than the
first so a secret rotation does not drop half the messages, a constant-time
compare — are the parts `svix.test.ts` exercises. That is the deal one makes by
not taking the library.

## Testing it

- `src/components/reports/pdf/ReportPdf.test.tsx` renders the real component
  through the real renderer under Node and reads the text layer back.
  `PDF_OUT=<dir> pnpm vitest run ReportPdf` writes the files out to look at.
- `src/lib/reportTemplates/fidelity.test.ts` compares every template string
  against the machine-extracted source corpus, both ways: nothing omitted,
  nothing invented.
- `seam.test.ts` pins the v1 snapshot hashes that finalised reports dereference.
- `e2e/pdf.spec.ts`, `reportPdf.spec.ts` and `reportSnapshot.spec.ts` assert the
  delivered file: its text, its cover, its images and its frozen wording.
- `e2e/optionSets.spec.ts` and `e2e/snippets.spec.ts` cover what the business
  owns, and `e2e/reportFill.spec.ts`'s "second visit" tests cover the return
  visit end to end. The access rules live in e2e rather than convex-test,
  which has no Better Auth component and so cannot answer "who is asking".
