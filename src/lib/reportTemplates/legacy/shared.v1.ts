/**
 * FROZEN — the v1 wording, exactly as it shipped before the verbatim rewrite.
 *
 * Every report written against v1 resolves through this file, signed or still
 * a draft, and the snapshot backfill freezes from it. Its canonical hash is
 * pinned in `engine.test.ts` against the rows already on the dev deployment,
 * so any edit here — including to `shared.v1.ts` — fails the build rather than
 * silently changing what a signed document says, or making production mint a
 * different snapshot row from dev.
 *
 * Remove only once production reports zero finalised rows without a snapshot
 * AND no v1 drafts remain on any deployment.
 */
import { z } from 'zod'
import type { AreaResult } from '../types'

/** APVMA registration numbers are digits; label them, don't over-validate. */
export const apvmaNumber = z
  .string()
  .min(1, 'APVMA registration number is required')

export const requiredText = (label: string) =>
  z.string().min(1, `${label} is required`)

/**
 * AS 4349.3 requires that any area not inspected records *why*. A blank reason
 * is the single most common defect in a timber pest report, so it is enforced
 * in the schema rather than left to the technician to remember.
 */
export const areaResult = z
  .object({
    status: z.enum(['inspected', 'noAccess']),
    reason: z.string().optional(),
  })
  .refine(
    (v) => v.status === 'inspected' || (v.reason?.trim().length ?? 0) > 0,
    { message: 'A reason is required when an area was not inspected' },
  )

export const areasRecord = (rows: Array<string>) =>
  z.object(Object.fromEntries(rows.map((r) => [r, areaResult])))

export function emptyAreas(rows: Array<string>): Record<string, AreaResult> {
  return Object.fromEntries(rows.map((r) => [r, { status: 'inspected' }]))
}

export const REINSPECTION_INTERVALS = [
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
  { value: '24', label: '24 months' },
]
