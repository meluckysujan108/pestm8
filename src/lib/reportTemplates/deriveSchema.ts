import { z } from 'zod'
import { isFilled, visibleSections } from './visibility'
import type { CellDef, FieldDef, SectionDef } from './types'

/**
 * The custom-template counterpart to the 4 built-ins' hand-written
 * `schema: z.object({...})`. Built as `z.record(...).superRefine(...)`, not a
 * static `z.object` — `pruneHidden` already strips a hidden-but-required
 * field's stale answer before this ever runs, so a static object schema would
 * wrongly fail on a payload that correctly omits it. This re-derives the
 * currently-visible set itself, from the same data being validated, exactly
 * as `pruneHidden` did when producing that payload.
 *
 * `photos`/`gallery` are skipped entirely: neither ever stores anything in
 * `data` (evidence lives in `photoSlots`/the `reportPhotos` table), so there
 * is nothing here to check — matching the gap already present in every
 * hand-written schema, not a shortfall specific to this one.
 */
export function deriveGenericSchema(sections: Array<SectionDef>): z.ZodType {
  return z.record(z.string(), z.unknown()).superRefine((data, ctx) => {
    for (const section of visibleSections(sections, data)) {
      for (const field of section.fields) {
        validateField(field, data[field.key], ctx, [field.key])
      }
    }
  })
}

function requiredCheck(
  field: { required?: boolean; label: string },
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
) {
  if (field.required && !isFilled(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field.label} is required`,
      path,
    })
  }
}

function validateField(
  field: FieldDef,
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
) {
  switch (field.kind) {
    // Unenforceable from `data` — see the module comment.
    case 'photos':
    case 'gallery':
      return

    // AS 4349.3's own rule, verbatim: an area not inspected must say why.
    // The exact message matches the built-in `areaResult` refine in
    // `shared.ts`, since `e2e/reports.spec.ts` already asserts this string.
    case 'areas': {
      const rows = (value ?? {}) as Record<
        string,
        { status?: string; reason?: string } | undefined
      >
      for (const row of field.rows) {
        const result = rows[row]
        const reasoned = (result?.reason?.trim().length ?? 0) > 0
        if (result && result.status !== 'inspected' && !reasoned) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A reason is required when an area was not inspected',
            path: [...path, row],
          })
        }
      }
      return
    }

    case 'repeater': {
      const rows = Array.isArray(value) ? value : []
      const min = field.min ?? (field.required ? 1 : 0)
      if (rows.length < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field.label} needs at least ${min} row${min === 1 ? '' : 's'}`,
          path,
        })
      }
      rows.forEach((row, i) => {
        const cells = (row ?? {}) as Record<string, unknown>
        for (const column of field.columns) {
          validateCell(column, cells[column.key], ctx, [...path, i, column.key])
        }
      })
      return
    }

    default:
      requiredCheck(field, value, ctx, path)
  }
}

function validateCell(
  cell: CellDef,
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
) {
  requiredCheck(cell, value, ctx, path)
}
