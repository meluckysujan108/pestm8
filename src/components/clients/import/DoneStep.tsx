import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  CircleX,
  Download,
  MapPin,
  StickyNote,
  UserMinus,
  Users,
} from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { downloadText, rowsCsv } from '#/lib/clientImport/skipped'
import { useHydrated } from '#/lib/useHydrated'
import { recentImports } from './queries'
import { notImportedFileName, outcomeOf, rowsNotImported } from './run'
import {
  DrawnCheck,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  STEP_HEADING,
  STEP_HEADING_CLASS,
  plural,
} from './ui'
import {
  UNDO_ERROR_COPY,
  UndoDialog,
  UndoHold,
  undoHolding,
  useUndoImport,
  withinUndoWindow,
} from './undo'
import type { RunOutcome } from './run'
import type { UndoClock } from './undo'
import type { ReactNode } from 'react'
import type { ImportResult } from '../../../../convex/lib/clientImport'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { ImportSheet, ReviewClient } from '#/lib/clientImport/types'

/** How many of the clients that didn't go in are named here; the download
 * has every one. */
const NAMED = 5

function headline(outcome: RunOutcome): string {
  const { created, sites } = outcome
  if (created > 0) {
    return `${plural(created, 'client')} and ${plural(sites, 'site')} are in PestM8`
  }
  if (sites > 0) {
    return `${plural(sites, 'site')} ${sites === 1 ? 'is' : 'are'} in PestM8`
  }
  return 'Nothing new came in'
}

/**
 * The end: what went in, what was already here, what didn't make it and
 * why — and, while it can still be taken back, Undo, right where the person
 * is most likely to want it. Once undone, what went in is no longer the
 * story, so it goes, and the screen says what the undo did instead.
 */
export function DoneStep({
  businessId,
  businessSlug,
  sheet,
  review,
  results,
  importId,
  clock,
  onAnother,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  sheet: ImportSheet
  review: Array<ReviewClient>
  results: Array<ImportResult>
  importId: Id<'clientImports'> | null
  /** The page's one clock for its undos (`useUndoClock`). */
  clock: UndoClock
  onAnother: () => void
}) {
  const hydrated = useHydrated()
  const outcome = useMemo(() => outcomeOf(review, results), [review, results])
  const behind = useMemo(
    () => rowsNotImported(review, results),
    [review, results],
  )
  // Live: undo runs in steps on the server, and this says when it is done.
  const { data } = useQuery(recentImports(businessId))
  const run = importId ? data?.find((row) => row._id === importId) : undefined
  const undo = useUndoImport(businessId)

  /** The import, once someone has asked for it to be undone. */
  const undone = run?.undoneAt !== undefined ? run : null
  const takenBack = undone?.undoState === 'done'
  const stuck = undone !== null && clock.stuck(undone)
  /** Any undo not yet done — this import's, or another's, and stopped
   * ones too — holds another file back (`undoUnderway`). This import's is
   * said in its own box; another's under the buttons. */
  const holding = undoHolding(data, clock)
  const heldByAnother = holding !== null && holding.row._id !== importId
  const canUndo =
    run !== undefined &&
    run.canUndo &&
    !undone &&
    withinUndoWindow(run.createdAt, clock.deviceNow)

  const download = () => {
    const csv = rowsCsv(sheet, behind.rowNumbers, behind.reasons)
    downloadText(notImportedFileName(sheet.fileName), csv)
  }

  const lines: Array<{ Icon: typeof Users; text: string }> = []
  if (outcome.added > 0) {
    lines.push({
      Icon: Users,
      text: `New sites for ${plural(outcome.added, 'client')} already in PestM8`,
    })
  }
  if (outcome.notes > 0) {
    lines.push({ Icon: StickyNote, text: plural(outcome.notes, 'site note') })
  }
  if (outcome.skippedSites > 0) {
    lines.push({
      Icon: MapPin,
      text: `${plural(outcome.skippedSites, 'site')} already here, skipped`,
    })
  }
  if (outcome.leftOut.length > 0) {
    lines.push({
      Icon: UserMinus,
      text: `${plural(outcome.leftOut.length, 'client')} left out`,
    })
  }
  const missed = outcome.notImported

  return (
    <div className="pt-6">
      {!undone && <DrawnCheck />}
      <h2
        {...STEP_HEADING}
        className={`${undone ? '' : 'mt-5'} text-sheet-title text-ink ${STEP_HEADING_CLASS}`}
      >
        {takenBack
          ? 'This import has been undone'
          : undone
            ? 'Undoing this import'
            : headline(outcome)}
      </h2>
      <p className="mt-1.5 text-body text-muted [overflow-wrap:anywhere]">
        From {sheet.fileName}.
        {outcome.sites > 0 &&
          !undone &&
          ' They’re on the Clients page now, ready to book.'}
      </p>

      {undone && (
        <div
          role="status"
          className="mt-4 rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2"
        >
          {takenBack
            ? undoneSentence(undone.undoRemoved ?? 0, undone.undoKept ?? 0)
            : stuck
              ? 'This undo stopped part-way, so some of what came in is still here. Carry it on, and you can import another file once it’s done.'
              : 'Undoing… the clients and sites this import brought in are being taken back. You can import another file once it’s done.'}
          {stuck && undone.canUndo && importId && (
            <button
              type="button"
              onClick={() => undo.mutation.mutate(importId)}
              disabled={!hydrated || undo.mutation.isPending}
              className="mt-1 flex min-h-11 items-center font-semibold text-red transition active:opacity-60 disabled:opacity-50"
            >
              {undo.mutation.isPending ? 'Undoing…' : 'Carry on undoing'}
            </button>
          )}
        </div>
      )}

      {!undone && (lines.length > 0 || missed.length > 0) && (
        <ul className="mt-5 divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {lines.map(({ Icon, text }) => (
            <Line key={text} icon={<Icon size={17} strokeWidth={1.8} />}>
              {text}
            </Line>
          ))}
          {missed.length > 0 && (
            <Line
              icon={<CircleX size={17} strokeWidth={1.8} />}
              tone="text-red-ink"
            >
              {plural(missed.length, 'client')} couldn’t be imported
              <ul className="mt-1.5 space-y-1 text-caption text-ink-2">
                {missed.slice(0, NAMED).map((client) => (
                  <li key={client.key} className="[overflow-wrap:anywhere]">
                    <span className="font-semibold">
                      {client.name || 'No name'}
                    </span>{' '}
                    — {client.reason}
                  </li>
                ))}
                {missed.length > NAMED && (
                  <li className="text-muted">
                    and {(missed.length - NAMED).toLocaleString('en-AU')} more —
                    they’re all in the download.
                  </li>
                )}
              </ul>
            </Line>
          )}
        </ul>
      )}

      <div className="mt-6 flex flex-col gap-2">
        <Link
          to="/$businessSlug/clients"
          params={{ businessSlug }}
          className={PRIMARY_BUTTON}
        >
          Go to clients
        </Link>
        {/* Once undone, the rows that went in are out again as well: the
            file itself is the list to import from now. */}
        {!undone && behind.rowNumbers.length > 0 && (
          <button
            type="button"
            onClick={download}
            disabled={!hydrated}
            className={SECONDARY_BUTTON}
          >
            <Download aria-hidden size={18} strokeWidth={2} />
            Download rows not imported
          </button>
        )}
        <div className="mt-1 flex flex-wrap items-center justify-center gap-x-6">
          <button
            type="button"
            onClick={onAnother}
            disabled={!hydrated || holding !== null}
            className="min-h-11 text-[15px] font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
          >
            Import another file
          </button>
          {canUndo && importId && (
            <button
              type="button"
              onClick={() => undo.ask(importId)}
              disabled={!hydrated || undo.mutation.isPending}
              className="min-h-11 text-[15px] font-semibold text-red transition active:opacity-60 disabled:opacity-50"
            >
              Undo this import
            </button>
          )}
        </div>
        {heldByAnother && (
          <UndoHold
            businessId={businessId}
            row={holding.row}
            stopped={holding.stopped}
            then="import another file"
            className="flex flex-col items-center text-center"
          />
        )}
      </div>

      <FormAlert
        error={undo.mutation.isError ? undo.mutation.error : null}
        copy={UNDO_ERROR_COPY}
        className="mt-3"
      />
      <UndoDialog undo={undo} />
    </div>
  )
}

function undoneSentence(removed: number, kept: number): string {
  const back = `Undone — ${removed.toLocaleString('en-AU')} ${removed === 1 ? 'client or site' : 'clients and sites'} taken back.`
  return kept > 0
    ? `${back} ${kept.toLocaleString('en-AU')} stayed, as they’d been worked on since.`
    : back
}

function Line({
  icon,
  tone,
  children,
}: {
  icon: ReactNode
  /** For the words and the icon both; ink and a grey icon otherwise. */
  tone?: string
  children: ReactNode
}) {
  return (
    <li className={`flex gap-3 px-3.5 py-3 text-body ${tone ?? 'text-ink'}`}>
      <span aria-hidden className={`mt-0.5 shrink-0 ${tone ?? 'text-muted'}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}
