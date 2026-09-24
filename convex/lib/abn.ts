import { ConvexError } from 'convex/values'

/**
 * A CLIENT's Australian Business Number (Prompt 6.1) — the customer's, not
 * the pest business's own. That one is `businesses.abn`, free text printed on
 * the business's reports, and deliberately left unvalidated here: its seed
 * and e2e fixtures ('54 123 456 789', '11 222 333 444') fail the checksum.
 *
 * Pure, so the forms can check an ABN as it is typed with the same rule the
 * server enforces.
 */

/** The ATO's weights for the eleven digits, first to last. */
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const

/**
 * The digits of an ABN as typed, or null when it is not eleven of them.
 * Spaces and hyphens are how ABNs get written ("51 824 753 556",
 * "51-824-753-556"); anything else is not an ABN.
 */
export function abnDigits(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '')
  return /^\d{11}$/.test(digits) ? digits : null
}

/**
 * The ATO's check: subtract 1 from the first digit, weight each digit, and the
 * sum is divisible by 89. Catches a mistyped or transposed digit, which a
 * length check does not — the number that goes on an invoice.
 */
export function isValidAbn(raw: string): boolean {
  const digits = abnDigits(raw)
  if (digits === null) return false
  const sum = [...digits].reduce((total, char, i) => {
    const digit = Number(char) - (i === 0 ? 1 : 0)
    return total + digit * WEIGHTS[i]
  }, 0)
  return sum % 89 === 0
}

/**
 * A client's ABN as stored: its eleven digits, and absent when blank.
 *
 * `undefined` in means "not given"; a blank string means "none", which the
 * edit form sends to clear one. Anything else must be a real ABN.
 */
export function normaliseAbn(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (!isValidAbn(raw)) throw new ConvexError('INVALID_ABN')
  return abnDigits(raw) ?? undefined
}

/** "51 824 753 556" — how the ATO and the ABN Lookup print one. */
export function formatAbn(digits: string): string {
  const d = abnDigits(digits)
  if (d === null) return digits
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`
}
