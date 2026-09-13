import { z } from 'zod'

/**
 * The structural validator for a business-authored template's `sections`
 * (`customReportTemplates.sections`, stored as `v.any()` — see that table's
 * own comment in `convex/schema.ts` for why). Mirrors the 15-way `FieldDef`
 * union in `types.ts` mechanically: every kind, every prop, nothing more.
 *
 * Nothing links this to `FieldDef` at compile time, and the failure when they
 * drift is quiet: Zod objects STRIP keys they do not know, and
 * `customTemplates.update` stores the parsed output, so a prop that exists in
 * the types and not here is silently deleted from every custom template on the
 * next autosave. A change to `types.ts` is a change to this file, always.
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
  printed: z.union([z.literal(false), z.literal('whenFlagged')]).optional(),
  attachedTo: z.string().optional(),
}

const textField = z.object({ ...base, kind: z.literal('text'), placeholder: z.string().optional() })
const areaField = z.object({
  ...base,
  kind: z.literal('area'),
  placeholder: z.string().optional(),
  rows: z.number().optional(),
})
/** Mirrors `Choice` in types.ts — shared by every kind with a fixed answer list. */
const optionSetKeySchema = z.enum([
  'treatments',
  'products',
  'quantities',
  'methods',
  'nextVisit',
  'risks',
  'riskActions',
  'housekeeping',
  'peoplePresent',
  'wallConstruction',
  'floorType',
  'roofType',
  'structureType',
  'structureHeight',
  'facade',
  'topography',
  'areasTreated',
  'limitationFactors',
  'noticeLocation',
])

const choice = {
  optionsFrom: optionSetKeySchema.optional(),
  blankOption: z.string().optional(),
  flaggedValues: z.array(z.string()).optional(),
}

const selectField = z.object({
  ...base,
  ...choice,
  kind: z.literal('select'),
  options: z.array(optionSchema),
})
const chipsField = z.object({
  ...base,
  ...choice,
  kind: z.literal('chips'),
  options: z.array(optionSchema),
})
const areasField = z.object({
  ...base,
  kind: z.literal('areas'),
  rows: z.array(z.string()),
  note: z.string().optional(),
})
const photosField = z.object({ ...base, kind: z.literal('photos'), slots: z.array(z.string()) })
const toggleField = z.object({
  ...base,
  kind: z.literal('toggle'),
  yes: z.string().optional(),
  no: z.string().optional(),
  flaggedValue: z.boolean().optional(),
})
const radioField = z.object({
  ...base,
  ...choice,
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
  ...choice,
  kind: z.literal('checks'),
  options: z.array(optionSchema),
  extensible: z.boolean().optional(),
  addLabel: z.string().optional(),
  locked: z.array(z.string()).optional(),
  exclusive: z.array(z.string()).optional(),
})
const gpsField = z.object({
  ...base,
  kind: z.literal('gps'),
  format: z.literal('lines').optional(),
})
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
  removeLabel: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

/**
 * `RichDoc` — the printed prose a `note` carries. Recursive (a bullet may hold
 * a nested list), so `z.lazy` for the same reason `conditionSchema` above is.
 */
const richMarkSchema = z.enum(['bold', 'redText', 'caps'])

const richTextSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  marks: z.array(richMarkSchema).optional(),
})

const richBlockSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('heading'),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      content: z.array(richTextSchema),
    }),
    z.object({
      type: z.literal('paragraph'),
      content: z.array(richTextSchema),
    }),
    z.object({
      type: z.literal('bulletList'),
      content: z.array(
        z.object({
          type: z.literal('listItem'),
          content: z.array(richBlockSchema),
        }),
      ),
    }),
    z.object({
      type: z.literal('definitionList'),
      content: z.array(
        z.object({
          type: z.literal('definitionItem'),
          term: z.string(),
          content: z.array(richBlockSchema),
        }),
      ),
    }),
  ]),
)

export const richDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(richBlockSchema),
})

const noteField = z.object({
  ...base,
  kind: z.literal('note'),
  body: richDocSchema,
  heading: z.string().optional(),
  tone: z.enum(['note', 'important', 'warning', 'statement']).optional(),
})

const headingField = z.object({
  ...base,
  kind: z.literal('heading'),
  text: z.string().min(1, 'Every sub-heading needs its text'),
  note: z.string().optional(),
  quick: z.enum(['allYes', 'allClear']).optional(),
})

const derivedField = z.object({
  ...base,
  kind: z.literal('derived'),
  source: z.enum([
    'client.name',
    'client.address',
    'client.phone',
    'client.email',
    'property.address',
    'business.name',
    'business.tradingName',
    'business.address',
    'business.phone',
    'business.email',
    'business.website',
    'business.abn',
    'technician.name',
    'technician.licence',
    'technician.phone',
    'technician.address',
    'job.number',
  ]),
  format: z.enum(['text', 'lines', 'address']).optional(),
  member: z.string().optional(),
})

const memberField = z.object({
  ...base,
  kind: z.literal('member'),
  roleWord: z.enum(['Technician', 'Inspector', 'Installer']).optional(),
  defaultTo: z.enum(['jobAssignee', 'author']).optional(),
})

const coverField = z.object({
  ...base,
  kind: z.literal('cover'),
  addLabel: z.string().optional(),
})

const emailsField = z.object({
  ...base,
  kind: z.literal('emails'),
  semantic: z.literal('emailTo').optional(),
  placeholder: z.string().optional(),
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
  noteField,
  headingField,
  derivedField,
  memberField,
  coverField,
  emailsField,
])

const sectionDefSchema = z.object({
  number: z.number().optional(),
  title: z.string().min(1, 'Every section needs a title'),
  preamble: z.string().optional(),
  fields: z.array(fieldDefSchema),
  visibleWhen: conditionSchema.optional(),
  implicit: z.boolean().optional(),
  // `heading: null` means print no heading, and is meaningfully different from
  // the key being absent — `.nullable().optional()` keeps both readings.
  print: z
    .object({ heading: z.string().nullable().optional() })
    .optional(),
  id: z.string().optional(),
})

/**
 * The template-wide check no per-field schema above can make on its own:
 * every field key must be unique. For a question that is because `data` is a
 * flat record keyed by `field.key`, and a duplicate would make two fields
 * silently share one answer. Static blocks are counted too, for a different
 * reason: their keys are React keys and jump-link anchors, and a duplicate
 * there breaks reconciliation in the builder.
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
