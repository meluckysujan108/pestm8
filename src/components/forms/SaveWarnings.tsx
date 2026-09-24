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
  IDLE_SAVE_GUARD,
  createSaveGuard,
  warningsSignature,
} from './saveWarningRules'
import type { ReactNode } from 'react'
import type {
  SaveCheck,
  SaveGuard,
  SaveGuardState,
  SaveWarning,
  SourcedWarning,
} from './saveWarningRules'

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

type Fields = Pick<SaveGuard, 'register' | 'edited' | 'removed'> & {
  fix: (warning: SourcedWarning) => void
}

export type SaveWarningsController = {
  /**
   * Put in the form's onSubmit, passing its event. Stops the browser's own
   * submit, runs every registered check (in parallel, each given 3 s; one
   * that fails or is still going says nothing), then either calls `save` or
   * shows what the checks found. The next press with exactly the same
   * things found saves.
   *
   * When every check answers without the network — offline, under a test
   * runner, or no async checks registered — `save` runs in the same tick.
   * When they answer later, `save` runs only if nothing was typed in the
   * meantime and the form still passes the browser's own checks; otherwise
   * the press shows what is found now and saves nothing. `reset` drops a
   * press still waiting.
   *
   * If `save` returns a promise (`mutateAsync`), a rejected save keeps the
   * warnings confirmed, so Retry after "Could not save" does not ask again.
   */
  guard: SaveGuard['guard']
  /** 'Checking…' while checks run, 'Save anyway' while warnings show, else
   * `label`. */
  saveLabel: (label: string) => string
  /** A check is still answering. */
  checking: boolean
  /** The warnings on show; empty when the panel is closed. */
  warnings: ReadonlyArray<SaveWarning>
  /** Forget every warning shown or confirmed, e.g. when a sheet is reused
   * for another record or another client mode, and cancel a press still
   * waiting on its checks. */
  reset: () => void
  /** @internal The registry the fields reach through the provider. */
  fields: Fields
}

const FieldsContext = createContext<Fields | null>(null)
const ControllerContext = createContext<SaveWarningsController | null>(null)

export function useSaveWarnings(): SaveWarningsController {
  const [state, setState] = useState<SaveGuardState>(IDLE_SAVE_GUARD)
  // The rules and their state live outside React (saveWarningRules.ts),
  // made once per form; React only renders what they say.
  const [core] = useState(() => createSaveGuard(setState))
  useEffect(() => core.attach(), [core])

  const fields = useMemo<Fields>(
    () => ({
      register: core.register,
      edited: core.edited,
      removed: core.removed,
      // Applied and rendered at once, so the row is gone and the count
      // right before focus moves.
      fix: (warning) => core.fix(warning, flushSync),
    }),
    [core],
  )

  const { shown, open, checking } = state
  const visible = open && shown.length > 0

  const saveLabel = useCallback(
    (label: string) =>
      checking ? 'Checking…' : visible ? 'Save anyway' : label,
    [checking, visible],
  )

  return useMemo(
    () => ({
      guard: core.guard,
      saveLabel,
      checking,
      warnings: visible ? shown : [],
      reset: core.reset,
      fields,
    }),
    [core, saveLabel, checking, visible, shown, fields],
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
 * warnings leave the list, since they were about what used to be there
 * (after a tapped fix, only the warning it fixed). They leave too when the
 * field unmounts.
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

  // When the field leaves the form, so do its warnings: a row for a field
  // no longer on screen can be neither fixed nor focused. Not in the effect
  // above, whose cleanup runs on every render, as `check` is new each time.
  useEffect(() => {
    if (!fields) return
    return () => fields.removed(source)
  }, [fields, source])

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
                  // Takes this row off, only: the field's other warnings
                  // were not what this fixed.
                  controller.fields.fix(w as SourcedWarning)
                  // The button just pressed is gone. Focus goes to what is
                  // left to read, or to Save when nothing is: the panel is
                  // rendered by now, so its heading is there only if rows
                  // are.
                  if (heading.current) heading.current.focus()
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
