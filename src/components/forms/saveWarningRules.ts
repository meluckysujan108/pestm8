/**
 * The rules behind "2 things to check before saving", kept apart from React
 * so they can be tested without a browser.
 *
 * A warning never stops a save for good: it stops the first press, says what
 * looks wrong, and the next press with the same things still wrong saves.
 * "The same" is exact — the same fields saying the same words — so an edit
 * that changes what is wrong asks again, and one that changes nothing does
 * not make the person confirm twice.
 */

export type SaveWarning = {
  /** Unique within the form, e.g. `${inputId}:typo`. */
  id: string
  /** The field's name as the person sees it: "Email", "Site contact number". */
  label: string
  message: string
  /** A one-tap fix, when there is exactly one sensible one. `apply` runs
   * when the row is tapped, perhaps long after the check: make it call the
   * form's latest setter (see useLatest), not one closed over at check time. */
  fix?: { label: string; apply: () => void }
  /** Puts the cursor in the field. Called inside the tap, so iOS opens the
   * keyboard. */
  focus?: () => void
}

/**
 * A check a field runs when Save is pressed. Return the array straight away
 * when no network is involved: a form whose checks all answer at once saves
 * in the same tick, with no "Checking…" flash. `signal` is aborted when the
 * time allowed runs out.
 */
export type SaveCheck = (
  signal: AbortSignal,
) => Array<SaveWarning> | Promise<Array<SaveWarning>>

/** How long any one check may take. On one bar of signal a check that is
 * still thinking says nothing, and the save goes ahead. */
export const SAVE_CHECK_TIMEOUT_MS = 3000

/** Identifies a set of warnings by which fields said what, in any order. */
export function warningsSignature(
  warnings: ReadonlyArray<Pick<SaveWarning, 'id' | 'message'>>,
): string {
  return JSON.stringify(
    warnings.map((w) => [w.id, w.message]).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
}

/**
 * What a press of Save does, given what the checks found and the set the
 * person has already been shown (its signature, or null for none).
 */
export function saveDecision(
  found: ReadonlyArray<SaveWarning>,
  shownSignature: string | null,
): { save: true } | { save: false; signature: string } {
  if (found.length === 0) return { save: true }
  const signature = warningsSignature(found)
  return signature === shownSignature
    ? { save: true }
    : { save: false, signature }
}

export function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Runs every check, in parallel. A check that throws, or is still going when
 * `timeoutMs` is up, counts as having found nothing: a check is never the
 * reason a technician cannot save.
 *
 * Returns the warnings directly when every check answered synchronously —
 * the offline checks, and all of them under a test runner — so the form can
 * save in the same tick; otherwise a promise.
 */
export function runSaveChecks(
  checks: ReadonlyArray<SaveCheck>,
  timeoutMs: number = SAVE_CHECK_TIMEOUT_MS,
): Array<SaveWarning> | Promise<Array<SaveWarning>> {
  const controller = new AbortController()
  const results = checks.map((check) => {
    try {
      return check(controller.signal)
    } catch {
      return []
    }
  })
  if (!results.some((r) => isThenable(r))) {
    return (results as Array<Array<SaveWarning>>).flat()
  }

  let giveUp: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    giveUp = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  const settled = results.map(async (r) => {
    if (!isThenable<Array<SaveWarning>>(r)) return r
    const answer = await Promise.race([
      Promise.resolve(r).catch(() => [] as Array<SaveWarning>),
      timedOut,
    ])
    return answer === 'timeout' ? [] : answer
  })
  return Promise.all(settled).then((lists) => {
    clearTimeout(giveUp)
    return lists.flat()
  })
}
