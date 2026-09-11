import type { z } from 'zod'
import type { Condition } from './visibility'

export type TemplateId =
  | 'treatmentRecord'
  | 'timberPestInspection'
  | 'termiteManagementCert'
  | 'serviceReport'

export type Option = { value: string; label: string }

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
}

/**
 * Field kinds the builder knows how to render. Adding a state-specific variant
 * or a fourth document type should be a new definition file, never a change to
 * the builder UI (§5.3).
 */
export type FieldDef =
  | (BaseField & { kind: 'text'; placeholder?: string })
  | (BaseField & { kind: 'area'; placeholder?: string; rows?: number })
  | (BaseField & { kind: 'select'; options: Array<Option> })
  | (BaseField & { kind: 'chips'; options: Array<Option> })
  | (BaseField & { kind: 'areas'; rows: Array<string>; note?: string })
  | (BaseField & { kind: 'photos'; slots: Array<string> })
  /**
   * A yes/no answer. Stored as a boolean and seeded absent, so "not answered
   * yet" stays distinguishable from "answered No" — a distinction these forms
   * depend on, since "Is it safe to commence work?" left blank is not the same
   * claim as "No".
   */
  | (BaseField & { kind: 'toggle'; yes?: string; no?: string })
  /** One of several, all visible at once — unlike `select`, which hides them. */
  | (BaseField & { kind: 'radio'; options: Array<Option> })
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
    })
  /** Device location, captured once on demand. */
  | (BaseField & { kind: 'gps' })
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
 * What may sit in a repeater cell: leaves only. No photos, signatures or GPS,
 * which own storage or hardware and have no sensible per-row meaning, and no
 * nested repeaters.
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
}

export type ReportTemplate = {
  /** `'custom'` for a business-authored template — see `resolveReportTemplate`.
   * Never used as a lookup key in that case, only as a marker. */
  id: TemplateId | 'custom'
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
  /** Rendered read-only in a grey inset card — visibly non-editable (§2.3). */
  boilerplate: string
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
