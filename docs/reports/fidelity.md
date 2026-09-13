# Report fidelity: how the Pest M8 forms become templates

The three documents Pest M8 issues are reproduced **word for word**. This file is
the contract for that: where each string comes from, the handful of deliberate
corrections, the oddities kept verbatim, and the decisions that are about layout
rather than wording. `src/lib/reportTemplates/fidelity.test.ts` enforces it.

## Sources

| File                                       | What it is                                                      | Used for                                                        |
| ------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `docs/sources/service-report-spec.md`      | The owner's own data dictionary for the Service Report          | Option strings, control types                                   |
| `docs/sources/service-report-submitted.md` | The same form as submitted through Formitize                    | Form-only controls the PDF never shows                          |
| `docs/sources/timber-pest-inspection.md`   | Timber Pest Inspection Report (AS 4349.3-2010) — Warranty       | Everything                                                      |
| `docs/sources/termite-certificate.md`      | Existing Structure Certificate of Installation (AS 3660.2-2017) | Everything                                                      |
| The Formitize PDF of a real service report | What a client actually received                                 | Printed labels, punctuation, headings, and the §5 warranty text |

The client's name, address, phone, email, GPS and submission id are redacted from
the vendored copies. **The seven page renders are deliberately not vendored**: they
show a real client's house, signature and contact details, and the text layer plus
the page anatomy in `docs/reports/README.md` carry everything the build needs. The
original PDF stays with the owner.

## The corpus is extracted, not transcribed

`scripts/extract-form-strings.mjs` reads the sources and emits
`src/lib/reportTemplates/spec/*.generated.ts` — every heading, label, option, note
and printed line with a citation. The fidelity test compares the hand-authored
templates against that extraction.

This matters: a test that compares a hand-written template to a hand-written
fixture proves nothing, because a mis-transcribed apostrophe appears identically
on both sides and the test passes. One side has to be mechanical.

### What the test checks

`src/lib/reportTemplates/fidelity.test.ts` runs two checks per form.

- **A — nothing omitted.** Every extracted string is in the template, is a
  documented correction, or is listed in the template's `superseded` register with
  the precedence rule that superseded it. The register is the allowlist, so a string
  can only be dropped on the record.
- **B — nothing invented.** Every label, option, heading and paragraph the template
  shows or prints appears verbatim in the vendored source, or is a documented
  correction.

Test B reads the raw source text as well as the corpus. The extractor is a
best-effort parser of loosely structured markdown, and it misses some plain lines —
the Certificate's terms paragraphs, the `Add Row` / `Delete Row` line, a closing
quote. "It is written in the source document" is the property that matters, and
the raw text answers it directly.

The test was checked against deliberate mutations: a paraphrased option, a dropped
option and a one-letter typo in the terms each fail it, naming the source line.

It also asserts that every option stores the words it prints, that every string can
be printed in Helvetica's WinAnsi encoding, that keys are unique, and that every
visibility or attachment reference points at a real field.

Re-run it only when a source document changes, and review the diff:

```bash
node scripts/extract-form-strings.mjs --pdf="/path/to/the/service report.pdf"
```

## Precedence

When the sources disagree, in this order:

1. **Printed labels, headings and their punctuation come from the PDF** — what the
   client received. So `Date:`, `Client Phone:`, `Start Time:` and `Finish Time:`
   carry colons while `Client Name`, `Site Address`, `GPS Coordinates` and
   `Client Email` do not. The markdown files' `**Label:**` colons are markdown
   formatting, not wording.
2. **Option strings and control types come from the spec.** `Weather on the Day` is
   therefore multi-select, although the sample submission happened to show one value.
3. **Form-only controls come from the as-submitted form** — the things the PDF never
   shows because they drive behaviour rather than print: the front-page photo field,
   the send-a-copy toggle, `Safety & Compliance Checklists`, `Add Photos?`,
   `Email Report To` and its warning.
4. **The Service Report's warranty pages are canonical from the PDF.** Both markdown
   files paraphrase them; only the PDF has the real text.
5. **The Timber and Certificate forms have one source each**, the markdown.
6. Where both markdown files agree against the PDF on an apostrophe, case or full
   stop, the markdown wins, recorded below as a variant pick.
7. **The screen and the page can differ in framing, never in words.** The builder
   shows the numbered section titles from the source; the PDF prints the heading the
   client received (`Risk Assessment`, not `3. RISK ASSESSMENT`).
8. **Unanswered fields are omitted from the printed document**, as Formitize prints —
   the sample's page 4 shows no `Treatment Limitations` row because it was left blank.
   The on-screen draft shows `—` so the technician can see what is still open.
9. Where a label appears in only one markdown file and the PDF differs on
   punctuation, the PDF wins and the markdown reading is logged as considered.

## Corrections

The only edits to source wording. Each is asserted by the fidelity test: a template
string that differs from the corpus must be listed here, so an undocumented edit
cannot pass.

| Where                                  | Source                                         | Printed                                        | Why                                          |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| Service Report, treatment table header | `Chemical Aplication Method`                   | `Chemical Application Method`                  | Typo; the spec has it right                  |
| Service Report, section heading        | `Treatment ,Product(s) and Quantities Applied` | `Treatment, Product(s) and Quantities Applied` | Misplaced comma                              |
| Service Report, warranty heading       | `Pest Treatment,Wait Time, Expectations`       | `Pest Treatment, Wait Time, Expectations`      | Missing space                                |
| Product list                           | `Seclira WSG (400 g/kg DINOTEFURAN )`          | `…DINOTEFURAN)`                                | Stray space                                  |
| Product list                           | `Sumilarv IGR (20 g/L PYRIPROXYFEN )`          | `…PYRIPROXYFEN)`                               | Stray space                                  |
| Product list                           | `Couma (0.37 g/Kg COUMATETRALYL )`             | `…COUMATETRALYL)`                              | Stray space                                  |
| Warranty text                          | `Germancockroachesin`                          | `German cockroaches in`                        | Lost spaces in the vendor's HTML-to-PDF step |
| Warranty text                          | `throwingthe`                                  | `throwing the`                                 | Same                                         |
| Warranty text                          | `2ndtreatments`                                | `2nd treatments`                               | Same                                         |
| Certificate §3                         | `Linear metres $m$ or Area $m^2$`              | `Linear metres (m) or Area (m²)`               | LaTeX artefact in the source file            |

**Variant picks** — the sources disagree and we follow rule 6:

| Printed                                    | Source that lost           | Source that won     |
| ------------------------------------------ | -------------------------- | ------------------- |
| `Quantity of Chemicals Used`               | PDF `…Chemicals used`      | Both markdown files |
| `Technician's Comments`                    | PDF `Technicians Comments` | Both markdown files |
| `Chemicals locked up and stored after use` | PDF's trailing full stop   | Both markdown files |

## Kept verbatim, flagged for the owner

These read as mistakes but they are the business's own form wording, so they print
as-is. Each carries a `// FLAG:` comment in the template. They are collected here so
the owner can make one pass and decide; changing any of them is a template edit, not
a code change.

- `MSDS on site` — superseded by "SDS" under GHS since 2017.
- `SGARS in compliance with the new 35 day ruling` — "SGARs"; and see the note below
  on what the rule actually is.
- `Signage Displayed showing Chemicals being applied out Front`
- `House Keeping & Cleaning Recommendations to Help eliminate General Pests`
- `No Risk Safe Access Given`, `Client Gave Access away at time of Inspection`
- `g/Kg` and `6g/kg` in product strings; ALL-CAPS active constituents
- `IT DOES NOT WORK BY SMELL, otherwise, we will be affected.`
- `Pests have to come into Contact with the insecticide for them to die,` (trailing comma)
- `Living Across`, and `6 weeks` in lower case under Spiders only
- Timber §1 `for who the inspection is being undertaken` — "for whom"; the Certificate
  says "whom".
- Timber §1 `thirty (30) meters` — US spelling in an Australian standard document.
- Timber §6 `Licenced Builder`; Timber §7 `Minimize damage`.
- Timber §9: the client acknowledges "that the Property is free of Timber Pests and
  damage caused by Timber Pests". A client cannot agree to that, and the rest of the
  report is careful to say the opposite. **Raise before it prints under a signature.**
- Certificate §9 definitions say "This Plan" and cross-reference sections the
  Certificate does not contain (`Inspection Report`, `Inspection Agreement`,
  `Property Address`). The text was adapted from a Termite Management Plan.
- Certificate §9 `Purpose Of Termite Management Systems`, `Constructions issues and
faults:`, and `species in Australian including`.
- Certificate §9, noticed while authoring: `Neither the Installer nor the Installation
  company, are liable`, `the systems ability`, `the buildings sub-floor areas`,
  `A person licenced`, `manage them on behalf of owners`, `the disclosed Building Owner
  that instructed the Client`.
- Timber: the form title `…Inspection Report(AS4349.3-2010) - Warranty` is missing a
  space before the bracket. The template prints the sub-heading as the form name.

## Open with the owner

- **Which signature pad does the technician sign?** The form declares two,
  `Technician's Signature` and `Signature`. The sample's page 4 prints exactly one
  row, labelled `Signature`, directly under `Technician's Name`. Each pad prints
  under its own label when signed and is omitted when not, so the build does not
  depend on the answer — but the default required signer does.
- **The Timber form's Terms and Conditions.** Its §7 has a toggle that previews a
  terms body the source file does not contain. Until the owner exports it from
  Formitize form 24915944, the template prints the Certificate's §9 terms as an
  interim, recorded in its `validationNotes`.

Raised while authoring the verbatim templates. Each is a one-line template edit
once decided; none blocks shipping.

- **Timber §7 — which answers are "flagged".** They decide when each condition's
  guidance prints. Assumed: `Inadequate` on the drainage, ventilation, exposed-timber
  and ant-capping rows; `Yes` for Water Tanks, Water Leaks, High Moisture and Mould;
  `No` for Slab Edge Exposure and Weep Holes (`No weep holes located` is not flagged).
- **Timber §7 — the guidance column reads like a summary** (terse, "via", slashes,
  "Capture any additional custom conducive factors."). It prints verbatim; worth
  comparing against the live Formitize form.
- **Timber §5 — the Risk Notice** prints always, as on the source, even when no
  access was hindered. It could print only when an area was hindered.
- **Timber §2 — `Inspection Requested / Inspection Type requested`.** The data
  dictionary gives two names, so the printed label is unknown; the fixed value prints
  without one.
- **Timber §9 and Certificate §8 — who signs.** Timber prints the client's name from
  the record; the Certificate asks for a typed name, as its source says. If an agent
  or tenant can sign a Timber report, it needs the typed name too.
- **Certificate §3 — `System Type Installed`** is described as "Checkboxes / Radio"
  and is authored as a single choice, since `Combination System` covers several.
- **Service Report — `No Risk Safe Access Given` and `No Risk Property Empty`** could
  rule out the other risks when ticked. The source does not enforce it, so it is not
  applied.
- **Service Report — a treatment row** must now be complete or empty, including
  `Quantity of Chemicals Used`. An inspection-only row such as `Live Termites` with no
  quantity would need a decision.
- **Service Report — the `Email Report To` warning** is authored without the
  markdown's `Warning:` lead-in. Worth confirming against the live form.
- **Picker names** stay as the app had them (`Pest Service Report`, `Timber Pest
  Inspection`); the forms' own titles are longer. This is a picker label, not wording
  on the document.

## Layout decisions

Not wording — these are choices about the page, recorded so the difference from the
vendor's output is deliberate and reviewable.

| Decision              | The vendor's output                                             | Ours                             | Why                                                               |
| --------------------- | --------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| Page numbers          | `Page 2`                                                        | `Page 2 of 7`                    | A reader can tell whether a page is missing                       |
| Site address          | `12 Example Street Leda 6170 Western Australia Australia`       | Australia Post form              | The vendor concatenates every field including the country         |
| Treatment table cells | Comma-joined                                                    | One value per line               | Legible in a 30% column                                           |
| Photos                | 3-up, centre-cropped to portrait tiles                          | Natural aspect, max height       | A cropped photo can remove the thing it was taken to show         |
| Section pagination    | A hard page break per section, leaving pages two-thirds blank   | Sections flow                    |                                                                   |
| Cover                 | Title, subtitle, address                                        | Adds the service date            |                                                                   |
| Footer                | `Environment friendly, paperless solution by www.formitize.com` | Dropped                          | The operator's document carries the operator's name               |
| `Version:`            | Counts resubmissions                                            | Counts amendments                | We never mutate a finalised report; a correction is a new version |
| `Submission ID:`      | Formitize's global id                                           | The business's own report number | Same label, our sequence                                          |
| Unanswered questions  | Omitted                                                         | Omitted from the signed document; the draft shows `—` | Rule 8. The technician needs to see what is still open |
| Form-only controls    | Never printed                                                   | `printed: false`                 | The send-a-copy toggles, `Add Photos?`, `Email Report To` and its warning, and the `Safety & Compliance Checklists` sub-heading drive behaviour, not content. The Timber and Certificate forms are treated the same way as the Service Report, whose PDF shows it |
| Conducive-condition guidance (Timber §7) | Always printed                                 | Printed only when the row is flagged | The advice is noise on a clean inspection and the point of the report on a bad one |
| Hyphenation           | Words split across lines                                        | Off                              | Nothing is justified, so a ragged edge costs nothing; words, product names and addresses print whole |
| Client and site block | —                                                               | Not printed on a verbatim form   | The forms print those facts in their own first section; the app's block would repeat them |
| Photo sets            | Inside the finding they belong to                               | The same                         | Detached at the end, the Timber report's five sets labelled "Photos" could not be told apart |
| Hidden questions' photos | —                                                            | Not printed                      | A certificate answering "Was a Durable Notice fitted?" No must not show the notice |
| Section heading case  | As the form has it                                              | The same                         | The v1 layout upper-cased every heading; a verbatim form prints `Risk Assessment` |
| Header title          | The form's own header lines                                     | The same, without the app's picker name above them | It printed the Certificate's title twice |
| Licence and phone rows | Beside the person named                                        | Bound to that person's own field | The Certificate names an installer twice (§2, §7); each row prints its own person, and nothing when nobody is chosen — never the author's licence under a blank name |
| Durable notice (Certificate) | Not on the form                                          | Not printed                      | The notice was app-invented. v1 certificates keep printing it exactly as before |
| Typeface              | The vendor's                                                    | Helvetica, until the PDF redesign | Every character the three forms use is in Helvetica's WinAnsi encoding, verified by rendering and reading the text layer back. An embedded font is a design change, not a correctness fix, and belongs with the redesign |

## Validation

The forms barely validate — the Service Report's only mandatory gate is
`Is it safe to commence work?`. These additions are deliberate, recorded in each
template's `validationNotes`, and surfaced to the owner as settings where noted.

- The technician's signature is required to finalise. Owner-relaxable.
- A treatment row must be complete or empty; an empty row is discarded on save. The
  grid itself has no minimum, so an inspection-only visit finalises.
- `Date:` is required.
- A suggestion the app made (forecast weather, a scheduled start time, answers copied
  from the last visit) must be confirmed before finalising. Pressing Next on the
  section confirms it, so this costs no extra taps — but nothing the app guessed can
  print under a signature unseen.

## What the source does not say, and we do not invent

Checked against WA Health (Pesticides) Regulations 2011 reg 77, the AEPMA Code of
Practice, NCC 3.4.3 and the APVMA's 2026 rodenticide decision. Where a standard wants
something the form omits, it is offered as an option the owner can turn on — never
added silently to a form the owner has been issuing for years. See
`docs/reports/compliance.md`.

One correction the app must get right in its own copy: `SGARS in compliance with the
new 35 day ruling` refers to the APVMA's **suspension** of second-generation
anticoagulant rodenticides from 24 March 2026, whose replacement label instructions
include "DO NOT use the product continuously for more than 35 days without an
evaluation of the state of the infestation and of the efficacy of the treatment."
The option string prints verbatim; our help text calls it a suspension with
replacement label instructions, never a "ban" or "new legislation".
