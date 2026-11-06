/**
 * The rules behind "2 things to check before saving", kept apart from React
 * so they can be tested without a browser.
 *
 * A warning never stops a save for good: it stops the first press, says what
 * looks wrong, and the next press with the same things still wrong saves.
 * "The same" is exact — the same fields saying the same words — so an edit
 * that changes what is wrong asks again, and one that changes nothing does
 * not make the person confirm twice. While rows a refusal put on the list
 * stand (`inject`, the matching plan's M7), a press that finds nothing it
 * hasn't already shown, in the same words, saves, a set that only shrank
 * too (`saveDecision`).
 */

/**
 * A one-tap fix. `apply` runs when it is tapped, perhaps long after the
 * check: make it call the form's latest setter (see useLatest), not one
 * closed over at check time. `focusAfter`, when given, says where focus
 * goes once it has been applied and rendered: a fix that changed what the
 * form shows (another client mode) puts it on the field it filled, rather
 * than on the panel's heading or Save.
 */
export type SaveWarningFix = {
  label: string
  apply: () => void
  focusAfter?: () => void
  /**
   * The fix opens something rather than changing the form (New Job's Open
   * #123, which asks "Discard your changes?" first): its row stays on the
   * list, and focus where it is, so a person who keeps editing is still
   * looking at what the row said. Nothing is edited, so nothing else goes.
   */
  keepsRow?: boolean
}

export type SaveWarning = {
  /** Unique within the form, e.g. `${inputId}:typo`. */
  id: string
  /** The field's name as the person sees it: "Email", "Site contact number". */
  label: string
  message: string
  /** A one-tap fix, when there is exactly one sensible one. */
  fix?: SaveWarningFix
  /** A second fix beside the first, where there are two ("Book at 12
   * Wattle St" · "Add 12 Watle St"). */
  fix2?: SaveWarningFix
  /** Puts the cursor in the field. Called inside the tap, so iOS opens the
   * keyboard. */
  focus?: () => void
  /**
   * `match`: a client the caller may already be (lib/clientMatchRows.ts),
   * not something wrong with a field. Listed after the fields' own
   * warnings, and with a footer of its own when nothing else is listed.
   * `site`: work already booked at the site (lib/siteWorkRows.ts), listed
   * last, after the match rows, with a footer of its own when it is all
   * there is.
   */
  kind?: 'match' | 'site'
  /**
   * A row counting the rest ("And 2 more"): the ids of the rows it counts,
   * read by nothing on the panel. A refusal of the save that tells only
   * what was listed, as rows of those ids or counted, says nothing new
   * (lib/sheetChecks.ts `alreadyListed`).
   */
  counts?: ReadonlyArray<string>
}

/**
 * How long a fix in the panel takes no tap once the panel appears, and Book
 * (or Save) no press once it appears or changes, in a form that asks for it
 * (`useSaveWarnings({ arm: true })`): the panel comes in above the button,
 * under the thumb that pressed it, and a second tap of a double tap would
 * otherwise land on a fix it never saw, or book what it was warned about.
 * Shown `aria-disabled` meanwhile, the button held pressed in
 * (`HELD_BUTTON`), never a silent no-op.
 */
export const FIX_ARM_MS = 400
export const SUBMIT_ARM_MS = 500

/**
 * Whether a change of what the panel shows (`before`, then `after`: the rows
 * on screen, none while it is closed) starts the hold: rows that appeared,
 * or changed, their words or their fixes, as a press's checks answered or
 * a refusal's rows were read again (`SaveGuard['refresh']`); or anything a
 * fix did (`byFix`), since the second tap of a double tap on a fix lands
 * where the fix was, on whatever has moved up there. A list that only
 * shrank, as a field was edited or the form reset, holds nothing: nothing
 * came in under a thumb, and a press then is meant.
 */
export function startsHold(
  before: ReadonlyArray<Pick<SaveWarning, 'id' | 'message' | 'fix' | 'fix2'>>,
  after: ReadonlyArray<Pick<SaveWarning, 'id' | 'message' | 'fix' | 'fix2'>>,
  byFix: boolean,
): boolean {
  if (byFix) return true
  const said = (w: (typeof after)[number]) =>
    JSON.stringify([
      w.id,
      w.message,
      w.fix?.label ?? null,
      w.fix2?.label ?? null,
    ])
  const had = new Set(before.map(said))
  return after.some((w) => !had.has(said(w)))
}

/** Whether something armed at `since` (or never, null) still takes no tap
 * at `now`. */
export function stillArmed(
  since: number | null,
  now: number,
  ms: number,
): boolean {
  return since !== null && now >= since && now - since < ms
}

/** The panel's order: the fields' own warnings first, as checked; then the
 * clients the caller may be; then the work already booked at the site. The
 * same array back when nothing moves. */
export function panelOrder<T extends Pick<SaveWarning, 'kind'>>(
  warnings: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const ordered = [
    ...warnings.filter((w) => w.kind === undefined),
    ...warnings.filter((w) => w.kind === 'match'),
    ...warnings.filter((w) => w.kind === 'site'),
  ]
  return ordered.every((w, i) => w === warnings[i]) ? warnings : ordered
}

/**
 * The line at the foot of the panel. Match rows have their own
 * (`matchFooter`, the form's, given those rows: "Use it, or press Book
 * anyway to add a new client."), with or without rows about the site's
 * work after them, which Book anyway books past as well; those rows alone
 * have theirs (`siteFooter`: "Open it, or press Book anyway to book this
 * one as well."). Anything with a field's own warning, today's.
 */
export function panelFooter<T extends Pick<SaveWarning, 'kind'>>(
  warnings: ReadonlyArray<T>,
  anywayLabel: string,
  matchFooter?: (rows: ReadonlyArray<T>) => string,
  siteFooter?: (rows: ReadonlyArray<T>) => string,
): string {
  if (warnings.every((w) => w.kind !== undefined)) {
    const matches = warnings.filter((w) => w.kind === 'match')
    if (matchFooter && matches.length > 0) return matchFooter(matches)
    if (siteFooter && matches.length === 0) return siteFooter(warnings)
  }
  return warnings.length === 1
    ? `Fix it, or press ${anywayLabel} to keep it as it is.`
    : `Fix them, or press ${anywayLabel} to keep them as they are.`
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
 * What a press of Save does, given what the checks found and what the
 * person has already been shown and confirmed (`shown`): it saves when what
 * it found is exactly what was shown, by field and words, in any order. So
 * the press after the list, with nothing changed, saves; a set that only
 * shrank with nothing edited (a check that ran out of time on one bar of
 * signal) shows what is left, and the press after that saves.
 *
 * Where rows a refusal put on the list stand (`refused`: `inject`, the
 * matching plan's M7), any set with nothing new saves, each warning one of
 * those shown, by its field and its words, so one that only shrank saves
 * too: a row gone because what it was about changed elsewhere (a booking
 * moved on another phone, the copy caught up) leaves nothing unseen, and
 * the list shows the refusal's rows alone (`fresh`), so asking again would
 * change nothing on screen at all, and the press would seem to do nothing.
 * Every other form keeps the exact rule.
 */
export function saveDecision(
  found: ReadonlyArray<Pick<SaveWarning, 'id' | 'message'>>,
  shown: ReadonlyArray<Pick<SaveWarning, 'id' | 'message'>>,
  refused = false,
): { save: true } | { save: false; signature: string } {
  if (found.length === 0) return { save: true }
  const signature = warningsSignature(found)
  if (!refused) {
    return shown.length > 0 && signature === warningsSignature(shown)
      ? { save: true }
      : { save: false, signature }
  }
  const said = new Set(shown.map((w) => JSON.stringify([w.id, w.message])))
  return found.every((w) => said.has(JSON.stringify([w.id, w.message])))
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
 * move the address inside WA, so "outside WA" stays on the list. Nor where
 * the change was about only some of them (`only`): those go, and the rest
 * stay as shown and confirmed (New Job's match rows that named the work
 * near a date since moved; those that named none were never about it).
 *
 * Returns `list` itself when nothing leaves it.
 */
export function afterEdit<T extends SourcedWarning>(
  list: ReadonlyArray<T>,
  source: string,
  fixing: { source: string; id: string } | null,
  only?: (warning: T) => boolean,
): ReadonlyArray<T> {
  const goes =
    fixing?.source === source
      ? (w: T) => w.id === fixing.id
      : (w: T) => w.source === source && (only?.(w) ?? true)
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
  /**
   * The rows a refusal put on the list (`inject`), still standing: among
   * `shown`, and counted with what each press finds, as shown and
   * confirmed, until what they were about is edited, the form is reset, or
   * a save goes through.
   */
  injected: ReadonlyArray<SourcedWarning>
  /**
   * The last refusal's rows alone, while they are what the list shows: the
   * rest of `shown` was shown and confirmed by the press it refused, so it
   * isn't said again. Null otherwise (the list shows `shown`).
   */
  fresh: ReadonlyArray<SourcedWarning> | null
  /**
   * The rows a refusal put on the list whose place a row the checks found
   * again, of the same field and id, took in other words (`withInjected`):
   * off the list, as that row says what is new, but what they named was
   * shown, so it still goes back with the next save, while a row of their
   * id is listed (`SaveGuard['refused']`).
   */
  carried: ReadonlyArray<SourcedWarning>
}

export const IDLE_SAVE_GUARD: SaveGuardState = {
  shown: [],
  open: false,
  checking: false,
  injected: [],
  fresh: null,
  carried: [],
}

const NONE_ON_SCREEN: ReadonlyArray<SourcedWarning> = []

/** What the list has on screen: nothing while it is closed; else the last
 * refusal's rows (`fresh`), or every row shown. The same array for the
 * same state. */
export function onScreen(
  state: Pick<SaveGuardState, 'shown' | 'open' | 'fresh'>,
): ReadonlyArray<SourcedWarning> {
  if (!state.open) return NONE_ON_SCREEN
  return state.fresh ?? state.shown
}

/**
 * What a press decides on (`all`): what its checks found, with the rows a
 * refusal put on the list still standing (`injected`) counted in. A row the
 * checks found of the same field and id as one of those (the same client,
 * the same job) counts as that one, shown, where it says what the person
 * was shown there (`said`: the refusal's row's own words, or those of the
 * row it took the place of), so the press after a refusal, nothing
 * changed, finds what was shown. In other words it is news, whatever its
 * id (the phone's copy caught up, and its own row now names the work at
 * the site, FW13): it stands in the refusal's row's place, for the press
 * to show, and the refusal's row is `carried`, what it named still sent
 * back.
 */
export function withInjected<T extends SourcedWarning>(
  found: ReadonlyArray<T>,
  injected: ReadonlyArray<T>,
  said: (row: T) => ReadonlyArray<string> = (row) => [row.message],
): { all: Array<T>; carried: Array<T> } {
  if (injected.length === 0) return { all: [...found], carried: [] }
  const same = (a: T, b: T) => a.source === b.source && a.id === b.id
  const carried = injected.filter((i) =>
    found.some((w) => same(w, i) && !said(i).includes(w.message)),
  )
  const stands = injected.filter((i) => !carried.includes(i))
  return {
    all: [...found.filter((w) => !stands.some((i) => same(w, i))), ...stands],
    carried,
  }
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
  // The fields a fix took off the screen while it was being applied: their
  // warnings go once it has been, unless the same field is back by then
  // (`register`ed again: another client mode drawing the same address
  // block), whose warnings stay as they were shown and confirmed.
  let leftDuringFix: Set<string> | null = null
  // The fields edited, or gone, since the last press began, and the reset
  // count then: a refusal of that press is about what they held then, so
  // its rows go on the list only for fields as they were (`inject`).
  const touched = new Set<string>()
  let pressedAt = generation
  const injectable = (source: string) =>
    live && pressedAt === generation && !touched.has(source)
  // The words each row a refusal put on the list stands for: its own, and
  // those of the row of its id it took the place of (`withInjected`).
  const saidFor = new WeakMap<SourcedWarning, ReadonlyArray<string>>()
  const said = (row: SourcedWarning) => saidFor.get(row) ?? [row.message]
  // A row `refresh` put back while it wasn't on screen (the list closed, or
  // showing a later refusal's rows alone), and the row as it was last on
  // screen. Shown is what the person was shown, and this wasn't: its words,
  // or only its fix, came in unseen. Until it is drawn, a press that finds
  // a row of its field and id shows it rather than booking past a fix
  // never seen, and `listed` says its old words.
  const seenAs = new WeakMap<SourcedWarning, SourcedWarning>()
  const asSeen = (row: SourcedWarning) => seenAs.get(row) ?? row
  const shownAsSeen = (): ReadonlyArray<SourcedWarning> =>
    state.shown.some((w) => seenAs.has(w))
      ? state.shown.map(asSeen)
      : state.shown
  const unseenIn = (rows: ReadonlyArray<SourcedWarning>): boolean => {
    const unseen = state.shown.filter((w) => seenAs.has(w))
    return rows.some((w) =>
      unseen.some((u) => u.source === w.source && u.id === w.id),
    )
  }

  const drop = (source: string) => {
    if (state.checking) editedWhileChecking = true
    touched.add(source)
    publish({ shown: afterEdit(state.shown, source, null) })
  }

  const publish = (next: Partial<SaveGuardState>) => {
    const merged = { ...state, ...next }
    // A refusal's rows stand only while they are on the list: an edit of
    // what they were about, or a reset, takes them with the rest. One
    // carried, while a row of its id is.
    if (merged.shown !== state.shown) {
      const stands = (w: SourcedWarning) => merged.shown.includes(w)
      if (!merged.injected.every(stands)) {
        merged.injected = merged.injected.filter(stands)
      }
      if (merged.fresh && !merged.fresh.every(stands)) {
        merged.fresh = merged.fresh.filter(stands)
      }
      const keyListed = (c: SourcedWarning) =>
        merged.shown.some((w) => w.source === c.source && w.id === c.id)
      if (!merged.carried.every(keyListed)) {
        merged.carried = merged.carried.filter(keyListed)
      }
    }
    // The last refusal's rows all gone: what is left was confirmed by the
    // press it refused, and the list is as it was then, closed.
    if (merged.fresh && merged.fresh.length === 0) {
      merged.fresh = null
      merged.open = false
    }
    if (merged.shown.length === 0) merged.open = false
    // Drawn now: what it says is what was shown.
    for (const w of onScreen(merged)) seenAs.delete(w)
    if (
      merged.shown === state.shown &&
      merged.open === state.open &&
      merged.checking === state.checking &&
      merged.injected === state.injected &&
      merged.fresh === state.fresh &&
      merged.carried === state.carried
    ) {
      return
    }
    state = merged
    onChange(state)
  }

  const edited = (
    source: string,
    only?: (warning: SourcedWarning) => boolean,
  ) => {
    if (state.checking) editedWhileChecking = true
    touched.add(source)
    publish({ shown: afterEdit(state.shown, source, fixing, only) })
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
    touched.clear()
    pressedAt = generation
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
      // What a refusal put on the list counts as found again, until what
      // it was about is edited: the press after it, with nothing changed,
      // finds what was shown, and saves. A row of its id found in other
      // words is news, and takes its place (`carried`).
      const { all, carried } = withInjected(found, state.injected, said)
      // A row read again off screen (`refresh`) was never shown as it
      // reads now: this press shows it, and the next decides.
      const saves =
        !unseenIn(all) &&
        saveDecision(
          all,
          state.shown,
          state.injected.length > 0 || state.carried.length > 0,
        ).save
      // A second look only shows what it found, even nothing: the save
      // waits for a press the browser and the form check afresh.
      if (lookingAgain || !saves) {
        publish({
          shown: all,
          open: true,
          fresh: null,
          ...(carried.length > 0
            ? { carried: [...state.carried, ...carried] }
            : {}),
        })
        return
      }
      // The browser checked the form at the press, not since. It says what
      // is wrong itself, and puts the cursor there.
      if (waited && form && !form.reportValidity()) {
        if (all.length === 0) publish({ shown: [] })
        return
      }
      publish(all.length === 0 ? { shown: [] } : { open: false, fresh: null })
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
    /**
     * Puts rows from a refusal of the last press's save on the list (the
     * server found what the phone's checks couldn't: New Job's "Already a
     * client" and "Already booked", the matching plan's M7), as `source`'s,
     * and opens it on them. Each takes the place of a row of `source`'s
     * with the same id. They count as shown: the next press with nothing
     * changed finds them again (`withInjected`), so its signature is what
     * was shown, and it saves; one that finds a row of their id in words
     * neither they nor the row they took the place of said shows it, as
     * news, and they are `carried`. The list shows them alone (`fresh`):
     * what else was on it was shown and confirmed by the press refused.
     *
     * They go as any row of `source`'s does: an edit of what it checks, a
     * fix, the field gone, a reset, or a save that goes through. And they
     * are never put on the list for a form changed since the press: false,
     * and nothing done, when `source` was edited or gone since it began, or
     * the form was reset; the refusal was about what it held then.
     */
    inject(source: string, rows: ReadonlyArray<SaveWarning>): boolean {
      if (!injectable(source)) return false
      if (rows.length === 0) return true
      const tagged = rows.map((w): SourcedWarning => ({ ...w, source }))
      for (const row of tagged) {
        const before = state.shown.find(
          (w) => w.source === source && w.id === row.id,
        )
        saidFor.set(row, [row.message, ...(before ? said(before) : [])])
      }
      const replaced = (w: SourcedWarning) =>
        w.source === source && tagged.some((t) => t.id === w.id)
      publish({
        shown: [...state.shown.filter((w) => !replaced(w)), ...tagged],
        injected: [...state.injected.filter((w) => !replaced(w)), ...tagged],
        fresh: tagged,
        open: true,
      })
      return true
    },
    /** Whether `inject(source, …)` would put rows on the list now: nothing
     * `source`'s check reads edited or gone since the last press began, and
     * no reset. Rows it would turn down wait for nothing (lib/sheetChecks.ts
     * `sendChecked`'s `mayShow`). */
    mayInject(source: string): boolean {
      return injectable(source)
    },
    /**
     * Puts rows a refusal put on the list back as they read now, each in
     * place of the one of `source`'s with its id still standing as a
     * refusal's (`injected`): New Job's, once the client list holds the
     * client a row's fix books at, however long after the refusal. A row
     * no longer standing isn't put back, and nothing else moves: the list
     * open or not as it was, the same rows on screen. A row whose words or
     * fixes changed starts the hold (`startsHold`), so a fix that came in
     * takes no tap unseen. One put back off screen (the list closed, or
     * showing a later refusal's rows alone) wasn't shown: until it is
     * drawn, a press counts it in the words it was shown in (and `listed`
     * says those), so the next press shows it, with its fix, rather than
     * booking past it. False where none of `rows` stands.
     */
    refresh(source: string, rows: ReadonlyArray<SaveWarning>): boolean {
      if (!live) return false
      const swaps = new Map<string, SourcedWarning>()
      for (const row of rows) {
        if (
          state.injected.some((w) => w.source === source && w.id === row.id)
        ) {
          swaps.set(row.id, { ...row, source })
        }
      }
      if (swaps.size === 0) return false
      const drawn = onScreen(state)
      for (const w of state.injected) {
        const next = w.source === source ? swaps.get(w.id) : undefined
        if (!next) continue
        saidFor.set(next, [next.message, ...said(w)])
        // Not on screen: still the row as it was last drawn, to a press.
        if (!drawn.includes(w)) seenAs.set(next, asSeen(w))
      }
      const swap = (w: SourcedWarning) =>
        w.source === source && state.injected.includes(w)
          ? (swaps.get(w.id) ?? w)
          : w
      publish({
        shown: state.shown.map(swap),
        injected: state.injected.map(swap),
        fresh: state.fresh ? state.fresh.map(swap) : null,
      })
      return true
    },
    /** The rows refusals put on the list, still standing, at this moment:
     * what the next save sends back as seen (`inject`). */
    injected(): ReadonlyArray<SourcedWarning> {
      return state.injected
    },
    /** The rows refusals put on the list whose names go back with the next
     * save, at this moment: those standing (`injected`), and those a row
     * the checks found again in other words took the place of (`carried`),
     * while a row of their id is listed. */
    refused(): ReadonlyArray<SourcedWarning> {
      return state.carried.length === 0
        ? state.injected
        : [...state.injected, ...state.carried]
    },
    /** Every row shown and confirmed, on screen or not, at this moment: one
     * read again off screen (`refresh`) in the words it was shown in. */
    listed(): ReadonlyArray<SourcedWarning> {
      return shownAsSeen()
    },
    /**
     * Whether the form is as it was at the last press: nothing a check
     * reads edited or gone since it began, and no reset. The gate `inject`
     * keeps for the check refused, for every check: a save sent again by
     * itself (lib/sheetChecks.ts `sendChecked`) goes only then.
     */
    asPressed(): boolean {
      return live && pressedAt === generation && touched.size === 0
    },
    register(source: string, check: SaveCheck) {
      registry.set(source, check)
      return () => {
        if (registry.get(source) === check) registry.delete(source)
      }
    },
    /** The values `source`'s check reads changed; or, with `only`, what
     * only the warnings it picks were about (`afterEdit`). */
    edited,
    /** The field `source` names has gone from the form (a Business client
     * turned Person): its warnings point at nothing. */
    removed(source: string) {
      touched.add(source)
      if (leftDuringFix) leftDuringFix.add(source)
      else drop(source)
    },
    /**
     * Applies a warning's one-tap fix (or its second, `fix2`) and takes that
     * warning, only, off the list. `commit` runs the change and renders it
     * (flushSync in React): the field's own edit notice arrives inside it,
     * and must know it is this fix's.
     *
     * A match row's fix (`kind: 'match'`) takes every row its check gave:
     * they were all about the caller as typed, and the booking is now on a
     * client. So does a fix of a row about the site's work (`kind: 'site'`,
     * New Job's Book at): they were about where the booking was, and it is
     * now at another site. A field the fix took off the screen takes its
     * warnings with it, once the fix is rendered, unless the same field is
     * back by then; those kept are still the rows the field gone made, so
     * their own fixes must reach the field on screen when tapped
     * (VerifiedAddressFields' `useFixOnScreen`), not the one gone.
     *
     * A fix that `keepsRow` only runs: the list is as it was.
     */
    fix(
      warning: SourcedWarning,
      commit: (change: () => void) => void,
      which: 'fix' | 'fix2' = 'fix',
    ) {
      const apply = warning[which]?.apply
      if (!apply) return
      if (warning[which]?.keepsRow) {
        apply()
        return
      }
      fixing =
        warning.kind === 'match' || warning.kind === 'site'
          ? null
          : { source: warning.source, id: warning.id }
      leftDuringFix = new Set()
      try {
        commit(() => {
          apply()
          // Here too, for a fix that leaves the values its check watches as
          // they were.
          edited(warning.source)
        })
      } finally {
        fixing = null
        const left = leftDuringFix
        leftDuringFix = null
        for (const source of left) if (!registry.has(source)) drop(source)
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
