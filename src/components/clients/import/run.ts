import { IMPORT_BATCH_SIZE } from '../../../../convex/lib/clientImport'
import { importable, statusOf } from '#/lib/clientImport/convert'
import type { ImportResult } from '../../../../convex/lib/clientImport'
import type { ReviewClient } from '#/lib/clientImport/types'

/**
 * The arithmetic of sending an import and saying how it went, kept apart
 * from the screens so it can be tested without one: the batches, where to
 * carry on from after a failure, the totals on the Done screen, and which of
 * the file's rows didn't go in.
 */

/** The clients to send, `IMPORT_BATCH_SIZE` at a time, in the file's order. */
export function toBatches<T>(
  items: Array<T>,
  size = IMPORT_BATCH_SIZE,
): Array<Array<T>> {
  const batches: Array<Array<T>> = []
  for (let at = 0; at < items.length; at += size) {
    batches.push(items.slice(at, at + size))
  }
  return batches
}

/**
 * Sends the batches from `from` on, one after another, and returns where it
 * got to: the index of the first batch not yet confirmed, which is
 * `batches.length` when every one landed.
 *
 * One at a time, never side by side: each batch's "is this site already
 * here?" has to see what the one before it wrote. A batch counts as landed
 * only once the server has answered for it, and `landed` is told before
 * the next is sent — so a retry after a failure starts at the batch that
 * failed and never sends a confirmed one twice. A failure is thrown as it
 * came; `landed` has already said how far it got.
 */
export async function sendBatches<T, TResult>(
  batches: Array<Array<T>>,
  from: number,
  send: (batch: Array<T>) => Promise<Array<TResult>>,
  landed: (index: number, results: Array<TResult>) => void,
  stopped: () => boolean = () => false,
): Promise<number> {
  let at = from
  while (at < batches.length) {
    if (stopped()) return at
    const results = await send(batches[at])
    landed(at, results)
    at += 1
  }
  return at
}

/** What the Done screen says, worked out from what the server answered. */
export type RunOutcome = {
  /** New clients. */
  created: number
  /** Clients already in PestM8 that gained a site. */
  added: number
  /** Sites written, on new clients and existing ones alike. */
  sites: number
  notes: number
  /** Sites already in PestM8: the ones the review knew about and didn't
   * send, and the ones the server found when it looked. */
  skippedSites: number
  /** Every client that didn't go in, with why: refused by the server, or
   * never sent — it couldn't be imported as it was, or was left out. */
  notImported: Array<{ key: string; name: string; reason: string }>
}

const NOT_SENT = 'Not sent — the import stopped before this one'

/** The first thing stopping a client, in the review's words. */
function whyNot(client: ReviewClient): string {
  if (!client.included) return 'Left out'
  if (statusOf(client) === 'duplicate') return 'Already in PestM8'
  const error = client.issues.find(
    (issue) =>
      issue.level === 'error' &&
      (issue.siteIndex === undefined ||
        !client.sites[issue.siteIndex]?.duplicate),
  )
  return error?.message ?? 'Couldn’t be imported as it was'
}

export function outcomeOf(
  review: Array<ReviewClient>,
  results: Array<ImportResult>,
): RunOutcome {
  const byKey = new Map(review.map((client) => [client.key, client]))
  const outcome: RunOutcome = {
    created: 0,
    added: 0,
    sites: 0,
    notes: 0,
    skippedSites: 0,
    notImported: [],
  }

  for (const result of results) {
    outcome.sites += result.sitesCreated
    outcome.notes += result.notesCreated
    outcome.skippedSites += result.sitesSkipped
    if (result.status === 'created') outcome.created += 1
    if (result.status === 'added') outcome.added += 1
    if (result.status === 'failed') {
      outcome.notImported.push({
        key: result.key,
        name: byKey.get(result.key)?.name ?? '',
        reason: result.reason ?? 'Refused by PestM8',
      })
    }
  }

  const sent = new Set(results.map((result) => result.key))
  for (const client of review) {
    if (sent.has(client.key)) {
      // Sites the review already knew were here, and so never sent.
      outcome.skippedSites += client.sites.filter((s) => s.duplicate).length
      continue
    }
    if (!client.included) {
      outcome.notImported.push({
        key: client.key,
        name: client.name,
        reason: 'Left out',
      })
      continue
    }
    if (statusOf(client) === 'duplicate') {
      outcome.skippedSites += client.sites.length
      continue
    }
    outcome.notImported.push({
      key: client.key,
      name: client.name,
      // Importable, but the import stopped before its batch went.
      reason: importable(client) ? NOT_SENT : whyNot(client),
    })
  }
  return outcome
}

/**
 * The file's rows behind the clients that didn't go in, each with why —
 * for the person to put right in their spreadsheet and import again.
 *
 * Before the import (`results` absent): every client that won't be sent.
 * After it: those, and the ones the server refused or found already here.
 * Rows of a client that went in are never listed, even when one of its
 * sites was already here: importing that row again would change nothing.
 */
export function rowsNotImported(
  review: Array<ReviewClient>,
  results?: Array<ImportResult>,
): { rowNumbers: Array<number>; reasons: Map<number, string> } {
  const answered = new Map(results?.map((result) => [result.key, result]))
  const reasons = new Map<number, string>()

  for (const client of review) {
    const result = answered.get(client.key)
    let reason: string | null = null
    if (result) {
      if (result.status === 'failed') {
        reason = result.reason ?? 'Refused by PestM8'
      } else if (result.status === 'skipped') {
        reason = 'Already in PestM8'
      }
    } else if (!importable(client)) {
      reason = whyNot(client)
    } else if (results) {
      reason = NOT_SENT
    }
    if (reason === null) continue
    for (const row of client.rowNumbers) reasons.set(row, reason)
  }

  return {
    rowNumbers: [...reasons.keys()].sort((a, b) => a - b),
    reasons,
  }
}

/** "clients.csv" → "clients-not-imported.csv". */
export function notImportedFileName(fileName: string): string {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, '').trim() || 'clients'
  return `${stem}-not-imported.csv`
}
