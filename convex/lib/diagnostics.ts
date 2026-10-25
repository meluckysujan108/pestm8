import { v } from 'convex/values'
import type { Infer } from 'convex/values'

/**
 * One note a phone made about its connection to PestM8
 * (src/lib/connectionLog.ts): when, what, and a few short details. Times and
 * states only — the phone never notes anything anyone typed.
 */
export const connectionEntry = v.object({
  /** When, in ms since the epoch, by the phone's clock. */
  t: v.number(),
  /** What happened: 'shown', 'ws-dead', 'token', 'notice', … */
  e: v.string(),
  d: v.optional(
    v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
  ),
})

export type ConnectionEntry = Infer<typeof connectionEntry>

/** The most notes one report may carry. */
export const MAX_ENTRIES = 100
const MAX_DETAILS = 8
const MAX_WORD = 120

/**
 * A report's notes cut to size, rather than refused: a phone whose report was
 * refused would keep the same notes and send them again for ever. Over-long
 * words are shortened, details past the eighth dropped, notes past the
 * hundredth left out, and a note with no real time — one `Date` cannot show —
 * dropped.
 */
export function trimEntries(
  entries: Array<ConnectionEntry>,
): Array<ConnectionEntry> {
  return entries
    .filter(({ t }) => isTime(t))
    .slice(0, MAX_ENTRIES)
    .map(({ t, e, d }) => ({
      t,
      e: e.slice(0, 40),
      ...(d
        ? {
            d: Object.fromEntries(
              Object.entries(d)
                .slice(0, MAX_DETAILS)
                .map(([key, value]) => [
                  key.slice(0, 32),
                  typeof value === 'string' ? value.slice(0, MAX_WORD) : value,
                ]),
            ),
          }
        : {}),
    }))
}

/** A time in ms since the epoch that a `Date` can show. */
export function isTime(t: number): boolean {
  return Number.isFinite(t) && t >= 0 && t <= 8.64e15
}
