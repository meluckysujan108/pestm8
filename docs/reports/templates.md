# Authoring a template

A template is **data**, not code: `sections → fields`, each field a kind the
builder knows how to render and `present()` knows how to read back. Adding a
state-specific variant or a fourth document type is a new definition file,
never a change to the builder (ARCHITECTURE §5.3).

This is the reference for writing one — by hand in `src/lib/reportTemplates/`,
or through the editor a business owner uses. Both produce the same shape; the
editor's output is additionally validated by `customTemplateSchema.ts`, which
is the one edge validator for business-authored templates.

## The shape

```ts
type ReportTemplate = {
  id: TemplateId | 'custom'
  version: number          // bump on ANY wording change — see below
  name, shortName, legalBasis, blurb: string
  sections: Array<SectionDef>
  terms?: RichDoc          // the printed terms pages
  boilerplate?: string     // legacy flat terms; prefer `terms`
  print?: PrintSpec        // cover, headings, footer name, numbering
  features?: Array<'durableNotice'>
  corrections?: Array<Correction>
  validationNotes?: Array<string>
  sourceRef?: string
}

type SectionDef = {
  id?: string              // stable key for `?s=` deep links
  number?: number          // the form's own numbering
  title: string
  preamble?: string
  visibleWhen?: Condition
  print?: { heading?: string | null }
  fields: Array<FieldDef>
}
```

**`version` is load-bearing.** A finalised report dereferences the snapshot it
was signed against, and `templateFor(id, version)` is how a v1 report keeps
printing v1's words. A wording change that forgets to bump it is
indistinguishable from no change at all, and the v1 modules in
`legacy/` are what a pre-rewrite report still resolves to.

## The field kinds

Twenty-two. The first group holds answers in `report.data`; the second is
answered but stores its answer elsewhere; the third is not a question at all.

### Answered, stored in `data`

| Kind | Stores | Its own options |
|---|---|---|
| `text` | string | `placeholder` |
| `area` | string | `placeholder`, `rows` |
| `number` | number | `min`, `max`, `step`, `unit` |
| `date` | `YYYY-MM-DD` | `defaultToday` |
| `time` | `HH:MM` | — |
| `toggle` | boolean | `yes`/`no` wording, `flaggedValue`, `statusBar`, `tones` |
| `select` | string | `options`, + `Choice` |
| `radio` | string | `options`, + `Choice` |
| `chips` | `string[]` | `options`, + `Choice` |
| `checks` | `string[]` | `options`, `extensible`, `locked`, `exclusive`, `layout`, + `Choice` |
| `areas` | per-row `{ present, note }` | `rows`, `note` |
| `gps` | `{ lat, lng, alt?, at? }` | `auto`, `format: 'lines'` |
| `member` | membership id | `roleWord`, `defaultTo` |
| `emails` | `string[]` | `semantic: 'emailTo'` |
| `repeater` | `Array<RepeaterRow>` | `columns`, `min`, `addLabel`, `removeLabel` |

`Choice` is shared by `select`/`radio`/`chips`/`checks`:
`optionsFrom` (an owner-editable library), `blankOption` (a placeholder that is
never stored), `flaggedValues`, `tones`, `presentAs: 'rating'`.

### Answered, stored outside `data`

`photos` (fixed named slots), `gallery` (a free set, `maxPhotos`), `cover` (one
landscape photo that becomes page 1), `signature` (`slot`, `role`, `statement`,
`askName`, `dateLabel`, `allowSaved`).

Their answers live in `reportPhotos` / `signatureSlots`, which is why
`isDataField` excludes them from `data` walks.

### Not questions

`note` (printed prose: `body` as RichDoc, `tone`, `attachedTo`,
`printed: 'whenFlagged'`), `heading` (a sub-heading, plus `quick: 'allYes' |
'allClear'`), `derived` (a fact printed from a record, never stored).

**`isDataField` is the one guard** every data-handling walk runs — `pruneHidden`,
`deriveSchema`, `sectionProgress`, `seedData`, `present`. Miss it and a static
block is treated as an unanswered question, `deriveGenericSchema` demands a
value for a block that has no control, and the report becomes permanently
unfinalisable with an error pointing at nothing.

## What every field carries

`key` (unique in the template), `label`, `required`, `hint`, `visibleWhen`,
`printed` (`false` or `'whenFlagged'`), `attachedTo`, `width`, `summary` (read
back on the finalise sheet), `semantic`, `carryOver`.

**`semantic`** is what a question MEANS to the app, as opposed to what it says.
The forms word the same job differently, and behaviour must never key off
wording the app has promised to reproduce verbatim:
`sendCopyToClient`, `safetyGate`, `weather`, `startTime`, `finishTime`,
`emailTo`.

**`carryOver`** marks an answer as being about the PLACE rather than the DAY,
so a return visit to the same address can offer it. Never put it on a date, a
time, the weather, GPS, a comment, a photo or a signature: a stale one under a
signature is worse than a blank.

## `derived` sources

A `derived` field prints from a record and is never stored in `data`. Live
while the report is a draft, frozen into `contextSnapshot` at finalise, so
renaming a client next year does not rewrite a report issued this year.

`client.{name,address,phone,email}` · `property.address` ·
`business.{name,tradingName,address,phone,email,website,abn}` ·
`technician.{name,licence,phone,address}` · `job.number`

## Option libraries

A choice field binds to a business-editable vocabulary with
`optionsFrom: OptionSetKey`. The template still declares `options` — those are
the verbatim defaults, and they are what a business that has never edited the
list gets.

Nineteen keys: `products`, `treatments`, `methods`, `quantities`, `nextVisit`,
`risks`, `riskActions`, `housekeeping`, `areasTreated`, `limitationFactors`,
`noticeLocation`, `peoplePresent`, `wallConstruction`, `floorType`, `roofType`,
`structureType`, `structureHeight`, `facade`, `topography`.

**AS-referenced answer scales stay inline**, not library-backed: the Timber
report's cross-referencing summary options, `Susceptibility Rating`,
`Adequate | Inadequate | N/A`, the Certificate's `System Type Installed`, both
weather sets. Those are the standard's words, not the business's.

**Never rename a value the template matches on.** `pinnedValues()` collects
every string a template tests by value — `locked`, `exclusive`,
`flaggedValues`, and any `visibleWhen` `eq`/`includes`/`oneOf` against a bound
field — and `renameOption` refuses those. Renaming one would change behaviour
while looking like a wording change.

## Printing

`PrintSpec` decides what the finished document looks like:
`formName` (the footer), `numbering`, `headings` + `standardsLine` (the AS
forms print their own header lines instead of a title band), `cover.{title,
subtitle}`, `termsHeading`, `termsBreak`, `omitEmpty`.

Rule 8 — **a signed document omits what was never answered**, including a
sub-heading left standing over nothing and a section left with nothing at all.
A draft still shows the em dash, because the technician needs to see what is
open.

## Business-authored templates

An owner never edits a built-in. "Editing" one clones it
(`customTemplates.cloneBuiltin`) into a `customReportTemplates` row they own.

Saving and issuing are **different acts**:

- `saveDraft` keeps the work in progress, **unvalidated**. A form halfway
  through being edited is not a valid form, and refusing to save it is how the
  editor came to report "check your connection" about a connection that was
  fine.
- `publish` validates with `customTemplateSectionsSchema`, copies the draft
  into the published columns, bumps `publishedVersion` and appends to
  `customReportTemplateVersions`.
- `reports.create` reads the published columns only, so an unissued edit is
  invisible to everyone filling the form in.
- `discardDraft` throws the edit away.

A technician's `customTemplates.get` never includes the draft at all.

## Before you ship a wording change

1. Bump `version`.
2. Keep the previous revision in `legacy/` if any draft could still be on it,
   with `valueMigrations` for changed option strings.
3. Run `src/lib/reportTemplates/fidelity.test.ts` — it compares every template
   string against the machine-extracted source corpus both ways: nothing
   omitted, nothing invented.
4. Run `seam.test.ts`, which pins the canonical snapshot hashes finalised
   reports dereference.
5. Add a `Correction` entry for anything you deliberately changed from the
   source, and a `// FLAG:` comment for anything you deliberately kept that
   reads as a mistake.
