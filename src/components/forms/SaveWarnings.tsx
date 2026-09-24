import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import {
  isThenable,
  runSaveChecks,
  saveDecision,
  warningsSignature,
} from './saveWarningRules'
import type { ReactNode } from 'react'
import type { SaveCheck, SaveWarning } from './saveWarningRules'

export type { SaveCheck, SaveWarning } from './saveWarningRules'

/**
 * "2 things to check before saving": the warnings a form collects from its
 * fields when Save is pressed, shown above the button, with Save then reading
 * "Save anyway".
 *
 * The pieces:
 *
 *   const warnings = useSaveWarnings()
 *   <SaveWarningsProvider value={warnings}>
 *     <form onSubmit={(e) => warnings.guard(e, () => save.mutateAsync(args))}>
 *       <EmailInput … />            // registers its own save check
 *       <SaveWarningsPanel />
 *       <button type="submit">{warnings.saveLabel('Save client')}</button>
 *     </form>
 *   </SaveWarningsProvider>
 *
 * A field registers a check with `useSaveCheck(fieldId, check, [value])`.
 * The rules for when a press saves live in saveWarningRules.ts; this is the React
 * around them.
 *
 * Deliberately not a dialog. The office person reads an address back to a
 * caller while fixing it, so the form stays usable with the list showing, and
 * each row puts the cursor in its field.
 */

/** A warning with the registration that produced it, so editing that field
 * takes its warnings off the list. */
type Sourced = SaveWarning & { source: string }

type Fields = {
  register: (source: string, check: SaveCheck) => () => void
  edited: (source: string) => void
}

export type SaveWarningsController = {
  /**
   * Put in the form's onSubmit. Stops the browser's own submit, runs every
   * registered check (in parallel, each given 3 s; one that fails or is
   * still going says nothing), then either calls `save` or shows what the
   * checks found. The next press with exactly the same things found saves.
   *
   * When every check answers without the network — offline, under a test
   * runner, or no async checks registered — `save` runs in the same tick.
   *
   * If `save` returns a promise (`mutateAsync`), a rejected save keeps the
   * warnings confirmed, so Retry after "Could not save" does not ask again.
   */
  guard: (
    event: { preventDefault: () => void } | null | undefined,
    save: () => unknown,
  ) => void
  /** 'Checking…' while checks run, 'Save anyway' while warnings show, else
   * `label`. */
  saveLabel: (label: string) => string
  /** A check is still answering. */
  checking: boolean
  /** The warnings on show; empty when the panel is closed. */
  warnings: ReadonlyArray<SaveWarning>
  /** Forget every warning shown or confirmed, e.g. when a sheet is reused
   * for another record. */
  reset: () => void
  /** @internal The registry the fields reach through the provider. */
  fields: Fields
}

const FieldsContext = createContext<Fields | null>(null)
const ControllerContext = createContext<SaveWarningsController | null>(null)

export function useSaveWarnings(): SaveWarningsController {
  const registry = useRef(new Map<string, SaveCheck>())
  // `seen`: what the person has been shown, less anything whose field they
  // have edited since. A press that finds exactly this saves. `open`: whether
  // the list is on screen — it closes on that saving press, but `seen` stays,
  // so a save that fails and is retried does not ask a second time.
  const seen = useRef<ReadonlyArray<Sourced>>([])
  const [shown, setShown] = useState<ReadonlyArray<Sourced>>([])
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const busy = useRef(false)
  const editedWhileChecking = useRef(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const setSeen = useCallback((next: ReadonlyArray<Sourced>) => {
    seen.current = next
    setShown(next)
    if (next.length === 0) setOpen(false)
  }, [])

  const fields = useMemo<Fields>(
    () => ({
      register(source, check) {
        registry.current.set(source, check)
        return () => {
          if (registry.current.get(source) === check) {
            registry.current.delete(source)
          }
        }
      },
      edited(source) {
        if (busy.current) editedWhileChecking.current = true
        if (seen.current.some((w) => w.source === source)) {
          setSeen(seen.current.filter((w) => w.source !== source))
        }
      },
    }),
    [setSeen],
  )

  const guard = useCallback<SaveWarningsController['guard']>(
    (event, save) => {
      event?.preventDefault()
      if (busy.current) return

      // Read from the registry each run: a check closes over its field's
      // value, and a second run is for values typed since the first.
      const checks = () =>
        [...registry.current].map(([source, check]): SaveCheck => (signal) => {
          const tag = (found: Array<SaveWarning>) =>
            found.map((w) => ({ ...w, source }))
          const result = check(signal)
          return isThenable<Array<SaveWarning>>(result)
            ? Promise.resolve(result).then(tag)
            : tag(result)
        })

      const decide = (found: Array<SaveWarning>, retried: boolean) => {
        if (!live.current) return
        // Something was typed while the checks ran, so what they found is
        // about values no longer there. Once more, with what is there now.
        if (editedWhileChecking.current && !retried) {
          editedWhileChecking.current = false
          run(true)
          return
        }
        const before = seen.current
        const decision = saveDecision(
          found,
          before.length > 0 ? warningsSignature(before) : null,
        )
        if (!decision.save) {
          setSeen(found as Array<Sourced>)
          setOpen(true)
          return
        }
        if (found.length === 0) setSeen([])
        else setOpen(false)
        const result = save()
        if (isThenable(result)) {
          // Saved: nothing is confirmed any more, so the same warning on a
          // later edit of this still-open form is shown again. Failed: kept.
          result.then(
            () => live.current && setSeen([]),
            () => {},
          )
        }
      }

      const run = (retried: boolean) => {
        const found = runSaveChecks(checks())
        if (!isThenable<Array<SaveWarning>>(found)) {
          decide(found, retried)
          return
        }
        busy.current = true
        editedWhileChecking.current = false
        setChecking(true)
        void Promise.resolve(found).then((list) => {
          busy.current = false
          if (live.current) setChecking(false)
          decide(list, retried)
        })
      }

      run(false)
    },
    [setSeen],
  )

  const reset = useCallback(() => setSeen([]), [setSeen])
  const visible = open && shown.length > 0

  const saveLabel = useCallback(
    (label: string) =>
      checking ? 'Checking…' : visible ? 'Save anyway' : label,
    [checking, visible],
  )

  return useMemo(
    () => ({
      guard,
      saveLabel,
      checking,
      warnings: visible ? shown : [],
      reset,
      fields,
    }),
    [guard, saveLabel, checking, visible, shown, reset, fields],
  )
}

export function SaveWarningsProvider({
  value,
  children,
}: {
  value: SaveWarningsController
  children: ReactNode
}) {
  return (
    <FieldsContext.Provider value={value.fields}>
      <ControllerContext.Provider value={value}>
        {children}
      </ControllerContext.Provider>
    </FieldsContext.Provider>
  )
}

/**
 * Registers `check` to run when the form's Save is pressed. `source` names
 * the field (its input id does) and must be unique in the form. `deps` are
 * the values the check reads: when any of them changes, that field's
 * warnings leave the list, since they were about what used to be there.
 *
 * Pass `null` for no check. Outside a SaveWarningsProvider it does nothing,
 * so a field works in a form that has not adopted the panel.
 *
 * The check should return its array straight away whenever it needs no
 * network, so the form saves in the same tick; see SaveCheck.
 */
export function useSaveCheck(
  source: string,
  check: SaveCheck | null,
  deps: ReadonlyArray<unknown>,
): void {
  const fields = useContext(FieldsContext)

  useEffect(() => {
    if (!fields || !check) return
    return fields.register(source, check)
  }, [fields, source, check])

  const before = useRef<ReadonlyArray<unknown> | null>(null)
  useEffect(() => {
    const previous = before.current
    before.current = deps
    if (
      fields &&
      previous !== null &&
      (previous.length !== deps.length ||
        previous.some((d, i) => !Object.is(d, deps[i])))
    ) {
      fields.edited(source)
    }
  })
}

/**
 * The latest value, for a warning's `fix` and `focus`. Those run when the
 * row is tapped, maybe long after the check that made them: a fix that
 * called an `onChange` closed over the form as it was at Save would put back
 * whatever was typed elsewhere since.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/**
 * The list, for just above the form's submit button. Renders nothing until a
 * press of Save finds something.
 *
 * When it appears, focus moves to its heading, so a screen reader reads out
 * what was found and the next Tab reaches the first fix. A row's tap puts
 * the cursor in its field, inside the tap so iOS brings the keyboard up; its
 * fix applies the fix and takes the row away.
 */
export function SaveWarningsPanel({
  className,
  anywayLabel = 'Save anyway',
}: {
  className?: string
  /** What the form's own button reads while warnings show, so the line at
   * the foot names the button that is actually there ("Book anyway"). */
  anywayLabel?: string
}) {
  const controller = useContext(ControllerContext)
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const warnings = controller?.warnings ?? []
  const signature = warnings.length > 0 ? warningsSignature(warnings) : null

  // A new set of warnings is a new thing to read. One that only shrank, a fix
  // applied or a field edited, is not: focus stays where the person put it.
  const announced = useRef<ReadonlyArray<string>>([])
  useEffect(() => {
    if (signature === null) {
      announced.current = []
      return
    }
    const ids = warnings.map((w) => w.id)
    const shrank = ids.every((id) => announced.current.includes(id))
    announced.current = ids
    if (!shrank) heading.current?.focus()
    // `warnings` is read through the signature, which changes with it.
  }, [signature])

  if (!controller || warnings.length === 0) return null

  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-orange-ink ${className ?? ''}`}
    >
      <h3
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="pt-1 font-semibold outline-none"
      >
        {warnings.length === 1
          ? '1 thing to check before saving'
          : `${warnings.length} things to check before saving`}
      </h3>
      <ul className="flex flex-col">
        {warnings.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center gap-x-3">
            {w.focus ? (
              <button
                type="button"
                onClick={() => w.focus?.()}
                className="flex min-h-11 min-w-0 flex-1 items-center text-left"
              >
                <span>
                  <span className="font-semibold">{w.label}:</span> {w.message}
                </span>
              </button>
            ) : (
              <p className="flex min-h-11 min-w-0 flex-1 items-center">
                <span>
                  <span className="font-semibold">{w.label}:</span> {w.message}
                </span>
              </p>
            )}
            {w.fix && (
              <button
                type="button"
                onClick={(e) => {
                  const form = e.currentTarget.closest('form')
                  const fix = w.fix
                  if (!fix) return
                  const { source } = w as Sourced
                  // Applied and rendered now, so the row is gone and the
                  // count right before focus moves. Taken off the list here
                  // too, for a fix that leaves the values its check watches
                  // as they were.
                  flushSync(() => {
                    fix.apply()
                    controller.fields.edited(source)
                  })
                  // The button just pressed is gone. Focus goes to what is
                  // left to read, or to Save when nothing is.
                  const left = warnings.some(
                    (other) => (other as Sourced).source !== source,
                  )
                  if (left) heading.current?.focus()
                  else
                    form?.querySelector<HTMLElement>('[type="submit"]')?.focus()
                }}
                className="inline-flex min-h-11 items-center font-semibold text-blue-ink underline underline-offset-2"
              >
                {w.fix.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="pb-1 text-grey-ink">
        {warnings.length === 1
          ? `Fix it, or press ${anywayLabel} to keep it as it is.`
          : `Fix them, or press ${anywayLabel} to keep them as they are.`}
      </p>
    </section>
  )
}
