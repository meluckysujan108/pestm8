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

/** A warning with the field registration that produced it, so editing that
 * field takes its warnings off the list. */
export type SourcedWarning = SaveWarning & { source: string }

/**
 * What stays on the list after the field `source` registered is edited.
 * Normally every warning it raised goes: they were about what used to be
 * there. Not while one of its fixes is being applied (`fixing`): that edit
 * answers only the warning whose fix it is. A postcode put right does not
 * move the address inside WA, so "outside WA" stays on the list.
 *
 * Returns `list` itself when nothing leaves it.
 */
export function afterEdit<T extends SourcedWarning>(
  list: ReadonlyArray<T>,
  source: string,
  fixing: { source: string; id: string } | null,
): ReadonlyArray<T> {
  const goes =
    fixing?.source === source
      ? (w: T) => w.id === fixing.id
      : (w: T) => w.source === source
  return list.some(goes) ? list.filter((w) => !goes(w)) : list
}

/** The form a press of Save came from, as far as the guard uses it. */
export type PressedForm = {
  reportValidity: () => boolean
  addEventListener: (type: 'input', listener: () => void) => void
  removeEventListener: (type: 'input', listener: () => void) => void
}

/**
 * The form a submit event is for. Taken when the press happens: React
 * clears `currentTarget` once the handler returns, and the save it guards
 * may run seconds later.
 */
export function pressedForm(
  event: { currentTarget?: unknown } | null | undefined,
): PressedForm | null {
  const target = event?.currentTarget as Partial<PressedForm> | null
  return typeof target?.reportValidity === 'function' &&
    typeof target.addEventListener === 'function' &&
    typeof target.removeEventListener === 'function'
    ? (target as PressedForm)
    : null
}

/** What the panel and the Save button show. */
export type SaveGuardState = {
  /** What the person has been shown, less anything whose field they have
   * edited since. */
  shown: ReadonlyArray<SourcedWarning>
  /** Whether the list is on screen. It closes on the press that saves, but
   * the warnings stay confirmed, so a save that fails and is retried does
   * not ask a second time. */
  open: boolean
  /** A check is still answering. */
  checking: boolean
}

export const IDLE_SAVE_GUARD: SaveGuardState = {
  shown: [],
  open: false,
  checking: false,
}

/**
 * The state behind useSaveWarnings, without React, so what a press does
 * can be tested without a browser. `onChange` is told each new state.
 *
 * A press's checks may answer seconds after it, and three things can happen
 * in that time that the save must not ignore:
 *
 * - The form is reset (another client mode, the sheet closed): the press
 *   was about a form that is no longer there, so it neither saves nor shows.
 * - Something is typed: what the checks found is about values that have
 *   gone, and the browser's own checks (a required name, a four-digit
 *   postcode) and the form's (NewJobSheet's missing client) ran only at the
 *   press. So that press does not save. The checks run again on what is
 *   there now, their answer shows, and the next press decides.
 * - The form is changed in a way no check watches and no typing reaches,
 *   e.g. from a picker in another layer: the browser checks the form again
 *   before saving.
 */
export function createSaveGuard(onChange: (state: SaveGuardState) => void) {
  const registry = new Map<string, SaveCheck>()
  let state = IDLE_SAVE_GUARD
  let editedWhileChecking = false
  // Bumped by reset(); a press whose checks answer after it drops them.
  let generation = 0
  let live = true
  let fixing: { source: string; id: string } | null = null

  const publish = (next: Partial<SaveGuardState>) => {
    const merged = { ...state, ...next }
    if (merged.shown.length === 0) merged.open = false
    if (
      merged.shown === state.shown &&
      merged.open === state.open &&
      merged.checking === state.checking
    ) {
      return
    }
    state = merged
    onChange(state)
  }

  const edited = (source: string) => {
    if (state.checking) editedWhileChecking = true
    publish({ shown: afterEdit(state.shown, source, fixing) })
  }

  const guard = (
    event:
      | { preventDefault: () => void; currentTarget?: unknown }
      | null
      | undefined,
    save: () => unknown,
  ) => {
    event?.preventDefault()
    if (state.checking) return
    const form = pressedForm(event)
    const started = generation
    const current = () => live && generation === started

    // Read from the registry each run: a check closes over its field's
    // value, and a second run is for values typed since the first.
    const checks = () =>
      [...registry].map(([source, check]): SaveCheck => (signal) => {
        const tag = (found: Array<SaveWarning>) =>
          found.map((w) => ({ ...w, source }))
        const result = check(signal)
        return isThenable<Array<SaveWarning>>(result)
          ? Promise.resolve(result).then(tag)
          : tag(result)
      })

    const decide = (
      found: Array<SourcedWarning>,
      waited: boolean,
      lookingAgain: boolean,
    ) => {
      // Something changed while the checks ran: look again at what is
      // there now, and keep looking until nothing changes during a look.
      if (editedWhileChecking) {
        run(true)
        return
      }
      const decision = saveDecision(
        found,
        state.shown.length > 0 ? warningsSignature(state.shown) : null,
      )
      // A second look only shows what it found, even nothing: the save
      // waits for a press the browser and the form check afresh.
      if (lookingAgain || !decision.save) {
        publish({ shown: found, open: true })
        return
      }
      // The browser checked the form at the press, not since. It says what
      // is wrong itself, and puts the cursor there.
      if (waited && form && !form.reportValidity()) {
        if (found.length === 0) publish({ shown: [] })
        return
      }
      publish(found.length === 0 ? { shown: [] } : { open: false })
      const result = save()
      if (isThenable(result)) {
        // Saved: nothing is confirmed any more, so the same warning on a
        // later edit of this still-open form is shown again. Failed: kept.
        result.then(
          () => current() && publish({ shown: [] }),
          () => {},
        )
      }
    }

    const run = (lookingAgain: boolean) => {
      editedWhileChecking = false
      const found = runSaveChecks(checks()) as
        Array<SourcedWarning> | Promise<Array<SourcedWarning>>
      if (!isThenable<Array<SourcedWarning>>(found)) {
        decide(found, false, lookingAgain)
        return
      }
      // Typing in a field with no check of its own (a client name) counts
      // as an edit too. 'input', not 'change': a text box's change can
      // arrive on blur, after the press, for a value typed before it; every
      // real edit, a tick box or a list too, fires input.
      const typed = () => {
        editedWhileChecking = true
      }
      form?.addEventListener('input', typed)
      publish({ checking: true })
      void found.then((list) => {
        form?.removeEventListener('input', typed)
        if (!current()) return
        publish({ checking: false })
        decide(list, true, lookingAgain)
      })
    }

    run(false)
  }

  return {
    guard,
    /** Forget every warning shown or confirmed, and any press still waiting
     * on its checks. */
    reset() {
      generation += 1
      editedWhileChecking = false
      publish({ shown: [], checking: false })
    },
    register(source: string, check: SaveCheck) {
      registry.set(source, check)
      return () => {
        if (registry.get(source) === check) registry.delete(source)
      }
    },
    /** The values `source`'s check reads changed. */
    edited,
    /** The field `source` names has gone from the form (a Business client
     * turned Person): its warnings point at nothing. */
    removed(source: string) {
      if (state.checking) editedWhileChecking = true
      publish({ shown: afterEdit(state.shown, source, null) })
    },
    /**
     * Applies a warning's one-tap fix and takes that warning, only, off the
     * list. `commit` runs the change and renders it (flushSync in React):
     * the field's own edit notice arrives inside it, and must know it is
     * this fix's.
     */
    fix(warning: SourcedWarning, commit: (change: () => void) => void) {
      const apply = warning.fix?.apply
      if (!apply) return
      fixing = { source: warning.source, id: warning.id }
      try {
        commit(() => {
          apply()
          // Here too, for a fix that leaves the values its check watches as
          // they were.
          edited(warning.source)
        })
      } finally {
        fixing = null
      }
    },
    /** The form is on screen; the returned function says it has gone. */
    attach() {
      live = true
      return () => {
        live = false
      }
    },
  }
}

export type SaveGuard = ReturnType<typeof createSaveGuard>
