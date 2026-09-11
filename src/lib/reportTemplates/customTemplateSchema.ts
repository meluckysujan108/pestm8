import { z } from 'zod'

/**
 * The structural validator for a business-authored template's `sections`
 * (`customReportTemplates.sections`, stored as `v.any()` — see that table's
 * own comment in `convex/schema.ts` for why). Mirrors the 15-way `FieldDef`
 * union in `types.ts` mechanically: every kind, every prop, nothing more.
 * Used both server-side (validating writes to `customReportTemplates`) and,
 * later, client-side (the Phase 5 editor's live errors) — one definition,
 * not two that can drift apart.
 */

const scalarSchema = z.union([z.string(), z.number(), z.boolean()])

/** Mirrors `visibility.ts`'s `Condition` — recursive, so `z.lazy` is required. */
const conditionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ when: z.string(), eq: scalarSchema }),
    z.object({ when: z.string(), oneOf: z.array(scalarSchema) }),
    z.object({ when: z.string(), includes: scalarSchema }),
    z.object({ when: z.string(), filled: z.literal(true) }),
    z.object({ all: z.array(conditionSchema) }),
    z.object({ any: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
  ]),
)

const optionSchema = z.object({ value: z.string(), label: z.string() })

const base = {
  key: z.string().min(1, 'Every field needs a key'),
  label: z.string().min(1, 'Every field needs a label'),
  required: z.boolean().optional(),
  hint: z.string().optional(),
  visibleWhen: conditionSchema.optional(),
}

const textField = z.object({
  ...base,
  kind: z.literal('text'),
  placeholder: z.string().optional(),
})
const areaField = z.object({
  ...base,
  kind: z.literal('area'),
  placeholder: z.string().optional(),
  rows: z.number().optional(),
})
const selectField = z.object({
  ...base,
  kind: z.literal('select'),
  options: z.array(optionSchema),
})
const chipsField = z.object({
  ...base,
  kind: z.literal('chips'),
  options: z.array(optionSchema),
})
const areasField = z.object({
  ...base,
  kind: z.literal('areas'),
  rows: z.array(z.string()),
  note: z.string().optional(),
})
const photosField = z.object({
  ...base,
  kind: z.literal('photos'),
  slots: z.array(z.string()),
})
const toggleField = z.object({
  ...base,
  kind: z.literal('toggle'),
  yes: z.string().optional(),
  no: z.string().optional(),
})
const radioField = z.object({
  ...base,
  kind: z.literal('radio'),
  options: z.array(optionSchema),
})
const dateField = z.object({
  ...base,
  kind: z.literal('date'),
  defaultToday: z.boolean().optional(),
})
const timeField = z.object({ ...base, kind: z.literal('time') })
const numberField = z.object({
  ...base,
  kind: z.literal('number'),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
})
const checksField = z.object({
  ...base,
  kind: z.literal('checks'),
  options: z.array(optionSchema),
  extensible: z.boolean().optional(),
  addLabel: z.string().optional(),
})
const gpsField = z.object({ ...base, kind: z.literal('gps') })
const signatureField = z.object({
  ...base,
  kind: z.literal('signature'),
  slot: z.string(),
  role: z.enum(['technician', 'client']),
})
const galleryField = z.object({
  ...base,
  kind: z.literal('gallery'),
  maxPhotos: z.number().optional(),
  addLabel: z.string().optional(),
})

/**
 * `CellDef` in `types.ts` restricts a repeater column to leaves only — no
 * photos, signatures, GPS, or nested repeaters, since those own storage or
 * hardware and have no sensible per-row meaning. Enforced here at the schema
 * level, mirroring the type-level restriction.
 */
const cellDefSchema = z.discriminatedUnion('kind', [
  textField,
  areaField,
  selectField,
  chipsField,
  checksField,
  numberField,
  dateField,
  timeField,
  toggleField,
  radioField,
])

const repeaterField = z.object({
  ...base,
  kind: z.literal('repeater'),
  columns: z.array(cellDefSchema),
  addLabel: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

const fieldDefSchema = z.discriminatedUnion('kind', [
  textField,
  areaField,
  selectField,
  chipsField,
  areasField,
  photosField,
  toggleField,
  radioField,
  dateField,
  timeField,
  numberField,
  checksField,
  gpsField,
  signatureField,
  repeaterField,
  galleryField,
])

const sectionDefSchema = z.object({
  number: z.number().optional(),
  title: z.string().min(1, 'Every section needs a title'),
  preamble: z.string().optional(),
  fields: z.array(fieldDefSchema),
  visibleWhen: conditionSchema.optional(),
  implicit: z.boolean().optional(),
})

/**
 * The template-wide check no per-field schema above can make on its own:
 * every field key must be unique, since `data` is a flat record keyed by
 * `field.key` and a duplicate would make two fields silently share one
 * answer.
 */
export const customTemplateSectionsSchema = z
  .array(sectionDefSchema)
  .min(1, 'Add at least one section')
  .superRefine((sections, ctx) => {
    const seen = new Set<string>()
    sections.forEach((section, si) => {
      section.fields.forEach((field, fi) => {
        if (seen.has(field.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Field key "${field.key}" is used by more than one field`,
            path: [si, 'fields', fi, 'key'],
          })
        }
        seen.add(field.key)
      })
    })
  })
