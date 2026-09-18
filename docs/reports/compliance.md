# Compliance

What the law and the standards actually require of these three documents, what
the app does about each, and — just as important — what it deliberately does
not do.

The rule throughout: **a requirement never silently rewrites a form the
business has been issuing for years.** Where a standard wants something the
source form omits, it is offered as an option an owner turns on, and it is
listed here as an option rather than shipped as a surprise.

Nothing here is legal advice. It is a record of what was checked, against
which source, on the date the work was done, so the next person can re-check
it rather than re-derive it.

## Western Australia — Health (Pesticides) Regulations 2011

**Regulation 77** requires a licensed pest management technician to make a
record of each treatment. The Service Report carries every element:

| Required | Where it lives |
|---|---|
| Date of treatment | `serviceDate`, seeded from the job |
| Address treated | `siteAddress`, a `derived` field off the property record |
| Pesticide used, and its active constituent | The treatment table's `product` cell — the option list prints the active in brackets, as the source form does |
| Quantity applied | The `quantity` cell |
| Method of application | The `method` cell |
| Technician's name and licence | `technician` (a `member` field) prints `Name (Licence N)` |

**Retention.** The regulation wants records kept, and termite work kept
longer. Finalised reports are never deleted, in two places rather than one:
`requireDeletable` throws `REPORT_FINALISED` before a delete starts, and the
nightly `purgeExpired` *restores* a report that was finalised while sitting in
Recently Deleted rather than purging it on schedule. A stale-draft nudge
(`reports.staleDrafts`) surfaces work that was started and never issued,
because an unfinished draft is not a record.

**Flag-only — not built, deliberately.** Three things the regulation mentions
that the source form does not ask for, and which are therefore *not* added:

- A "parts of the place treated" list distinct from the treatment table.
- A licensed-versus-provisional distinction on the technician.
- A total quantity across all treatments.

Each would be a question the business has never asked its technicians. They
are recorded here so an owner can decide, not shipped.

## AS 4349.3 — Timber Pest Inspections

The Timber Pest Inspection Report reproduces the Pest M8 form, which is itself
written to AS 4349.3-2010 and the AEPMA code of practice. The standard's
structure — scope, limitations, findings, conducive conditions, the
inspector's details — is the form's own section order, so conformance here is
a property of the verbatim transcription rather than something the app adds.

**Flag-only.** Four things AS 4349.3 contemplates that this form does not
print:

- A positive "areas inspected" list. The `areas` field kind exists and can
  express it; no built-in declares one. Offered as an optional add-on section
  rather than inserted.
- Vendor / agent details, where an inspection is for a sale.
- The equipment used during the inspection.
- The **Pre-Inspection Agreement**, which the form's own text says is
  "attached to this Report". The app has no agreements table; a
  business-level agreement appendix is the natural home and is not built.

## NCC 3.4.3 and AS 3660.2 — the durable notice

AS 3660.2 requires a durable notice fixed in a prominent location recording
the system installed, the date, and when the next inspection falls due. The
Certificate asks whether one was fitted, where, and the inspection frequency —
all verbatim.

What the notice itself must *say* is regulated, and the app can generate a
preview of it (`durableNoticeText` + `DurableNoticePreview`). This is an
**app-labelled extra**, not part of the source form: it prints only for a
template that declares `features: ['durableNotice']`, and no built-in does.
Turning it on is an owner's choice about their own paperwork.

## SGARs — the APVMA suspension

The Service Report's next-visit list includes the verbatim option
`SGARS in compliance with the new 35 day ruling`.

The underlying fact: from **24 March 2026** the APVMA suspended second
generation anticoagulant rodenticide registrations and issued replacement
label instructions, including *"DO NOT use the product continuously for more
than 35 days without an evaluation."* `sgarFollowUp` watches for an SGAR
product (`meta.sgar` on the affected products) applied via bait stations and
surfaces the 35-day evaluation after the report is locked.

**Wording discipline.** The help text says "APVMA suspension with replacement
label instructions". It never says "ban" and never says "new legislation":
neither is true, and a technician repeating either to a client would be
passing on our error as their advice.

## Electronic signatures — Electronic Transactions Act 2011 (WA) s10

A signature is captured as a drawn image plus the signer's name and the date,
directly beneath the exact statement being agreed to. Stored with it: the
statement text, the template revision, the timestamp, and whether it was drawn
or reused.

Two consequences in the code:

- A saved signature is only ever applied by its owner —
  `reports.attachSignature` refuses `method: 'saved'` unless the image is the
  caller's own saved signature, and refuses any team member's saved signature
  under any label (`NOT_YOUR_SIGNATURE`). Reading a report returns what was
  signed and how, never the stored image's id, so the id is not handed out in
  the first place. Anything else is forgery with extra steps, however
  convenient.
- Hand-to-client mode shows the statement, the name and the pad, and nothing
  else, so a client is signing a thing they can read.

## Licence and registration numbers

These print because the source forms print them, and for no other reason. The
app makes no claim that a licence is current — it has no registry to check
against. A licence-expiry warning is listed as an option and is not built.

## Where each of these is asserted

| Claim | Test |
|---|---|
| The Service Report carries every reg 77 element | `src/lib/reportTemplates/fidelity.test.ts` (the strings) |
| A finalised report cannot be deleted | `e2e/reportsList.spec.ts` (`REPORT_FINALISED`), and `e2e/{photos,gallery,annotation}.spec.ts` for its attachments |
| A saved signature is owner-only | `e2e/signature.spec.ts` |
| The SGAR nudge fires only for an SGAR product via bait stations | `src/lib/reportTemplates/sgar.test.ts`, `e2e/reports.spec.ts` |
| The verbatim Certificate prints no durable notice | `e2e/reports.spec.ts`, `e2e/reportSnapshot.spec.ts`. Nothing yet tests the `features: ['durableNotice']` path, because no template declares it |
