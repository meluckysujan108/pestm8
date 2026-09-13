import type { z } from 'zod'
import type { Condition } from './visibility'

export type TemplateId =
  | 'treatmentRecord'
  | 'timberPestInspection'
  | 'termiteManagementCert'
  | 'serviceReport'

export type Option = { value: string; label: string }

/**
 * Printed prose with structure — the warranty pages, the AS 3660.2 terms, the
 * "IMPORTANT" disclaimers. A plain string cannot express a bold lead-in inside
 * a bullet or a definitions list, and the source forms are full of both.
 *
 * Deliberately a small closed vocabulary rather than arbitrary HTML: both
 * painters have to render every node, and @react-pdf has no list primitive, so
 * every node type here is one a PDF can be hand-built from.
 */
export type RichMark = 'bold' | 'redText' | 'caps'

export type RichText = { type: 'text'; text: string; marks?: Array<RichMark> }

export type RichBlock =
  | { type: 'heading'; level: 1 | 2 | 3; content: Array<RichText> }
  | { type: 'paragraph'; content: Array<RichText> }
  | { type: 'bulletList'; content: Array<RichListItem> }
  | { type: 'definitionList'; content: Array<RichDefinition> }

export type RichListItem = { type: 'listItem'; content: Array<RichBlock> }

/** A defined term and its meaning — the Certificate's 26 definitions. */
export type RichDefinition = {
  type: 'definitionItem'
  term: string
  content: Array<RichBlock>
}

export type RichDoc = { type: 'doc'; content: Array<RichBlock> }

/**
 * A record fact a document prints but never asks for. The value is resolved at
 * render time from the report's context, so it is never stored in `data` and
 * can never go stale against the record it came from.
 *
 * Who did the work is an answer someone chooses — the `member` kind. The
 * `technician.*` sources then print facts OF that choice (the chosen
 * inspector's licence, their name again under a certification statement), so a
 * form never asks the same question twice and cannot contradict itself.
 */
export type DerivedSource =
  | 'client.name'
  | 'client.address'
  | 'client.phone'
  | 'client.email'
  | 'property.address'
  | 'business.name'
  | 'business.tradingName'
  | 'business.address'
  | 'business.phone'
  | 'business.email'
  | 'business.website'
  | 'business.abn'
  | 'technician.name'
  | 'technician.licence'
  | 'technician.phone'
  | 'technician.address'
  | 'job.number'

/**
 * What every field carries regardless of kind. Factored out so a property that
 * applies to all of them — `visibleWhen` being the first — is declared once
 * rather than repeated down a growing union.
 */
type BaseField = {
  key: string
  label: string
  required?: boolean
  hint?: string
  /**
   * Show this field only while the condition holds. A hidden field is not
   * rendered, not validated, and not submitted (see `pruneHidden`), so a stale
   * answer to a question that no longer applies cannot reach a finished report.
   */
  visibleWhen?: Condition
  /**
   * Whether this prints on the FINISHED document. Absent: yes. `false`: on
   * screen only — a control that drives behaviour rather than content, like
   * "Send copy of the report to the client email above…", which the source
   * form never printed. `'whenFlagged'`: only when `attachedTo`'s answer is one
   * its field flags; the Timber report's twelve conducive-conditions rows each
   * carry advice that is noise on a clean inspection and the point of the
   * report on a bad one. The builder always shows everything.
   */
  printed?: false | 'whenFlagged'
  /** The key of the question this belongs to, for `printed: 'whenFlagged'`. */
  attachedTo?: string
}

/**
 * Field kinds the builder knows how to render. Adding a state-specific variant
 * or a fourth document type should be a new definition file, never a change to
 * the builder UI (§5.3).
 */
export type FieldDef =
  | (BaseField & { kind: 'text'; placeholder?: string })
  | (BaseField & { kind: 'area'; placeholder?: string; rows?: number })
  | (BaseField & { kind: 'select'; options: Array<Option> } & Choice)
  | (BaseField & { kind: 'chips'; options: Array<Option> } & Choice)
  | (BaseField & { kind: 'areas'; rows: Array<string>; note?: string })
  | (BaseField & { kind: 'photos'; slots: Array<string> })
  /**
   * A yes/no answer. Stored as a boolean and seeded absent, so "not answered
   * yet" stays distinguishable from "answered No" — a distinction these forms
   * depend on, since "Is it safe to commence work?" left blank is not the same
   * claim as "No".
   */
  | (BaseField & {
      kind: 'toggle'
      yes?: string
      no?: string
      /** Which answer means "a problem was found" — see `Choice.flaggedValues`. */
      flaggedValue?: boolean
    })
  /** One of several, all visible at once — unlike `select`, which hides them. */
  | (BaseField & { kind: 'radio'; options: Array<Option> } & Choice)
  /** Stored ISO `YYYY-MM-DD`; presented in en-AU. */
  | (BaseField & { kind: 'date'; defaultToday?: boolean })
  /** Stored 24-hour `HH:MM`; presented in en-AU. */
  | (BaseField & { kind: 'time' })
  | (BaseField & {
      kind: 'number'
      unit?: string
      min?: number
      max?: number
      step?: number
    })
  /**
   * A checklist. Unlike `chips`, which is a compact row of pills for a short
   * fixed vocabulary, this is a vertical list built for the long risk and
   * housekeeping lists — and it can let the technician add an item the template
   * never anticipated.
   */
  | (BaseField & {
      kind: 'checks'
      options: Array<Option>
      /** Allows adding items at fill time; they store as their own label. */
      extensible?: boolean
      addLabel?: string
      /**
       * Items that are always ticked and cannot be unticked — the Timber
       * report's "12 Monthly Timber Pest Visual Inspection to maintain
       * Warranty", which is what that document IS rather than an answer. Printed
       * whether or not the stored array happens to contain them.
       */
      locked?: Array<string>
      /**
       * Items that rule out every other item: ticking one clears the rest, and
       * ticking anything else clears it. "No Risk Safe Access Given" beside a
       * list of risks is the case this exists for.
       */
      exclusive?: Array<string>
    } & Choice)
  /** Device location, captured once on demand. */
  | (BaseField & {
      kind: 'gps'
      /**
       * `'lines'` prints latitude, longitude and altitude stacked, the way the
       * source forms do. Absent keeps the single joined line every report
       * finalised before this option was added already prints.
       */
      format?: 'lines'
    })
  /**
   * A drawn signature. The image goes to storage under `slot`; only the
   * metadata lives in `data`.
   */
  | (BaseField & {
      kind: 'signature'
      slot: string
      role: 'technician' | 'client'
    })
  /**
   * Repeating rows of the same columns — the treatment grid, where one visit
   * may apply several products by different methods.
   */
  | (BaseField & {
      kind: 'repeater'
      columns: Array<CellDef>
      addLabel?: string
      /** The source form's own word for removing a row, e.g. "Delete Row". */
      removeLabel?: string
      min?: number
      max?: number
    })
  /**
   * As many photos as the technician takes, not a fixed set of named slots —
   * the difference from `photos`. Each carries its own caption, a manual
   * order, and at most one may be flagged as the cover. Backed by its own
   * table (`reportPhotos`), never `data`, for the same reason as `photos` and
   * `signature`: autosave replaces `data` wholesale every ~1.2s.
   */
  | (BaseField & { kind: 'gallery'; maxPhotos?: number; addLabel?: string })
  /**
   * Printed prose that asks nothing — a warranty clause, a disclaimer, the
   * "IMPORTANT" notice above the termite damage photos. It sits in
   * `section.fields` rather than a sibling array so document order is the
   * array order, which is the only way to say "this paragraph goes between
   * question 3 and question 4".
   *
   * `label` is an editor-only name. It is never printed; `body` is.
   */
  | (BaseField & {
      kind: 'note'
      body: RichDoc
      /** A bold lead-in above the body, e.g. "Concrete Slab Disclaimer". */
      heading?: string
      tone?: 'note' | 'important' | 'warning' | 'statement'
    })
  /**
   * A sub-heading inside a section. The AS forms group nine or twelve related
   * questions under one numbered section, and a flat list of twelve
   * identical-looking rows is the difference between a form someone completes
   * and one they abandon.
   */
  | (BaseField & {
      kind: 'heading'
      text: string
      note?: string
      /**
       * Offers a single explicit tap that answers this group's controls with
       * their "nothing found" values. Never a stored default — an unanswered
       * question and one answered No are different claims.
       */
      quick?: 'allYes' | 'allClear'
    })
  /**
   * A record fact printed on the document and never asked for: the client's
   * name, the site address, the business licence. Holds nothing in `data`, so
   * it cannot drift from the record it came from, and cannot be "filled in"
   * wrongly by a technician retyping what the system already knows.
   */
  | (BaseField & {
      kind: 'derived'
      source: DerivedSource
      format?: 'text' | 'lines' | 'address'
      /**
       * The key of the `member` field whose chosen person this row describes.
       * A `technician.*` row bound this way prints that person's licence or
       * phone — and prints nothing when nobody is chosen there. Without the
       * binding, a form naming two people (the Certificate's §2 installer and
       * its §7 certifying installer) would print one person's licence under the
       * other's name on a signed document.
       */
      member?: string
    })
  /**
   * Who did the work, chosen from the business's roster and printed with their
   * licence. Distinct from the report's author: the technician named on the
   * document and the person who submitted it are routinely different people.
   */
  | (BaseField & {
      kind: 'member'
      roleWord?: 'Technician' | 'Inspector' | 'Installer'
      defaultTo?: 'jobAssignee' | 'author'
    })
  /**
   * The single landscape photo that becomes the document's front page. Backed
   * by `reportPhotos` like `gallery`, but singular by definition and resolved
   * by field kind rather than by the per-row `isCover` flag — that flag is
   * only reachable through a star button the gallery control hides whenever
   * `maxPhotos` is 1, which is why the service report's declared front-page
   * photo has never once rendered as one.
   */
  | (BaseField & { kind: 'cover'; addLabel?: string })
  /**
   * Extra addresses this document is sent to, on top of whoever the template's
   * delivery rules already reach. Stored as a list of strings so the printed
   * "Email Report To" line and the actual recipients can never disagree.
   */
  | (BaseField & {
      kind: 'emails'
      semantic?: 'emailTo'
      placeholder?: string
    })

/**
 * What may sit in a repeater cell: leaves only. No photos, signatures or GPS,
 * which own storage or hardware and have no sensible per-row meaning, and no
 * nested repeaters. The static and record-bound kinds are out for a different
 * reason: `note` and `heading` hold no answer to repeat, `cover` is singular
 * by definition, `emails` is about the whole document rather than a row, and
 * `derived` and `member` resolve against records rather than row values.
 */
export type CellDef = Extract<
  FieldDef,
  {
    kind:
      | 'text'
      | 'area'
      | 'select'
      | 'chips'
      | 'checks'
      | 'number'
      | 'date'
      | 'time'
      | 'toggle'
      | 'radio'
  }
>

export type FieldKind = FieldDef['kind']

/**
 * The vocabularies a business owns and may edit — its product list, the
 * treatments it offers. Deliberately not every option list: the scales an
 * Australian Standard defines (a susceptibility rating, the answers that
 * cross-reference another section) stay inline in the template, because a
 * business editing them would be editing the standard.
 */
export type OptionSetKey =
  | 'treatments'
  | 'products'
  | 'quantities'
  | 'methods'
  | 'nextVisit'
  | 'risks'
  | 'riskActions'
  | 'housekeeping'
  | 'peoplePresent'
  | 'wallConstruction'
  | 'floorType'
  | 'roofType'
  | 'structureType'
  | 'structureHeight'
  | 'facade'
  | 'topography'
  | 'areasTreated'
  | 'limitationFactors'
  | 'noticeLocation'

/** What every kind that offers a fixed list of answers can also say. */
type Choice = {
  /**
   * This list is a business vocabulary. `options` still holds the verbatim
   * defaults — a template module is always complete on its own — and a
   * business's own list replaces them wherever a report is resolved.
   */
  optionsFrom?: OptionSetKey
  /**
   * A placeholder the source form shows first, like `-`. Offered, never
   * stored: choosing it clears the answer rather than recording a dash.
   */
  blankOption?: string
  /**
   * Answers that mean "a problem was found". A `note` attached to this field
   * with `printed: 'whenFlagged'` prints only when one of these is chosen.
   */
  flaggedValues?: Array<string>
}

/**
 * The kinds whose `key` addresses an answer in `report.data`. Everything else
 * carries a key only so React and jump-links have something to hold on to.
 *
 * Written as an `Exclude` so a new kind is a data field by default: forgetting
 * to list a static kind here makes it validate and prune like a question,
 * which is loud; forgetting to list a real question would make its answer
 * invisible to validation, which is silent.
 */
export type DataFieldKind = Exclude<
  FieldKind,
  'note' | 'heading' | 'derived' | 'cover' | 'photos' | 'gallery'
>

export type DataField = Extract<FieldDef, { kind: DataFieldKind }>

const NON_DATA_KINDS: Record<Exclude<FieldKind, DataFieldKind>, true> = {
  note: true,
  heading: true,
  derived: true,
  cover: true,
  photos: true,
  gallery: true,
}

/**
 * Does this field's key address an answer in `data`?
 *
 * The one guard every data-handling walk runs — seeding, pruning, validating,
 * progress. Without it a static block is treated as an unanswered question:
 * `deriveGenericSchema` demands a value for a block that has no control, and
 * the report becomes permanently unfinalisable with an error pointing at
 * nothing.
 *
 * `photos`, `gallery` and `cover` are answered, but their answers live in
 * `reportPhotos`, not `data` — the same distinction, for the same reason.
 */
export function isDataField(field: FieldDef): field is DataField {
  return !(field.kind in NON_DATA_KINDS)
}

/**
 * A numbered part of a document — "3. Inspection Summary" — with the prose that
 * introduces it. The real AS 4349.3 and AS 3660.2 forms are organised this way,
 * and a flat field list cannot express a preamble that legally scopes the
 * fields beneath it.
 */
export type SectionDef = {
  /** Printed before the title, e.g. `3` renders "3. Findings". */
  number?: number
  title: string
  preamble?: string
  fields: Array<FieldDef>
  visibleWhen?: Condition
  /**
   * Set only by `sectionsOf()` when wrapping a template that still declares a
   * flat `fields` list. The finished document and the PDF have always printed a
   * "Details" heading, so they print this one too — but the builder never did,
   * and inventing a heading there would be a visible change dressed up as a
   * refactor. Surfaces use this to tell "the template asked for a section" from
   * "we synthesised one".
   */
  implicit?: boolean
  /**
   * How this section prints, as distinct from how it is filled in. The screen
   * shows the form's own numbered title — the form as the technician works
   * through it — while the document prints the heading the client received,
   * which on the service report is sometimes a different phrase and sometimes
   * nothing at all under the title band.
   *
   * `heading: null` means print no heading. Read it with `'heading' in print`,
   * never `??`: an explicit null and an absent key mean opposite things.
   */
  print?: { heading?: string | null }
  /** A stable handle for links and jump targets, independent of the title. */
  id?: string
}

/**
 * A deliberate change from the source's wording. The fidelity test refuses a
 * template string that is not in the extracted corpus unless it is listed
 * here, so an undocumented edit to a legal form cannot pass.
 */
export type Correction = {
  where: string
  source: string
  printed: string
  reason: string
  /** `variant`: the sources disagreed and one reading was chosen. */
  kind?: 'typo' | 'variant'
}

/**
 * A corpus string the template deliberately does not use, and why — superseded
 * by a higher-precedence source, printed from a record, or vendor chrome. The
 * other half of the fidelity test's allowlist: every extracted string is in
 * the template, corrected, or accounted for here.
 */
export type SupersededString = { text: string; cite: string; reason: string }

/** How a template's own framing prints: its header lines, cover and footer name. */
export type PrintSpec = {
  /** The form's own name, as the footer should give it. */
  formName: string
  /** Whether printed section headings carry their number. */
  numbering: 'numbered' | 'unnumbered'
  /** Header lines printed above the first section, verbatim. */
  headings?: Array<string>
  /** The standards reference printed under the header lines. */
  standardsLine?: string
  cover?: { title: string; subtitle?: string }
  /** The heading printed above `terms`. */
  termsHeading?: string
  /**
   * Leave unanswered questions off the finished document, as the source
   * vendor prints them — a signed report that reads as forty rows of "—" is
   * not the document the client received. The draft on screen still shows the
   * dash, so the technician can see what is still open.
   */
  omitEmpty?: boolean
}

export type ReportTemplate = {
  /** `'custom'` for a business-authored template — see `resolveReportTemplate`.
   * Never used as a lookup key in that case, only as a marker. */
  id: TemplateId | 'custom'
  /**
   * Bumped whenever the printed wording changes. Stamped onto every report at
   * creation and frozen into its snapshot at finalise, so "which revision does
   * this signed document say?" never has to be inferred from a date.
   *
   * Required rather than optional on purpose: a wording change that forgets to
   * bump this is indistinguishable from no change at all, and the compiler is
   * the only thing that will ever notice.
   */
  version: number
  name: string
  shortName: string
  /** Shown as a tag in the picker, and stored on the report record. */
  legalBasis: string
  blurb: string
  /**
   * The legacy flat list. Still the only shape the three original templates
   * use; always read through `sectionsOf()` rather than directly, so a template
   * can move to `sections` without touching any renderer.
   */
  fields: Array<FieldDef>
  /** Preferred over `fields` for new templates. */
  sections?: Array<SectionDef>
  schema: z.ZodType
  /**
   * Rendered read-only in a grey inset card — visibly non-editable (§2.3).
   * The v1 wording's single block of terms. A verbatim template prints `terms`
   * instead and leaves this empty.
   */
  boilerplate: string
  /** Structured terms and warranty pages, printed after the sections. */
  terms?: RichDoc
  print?: PrintSpec
  /**
   * App-invented extras that are not part of the source form. Opt-in by name,
   * so nothing the business never issued appears on a document by default.
   */
  features?: Array<'durableNotice'>

  // --- Authoring metadata. Never printed, never frozen into a snapshot. ---

  /** The vendored source this template reproduces. */
  sourceRef?: string
  corrections?: Array<Correction>
  superseded?: Array<SupersededString>
  /** Validation choices that go beyond what the source form enforces. */
  validationNotes?: Array<string>
}

/** One inspected area, per AS 4349.3: no-access must carry a reason. */
export type AreaResult = {
  status: 'inspected' | 'noAccess'
  reason?: string
}

/**
 * A captured location. `at` records when, because a coordinate on a report is
 * evidence the technician was there — and one copied from an earlier visit
 * would say the same thing while meaning something else entirely.
 */
export type GpsValue = {
  lat: number
  lng: number
  /** Metres. Absent when the device does not report it. */
  altitude?: number
  at: number
}

/** Metadata only — the drawn PNG lives in Convex storage, like a photo. */
export type SignatureValue = { signedAt: number; signedBy?: string }

/**
 * One repeater row. `_id` is client-generated and load-bearing: React keyed by
 * array index makes a focused input jump to a different row when an earlier row
 * is deleted, and Convex arrays carry no identity of their own.
 */
export type RepeaterRow = { _id: string } & Record<string, unknown>
