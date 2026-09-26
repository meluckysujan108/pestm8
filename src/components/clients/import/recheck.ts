import { checkAcrossClients, recheckClient } from '#/lib/clientImport/build'
import type { ExistingIndex, ReviewClient } from '#/lib/clientImport/types'

/**
 * The review's picture of what's already in PestM8 is read once, at
 * Continue, and kept (import.tsx `against`). An undo run since — from
 * another tab, or another phone — takes clients and sites out from under
 * it: what the review calls "Already in PestM8" isn't any more, and would
 * be skipped, then missing. So the page notices one, and once it is done
 * reads PestM8 again and judges every client afresh before Import.
 */

type Against = { businessState: string; existing: ExistingIndex }

type ImportRow = { _id: string; undoneAt?: number }

/** The imports asked to be undone — done, or still going — in `rows`. */
export function undoneIds(
  rows: ReadonlyArray<ImportRow> | undefined,
): ReadonlySet<string> {
  return new Set(
    (rows ?? []).filter((row) => row.undoneAt !== undefined).map((r) => r._id),
  )
}

/**
 * Whether an import has been asked to be undone since `before`
 * (`undoneIds`) was taken — alongside the lists the review was built
 * from. By which imports, not by whether one is running now: an undo can
 * start and finish between two answers, and the page would never see it
 * running.
 */
export function undoneSince(
  rows: ReadonlyArray<ImportRow> | undefined,
  before: ReadonlySet<string>,
): boolean {
  return (rows ?? []).some(
    (row) => row.undoneAt !== undefined && !before.has(row._id),
  )
}

/**
 * Every client judged again against a new reading of PestM8, as it stands
 * — edits, fixes and left-out clients all kept — then the checks across
 * clients (`recheckClient`, `checkAcrossClients`). The address warnings
 * stay while their addresses do.
 */
export function recheckReview(
  list: Array<ReviewClient>,
  against: Against,
): Array<ReviewClient> {
  return checkAcrossClients(
    list.map((client) => recheckClient(client, against)),
  )
}

/**
 * The clients, judged again against `against`, that now send a site they
 * didn't before because it was already in PestM8 — which the address
 * checks passed over then (a site that isn't sent isn't checked), so they
 * are due one now.
 */
export function newlySent(
  list: ReadonlyArray<ReviewClient>,
  against: Against,
): Array<ReviewClient> {
  const out: Array<ReviewClient> = []
  for (const client of list) {
    const next = recheckClient(client, against)
    const freed = client.sites.some(
      (site, i) => site.duplicate === true && next.sites[i]?.duplicate !== true,
    )
    if (freed) out.push(next)
  }
  return out
}
