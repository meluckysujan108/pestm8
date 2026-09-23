import { ConvexError } from 'convex/values'

/**
 * Long enough for any work-order or PO format a facilities portal issues
 * ("WO-448120", "PO 4500123456", "SC#12345-03"), short enough that a pasted
 * paragraph is refused rather than printed on an invoice.
 */
export const MAX_WORK_ORDER_LENGTH = 64

/**
 * A client's work order as stored: trimmed, and absent when blank.
 *
 * Free text on purpose — every client's portal numbers its own way, so there
 * is no format to check beyond the length. `undefined` in means "not given";
 * a blank string means "none", which callers use to clear one.
 */
export function normaliseWorkOrder(
  raw: string | undefined,
): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MAX_WORK_ORDER_LENGTH) {
    throw new ConvexError('INVALID_WORK_ORDER')
  }
  return trimmed
}
