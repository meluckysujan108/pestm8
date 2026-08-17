import type { z } from 'zod'

export type TemplateId =
  | 'treatmentRecord'
  | 'timberPestInspection'
  | 'termiteManagementCert'

/**
 * Field kinds the builder knows how to render. Adding a state-specific variant
 * or a fourth document type should be a new definition file, never a change to
 * the builder UI (§5.3).
 */
export type FieldDef =
  | {
      kind: 'text'
      key: string
      label: string
      placeholder?: string
      required?: boolean
      hint?: string
    }
  | {
      kind: 'area'
      key: string
      label: string
      placeholder?: string
      rows?: number
      required?: boolean
    }
  | {
      kind: 'select'
      key: string
      label: string
      options: Array<{ value: string; label: string }>
      required?: boolean
    }
  | {
      kind: 'chips'
      key: string
      label: string
      options: Array<{ value: string; label: string }>
      required?: boolean
    }
  | {
      kind: 'areas'
      key: string
      label: string
      rows: Array<string>
      note?: string
    }
  | { kind: 'photos'; key: string; label: string; slots: Array<string> }

export type TaskSpec = {
  kind: 'durableNotice' | 'other'
  label: string
  detail?: string
}

export type ReportTemplate = {
  id: TemplateId
  name: string
  shortName: string
  /** Shown as a tag in the picker, and stored on the report record. */
  legalBasis: string
  blurb: string
  fields: Array<FieldDef>
  schema: z.ZodType
  /** Rendered read-only in a grey inset card — visibly non-editable (§2.3). */
  boilerplate: string
  /** Work the app cannot do on the user's behalf, raised as a tracked task. */
  onFinalise?: () => Array<TaskSpec>
}

/** One inspected area, per AS 4349.3: no-access must carry a reason. */
export type AreaResult = {
  status: 'inspected' | 'noAccess'
  reason?: string
}
