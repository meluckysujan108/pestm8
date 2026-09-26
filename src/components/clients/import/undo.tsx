import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import {
  IMPORT_UNDO_DAYS,
  UNDO_STUCK_MS,
} from '../../../../convex/lib/clientImport'
import { FormAlert } from '#/components/forms/FormAlert'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { useHydrated } from '#/lib/useHydrated'
import { dropIdleClientLists } from './queries'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { RecentImport } from './queries'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * Undo, as both places that offer it ask it — Recent imports, and the Done
 * screen straight after — so the promise made before the red button is the
 * same wherever it is pressed.
 */

const DAY = 24 * 60 * 60 * 1000

/**
 * Whether an import is still inside its week. The page's to work out:
 * `clientImports.list` says who may undo, and leaves the clock to the
 * browser, because a query that read the time would be cached past the
 * moment the week ran out. The server checks again when it is asked.
 */
export function withinUndoWindow(createdAt: number, now: number): boolean {
  return now - createdAt < IMPORT_UNDO_DAYS * DAY
}

type UndoRow = Pick<RecentImport, 'undoneAt' | 'undoState'> &
  Partial<Pick<RecentImport, 'undoStepAt'>>

/** Asked to be undone, and not finished yet — moving, or stopped. */
export function undoRunning(row: UndoRow): boolean {
  return row.undoneAt !== undefined && row.undoState !== 'done'
}

/** The last sign an undo gave of moving, in the server's time: its last
 * step — carrying it on marks one too — or, before the first, when it was
 * asked for. */
const markOf = (row: UndoRow) => row.undoStepAt ?? row.undoneAt

/**
 * An undo that has made no progress for far longer than a step takes: a
 * step failed, and the rest never ran. Judged by `undoStepAt`, which every
 * step marks — and carrying it on marks too, so one that has been carried
 * on reads as moving again — or, before the first step, by when it was
 * asked for. Asking again carries it on from where it stopped
 * (convex/clientImports.ts `undo`) — each step removes only what still
 * carries the import's id, so nothing goes twice.
 *
 * `now` is the server's time as the page reckons it (`UndoClock`): the
 * marks are the server's, and the server refuses to carry on an undo it
 * sees moving (`UNDO_RUNNING`).
 */
export function undoStuck(row: UndoRow, now: number): boolean {
  const moved = markOf(row)
  return undoRunning(row) && moved !== undefined && now - moved > UNDO_STUCK_MS
}

/**
 * Whether an undo holds a new file back — any undo not yet done, stopped
 * ones too. Until the undo reaches them, the clients it is taking back
 * still read as already here, so the same file again would skip them, and
 * the undo would then take them away with the rest. One that has stopped
 * still holds exactly those rows, and takes them the moment it is carried
 * on: it is offered to be carried on, not let past.
 */
export function undoUnderway(
  rows: ReadonlyArray<UndoRow> | undefined,
): boolean {
  return rows?.some(undoRunning) ?? false
}

/**
 * The undo a new file is waiting for, to say so: one that has stopped
 * first — it will hold the file back until someone carries it on — or else
 * the first one still moving. Null when nothing is being undone. Stopped as
 * the page's one clock says (`useUndoClock`).
 */
export function undoHolding<T extends UndoRow>(
  rows: ReadonlyArray<T> | undefined,
  clock: Pick<UndoClock, 'stuck'>,
): { row: T; stopped: boolean } | null {
  const running = rows?.filter(undoRunning) ?? []
  const stopped = running.find((row) => clock.stuck(row))
  if (stopped) return { row: stopped, stopped: true }
  return running.length > 0 ? { row: running[0], stopped: false } : null
}

/**
 * The time, read again every half minute while `ticking` — so a page left
 * open while an undo runs notices when it has stopped. Read once otherwise:
 * the undo week is days long.
 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/**
 * The page's one reading of the undos' clock, which every piece of it that
 * says "stopped" is handed (`useUndoClock`), so no two of them disagree.
 */
export type UndoClock = {
  /** The server's time as the page reckons it: this device's, less the
   * offset it has learnt (`sightUndos`). Read again every half minute
   * while an undo is running. For "stopped" only: a reading that arrived
   * late can make the offset minutes too big. */
  now: number
  /** This device's own time, for the undo week — days long, so a few
   * minutes' skew doesn't matter, and a wrong offset mustn't stretch it
   * (the server would refuse the undo it offered). */
  deviceNow: number
  /** Whether this undo has stopped part-way: by the server's time as
   * reckoned (`undoStuck`), or because the page has itself watched it make
   * no progress for as long, by this device's clock — so neither a slow
   * device nor a late reading can hold a stopped undo as moving for longer
   * than that. Never before the page is up: the server's render and the
   * first one here say "Undoing…" whatever either clock reads, so they
   * can't disagree. */
  stuck: (row: UndoRow & { _id?: string }) => boolean
}

export function undoClock(
  deviceNow: number,
  offset: number | undefined,
  hydrated: boolean,
  /** When the page first saw each import's current mark (`sightUndos`),
   * by this device's clock. */
  since?: ReadonlyMap<string, number>,
): UndoClock {
  const now = deviceNow - (offset ?? 0)
  const watchedStill = (row: UndoRow & { _id?: string }) => {
    const at = row._id === undefined ? undefined : since?.get(row._id)
    return at !== undefined && deviceNow - at > UNDO_STUCK_MS
  }
  return {
    now,
    deviceNow,
    stuck: (row) =>
      hydrated &&
      undoRunning(row) &&
      (undoStuck(row, now) || watchedStill(row)),
  }
}

/** What the page has seen of the undos, for `sightUndos`. */
export type UndoSightings = {
  /** The answer last looked at, so the same one isn't read twice. */
  rows: ReadonlyArray<UndoRow & { _id: string }> | undefined
  /** Each import's last mark (`markOf`), as last seen. */
  marks: ReadonlyMap<string, number | undefined>
  /** When, by this device's clock, the page first saw each import's
   * current mark — for "stopped" judged by watching (`undoClock`). */
  since: ReadonlyMap<string, number>
  /** This device's clock less the server's, as best learnt so far; unset
   * until an undo has been seen to move. */
  offset: number | undefined
}

/**
 * Learns how far this device's clock is from the server's, from the undos
 * themselves: an undo's mark is the server's time, so the moment a new one
 * is seen, this device's time less the mark is the offset — give or take
 * how long it took to arrive. Only a mark seen to change counts; one there
 * already at the first look could have been made any time before.
 *
 * Arriving takes time, so every reading is the offset or a little over, and
 * the smallest is kept: a phone that slept through a stopped undo, and
 * hears of its last step only on waking, reads it minutes late — which,
 * kept, would call the undo moving for those minutes more.
 */
export function sightUndos(
  before: UndoSightings | null,
  rows: ReadonlyArray<UndoRow & { _id: string }> | undefined,
  seenAt: number,
): UndoSightings {
  if (before && before.rows === rows) return before
  let offset = before?.offset
  const marks = new Map(before?.marks)
  const since = new Map(before?.since)
  for (const row of rows ?? []) {
    const mark = markOf(row)
    const seen = before?.marks.has(row._id) === true
    const changed = seen && mark !== before.marks.get(row._id)
    if (changed && mark !== undefined) {
      const reading = seenAt - mark
      offset = offset === undefined ? reading : Math.min(offset, reading)
    }
    if (!seen || changed) since.set(row._id, seenAt)
    marks.set(row._id, mark)
  }
  return { rows, marks, since, offset }
}

/**
 * The page's clock for its undos (`UndoClock`), from the recent imports it
 * is showing: whether one has stopped is judged against the server's time,
 * not the device's, so a phone whose clock runs ten minutes fast doesn't
 * call every undo stopped — and offer a Carry on the server turns down.
 * One that runs slow, or a reading that arrived late, can hold a stopped
 * undo as moving only until the page has watched it stand still for as
 * long as a stopped one takes to call (`undoClock`). Kept once, in the
 * page, and handed to each piece that shows an undo.
 *
 * `rows` is the query's answer as it came, not a copy: each new answer is
 * looked at once, as it is first rendered.
 */
export function useUndoClock(
  rows: ReadonlyArray<UndoRow & { _id: string }> | undefined,
): UndoClock {
  const hydrated = useHydrated()
  const deviceNow = useNow(rows?.some(undoRunning) ?? false)
  const sightings = useRef<UndoSightings | null>(null)
  // As the answer is first rendered, not in an effect after: the moment it
  // is seen is the reading, and the render that shows a new step should be
  // judged by it.
  if (sightings.current === null || sightings.current.rows !== rows) {
    sightings.current = sightUndos(sightings.current, rows, Date.now())
  }
  const { offset, since } = sightings.current
  return useMemo(
    () => undoClock(deviceNow, offset, hydrated, since),
    [deviceNow, offset, hydrated, since],
  )
}

export const UNDO_ERROR_COPY: ErrorCopy = {
  ALREADY_UNDONE: 'This import has already been undone.',
  // Carry on undoing, pressed for an undo that is moving after all — from
  // another screen, or on a clock that runs fast.
  UNDO_RUNNING: 'This undo is still going — give it a moment.',
  UNDO_EXPIRED: `It’s more than ${IMPORT_UNDO_DAYS} days since this import, so it can’t be undone any more.`,
  NO_ACCESS:
    'Only the person who ran this import, or the business owner, can undo it.',
  NOT_FOUND: 'That import isn’t there any more.',
  offline:
    'Couldn’t undo: this device is offline. Try again when you have signal.',
  default: 'Couldn’t undo the import. Check your connection and try again.',
}

/** Undo, and — for one that stopped part-way — carrying it on: the same
 * call either way. */
export function useUndoImport(businessId: Id<'businesses'>) {
  const queryClient = useQueryClient()
  const undo = useConvexMutation(api.clientImports.undo)
  const mutation = useMutation({
    mutationFn: (importId: Id<'clientImports'>) => {
      // Every step of an undo re-runs the client lists, as a batch of an
      // import does (`dropIdleClientLists`).
      dropIdleClientLists(queryClient, businessId)
      return undo({ businessId, importId })
    },
  })
  /** The import the dialog is asking about, or null while it is shut. */
  const [asking, setAsking] = useState<Id<'clientImports'> | null>(null)
  return { mutation, asking, ask: setAsking }
}

/**
 * The question before an undo. What stays is said plainly: undo keeps
 * whatever has been worked on since — a job, a report, a note someone wrote
 * — so nobody's work goes with the list it came in on.
 */
export function UndoDialog({
  undo,
}: {
  undo: ReturnType<typeof useUndoImport>
}) {
  const { asking, ask, mutation } = undo
  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && ask(null)}
      title="Undo this import?"
      body="The clients and sites it brought in go, unless a job, report or note has been made for them since — those stay."
      confirm="Undo import"
      cancel="Keep it"
      onConfirm={() => {
        if (asking) mutation.mutate(asking)
        ask(null)
      }}
    />
  )
}

/**
 * Why a new file waits, said where it would be chosen or sent on: an undo
 * still going, or one that stopped part-way — which holds it back just the
 * same (`undoUnderway`) — with the way to carry that one on, for whoever
 * may. Asked already, when the undo was started: no second question.
 */
export function UndoHold({
  businessId,
  row,
  stopped,
  then,
  className,
}: {
  businessId: Id<'businesses'>
  row: RecentImport
  stopped: boolean
  /** What waits for it: "choose a file", "continue", "import". */
  then: string
  className?: string
}) {
  const hydrated = useHydrated()
  const undo = useUndoImport(businessId)
  const pending = undo.mutation.isPending
  const file = `“${row.fileName}”`
  return (
    <div className={className}>
      <p
        role="status"
        className="text-caption text-ink-2 [overflow-wrap:anywhere]"
      >
        {!stopped
          ? `Undoing ${file} — you can ${then} once it’s done.`
          : row.canUndo
            ? `Undoing ${file} stopped part-way. Carry it on, and you can ${then} once it’s done.`
            : `Undoing ${file} stopped part-way. Whoever ran that import, or the business owner, can carry it on — you can ${then} once it’s done.`}
      </p>
      {stopped && row.canUndo && (
        <button
          type="button"
          disabled={!hydrated || pending}
          onClick={() => undo.mutation.mutate(row._id)}
          aria-label={pending ? undefined : `Carry on undoing ${row.fileName}`}
          className="mt-1 flex min-h-11 items-center text-body font-semibold text-red transition active:opacity-60 disabled:opacity-50"
        >
          {pending ? 'Undoing…' : 'Carry on undoing'}
        </button>
      )}
      <FormAlert
        error={undo.mutation.isError ? undo.mutation.error : null}
        copy={UNDO_ERROR_COPY}
        className="mt-2"
      />
    </div>
  )
}
