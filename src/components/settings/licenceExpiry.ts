import { daysUntilExpiry } from '../../../convex/lib/memberLicences'

/**
 * What a licence's expiry date says, in the words and colours the pages use.
 *
 * A reminder only: nothing here blocks anything. Amber from `WARN_DAYS`
 * before the last good day, red once it has passed. `today` is always the
 * date where the business is (`dayKeyOf(Date.now(), business.timezone)`),
 * never the phone's, so a licence that runs out on the 30th is expired on the
 * 1st for everyone in the business, whatever their phone is set to.
 *
 * Pure, so the rules can be tested, and so the list, the licence page, the
 * hub's badge and the Show my licence sheet cannot disagree.
 */

/** How many days before it runs out a licence turns amber. */
export const WARN_DAYS = 60

export type Expiry =
  | { state: 'none' }
  | { state: 'ok'; days: number }
  | { state: 'soon'; days: number }
  | { state: 'expired'; days: number }

export function expiryOf(expiresOn: string | undefined, today: string): Expiry {
  if (!expiresOn) return { state: 'none' }
  const days = daysUntilExpiry(expiresOn, today)
  if (days < 0) return { state: 'expired', days }
  if (days <= WARN_DAYS) return { state: 'soon', days }
  return { state: 'ok', days }
}

/**
 * The badge's words, or null for no badge: "Expired", "Last day" on the day
 * itself (0 days left reads as a mistake), "1 day", "45 days".
 */
export function expiryBadgeText(expiry: Expiry): string | null {
  if (expiry.state === 'expired') return 'Expired'
  if (expiry.state !== 'soon') return null
  if (expiry.days === 0) return 'Last day'
  return expiry.days === 1 ? '1 day' : `${expiry.days} days`
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  // The date as written, never moved by a zone: it is a calendar date.
  timeZone: 'UTC',
})

/** "2027-03-12" → "12 Mar 2027". */
export function formatExpiryDate(expiresOn: string): string {
  const [year, month, day] = expiresOn.split('-').map(Number)
  return DAY_FORMAT.format(Date.UTC(year, month - 1, day))
}

/**
 * A licence's line under its name: its number, then when it expires —
 * "PMT-4471 · Expires 12 Mar 2027", "Expired 3 Jan 2026", "No expiry".
 */
export function licenceSubtitle(
  licence: { number?: string; expiresOn?: string },
  today: string,
): string {
  const when = licence.expiresOn
    ? `${expiryOf(licence.expiresOn, today).state === 'expired' ? 'Expired' : 'Expires'} ${formatExpiryDate(licence.expiresOn)}`
    : 'No expiry'
  return licence.number ? `${licence.number} · ${when}` : when
}

/**
 * The most pressing thing about a whole wallet, for the hub's Licences row:
 * any licence expired, else any running out within `WARN_DAYS`, else nothing.
 */
export function walletExpiry(
  licences: ReadonlyArray<{ expiresOn?: string }>,
  today: string,
): 'expired' | 'soon' | null {
  let soon = false
  for (const licence of licences) {
    const { state } = expiryOf(licence.expiresOn, today)
    if (state === 'expired') return 'expired'
    if (state === 'soon') soon = true
  }
  return soon ? 'soon' : null
}
