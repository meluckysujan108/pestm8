/**
 * The Recycle bin, as the rest of the backend sees it.
 *
 * A client, property, job or Recurring Job that someone deleted keeps its row
 * with `deletedAt` set (schema.ts `binFields`), until it is restored or wiped
 * for good. Everything that went with it is marked the same way — a client's
 * properties, their jobs and series, the notes and draft reports about them —
 * so a reader decides from the row in hand and never from its parents.
 *
 * The rule every reader follows:
 *
 * - Lists, searches, counts and pickers leave binned rows out. In an indexed
 *   read that is `.filter((q) => q.eq(q.field('deletedAt'), undefined))`
 *   BEFORE `.take` or `.paginate`, so a bounded read still returns a full
 *   page; in memory it is `!isBinned(row)`.
 * - A read by id treats a binned row as missing (`unbinned`), and a write refuses
 *   it the way it refuses a missing one. The bin page is the one reader that
 *   asks for binned rows on purpose.
 *
 * What is deliberately NOT filtered: the engine's own bookkeeping. A binned
 * visit of a Recurring Job still occupies its occurrence (recurrences.ts), so
 * the nightly run does not book a second one in its place, and a client
 * number stays taken while its client is in the bin, so restoring it cannot
 * collide. A finalised report is never binned at all — it is a record the
 * business may have to keep, and only the owner deleting it on its own takes
 * it away (reports.softDelete) — so it keeps pointing at a binned property,
 * and prints what it froze at finalise.
 */

/** Whether a row is in the Recycle bin. */
export function isBinned(row: { deletedAt?: number }): boolean {
  return row.deletedAt !== undefined
}

/** The row, or null when it is missing or in the bin — for a read by id. */
export function unbinned<T extends { deletedAt?: number }>(
  row: T | null,
): T | null {
  return row === null || isBinned(row) ? null : row
}
