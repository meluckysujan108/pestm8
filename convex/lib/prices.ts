import type { CapabilitySet } from './capabilities'

/**
 * Taking money out of what a query returns.
 *
 * `prices.see` was computed on every request and read by nothing, so every
 * price in the app was visible to every member — the toggle existed in the
 * schema, in the policy table and in the owner's head, and nowhere in the
 * code.
 *
 * The mechanism matters more than it looks. Three options and only one is
 * safe:
 *
 * - OMIT the key. `formatMoney(undefined)` renders "$NaN" in eight places, and
 *   worse: `JobDetailSheet` seeds its edit form with `String(job.price / 100)`,
 *   which becomes the string "NaN". That is truthy, so the `|| '0'` fallback
 *   below it never fires, and editing the date on that job writes `price: NaN`
 *   back — destroying the real figure and turning every total downstream of it
 *   into NaN for the owner. It would also drop a required field from an
 *   inferred return type and fail the Vercel build, which per CLAUDE.md shows
 *   up as the site quietly serving the previous build.
 * - NULL it. Renders a confident "$0", which reads as a real price. Nobody
 *   reports a bug about $0.
 * - ZERO it, and say so alongside. A client that has not been taught the flag
 *   degrades to a harmless, obviously-uninteresting $0 instead of a broken
 *   build; one that has renders "—".
 *
 * So: the key stays, the type stays `number`, and `pricesHidden` travels with
 * it.
 */
export function hidePrices(caps: CapabilitySet): boolean {
  return !caps['prices.see']
}

/** A job row with the money taken out, if it has to be. */
export function redactJob<T extends { price: number }>(
  caps: CapabilitySet,
  job: T,
): T & { pricesHidden: boolean } {
  const hidden = hidePrices(caps)
  return { ...job, price: hidden ? 0 : job.price, pricesHidden: hidden }
}

export function redactJobs<T extends { price: number }>(
  caps: CapabilitySet,
  jobs: ReadonlyArray<T>,
): Array<T & { pricesHidden: boolean }> {
  return jobs.map((job) => redactJob(caps, job))
}

/**
 * An aggregate, which cannot be zeroed the way a row can.
 *
 * A total of zero is a claim about the business; `null` is the absence of one,
 * and the client renders "—". They also have to move together with whatever
 * count sits beside them: "4 jobs awaiting invoice" next to a hidden value
 * says little, but the same pair when the count is 1 says the price exactly.
 */
export function redactTotal(caps: CapabilitySet, total: number): number | null {
  return hidePrices(caps) ? null : total
}
