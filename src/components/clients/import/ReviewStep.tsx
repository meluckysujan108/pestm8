import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { EmptyState } from '#/components/primitives/EmptyState'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  bucketOf,
  importable,
  statusOf,
  summarise,
} from '#/lib/clientImport/convert'
import { downloadText, rowsCsv } from '#/lib/clientImport/skipped'
import { useHydrated } from '#/lib/useHydrated'
import { EditClientSheet } from './EditClientSheet'
import { ReviewCard } from './ReviewCard'
import { notImportedFileName, rowsNotImported } from './run'
import {
  BottomBar,
  PRIMARY_BUTTON,
  ProgressBar,
  SECONDARY_BUTTON,
  STEP_HEADING,
  STEP_HEADING_CLASS,
  StepHeading,
  plural,
} from './ui'
import type { ReactNode } from 'react'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { ReviewBucket } from '#/lib/clientImport/convert'
import type {
  ImportSheet,
  ReviewClient,
  ReviewIssue,
} from '#/lib/clientImport/types'

/** The review's filter: its statuses, with "fine as it is" and "fine, with
 * something put right" as one — both simply go in — and the clients left
 * out on their own, whatever they were: leaving one out is dealing with it,
 * so it leaves "Can't import" or "Needs a look" as a fix would. */
type Filter = 'all' | 'warning' | 'error' | 'duplicate' | 'ready' | 'excluded'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'warning', label: 'Needs a look' },
  { key: 'error', label: 'Can’t import' },
  { key: 'duplicate', label: 'Already in PestM8' },
  { key: 'ready', label: 'Ready' },
  { key: 'excluded', label: 'Left out' },
]

const filterOf = (bucket: ReviewBucket): Filter =>
  bucket === 'fixed' ? 'ready' : bucket

/** Cards drawn at once. A 2,000-client file is 2,000 cards with an issue
 * list each; a hundred is more than a screen, and cheap. */
const PAGE = 100

/** Reading PestM8 again after an undo (`RecheckNote`), turned down. */
const RECHECK_COPY: ErrorCopy = {
  offline:
    'This device is offline, so the review can’t check what’s in PestM8 since the undo. Check again when you have signal.',
  default:
    'Couldn’t read what’s in PestM8 since the undo, so Import waits. Check again in a moment.',
}

/**
 * Why Import waits once an undo is done (recheck.ts): what's in PestM8 is
 * being read again, as the review's picture of it is from before the undo
 * — or that read failed, with the way to try it again. The page hands it to
 * the review as `wait`.
 */
export function RecheckNote({
  error,
  onRetry,
}: {
  /** Why the last read failed; null while it is under way. */
  error: unknown
  onRetry: () => void
}) {
  const hydrated = useHydrated()
  if (error === null || error === undefined) {
    return (
      <p role="status" className="mb-3 text-caption text-ink-2">
        Checking what’s in PestM8 again after the undo…
      </p>
    )
  }
  return (
    <div className="mb-3">
      <FormAlert error={error} copy={RECHECK_COPY} />
      <button
        type="button"
        onClick={onRetry}
        disabled={!hydrated}
        className="mt-1 min-h-11 text-[15px] font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
      >
        Check again
      </button>
    </div>
  )
}

/**
 * Step three: every client the file makes, before any of it is saved —
 * grouped, tidied, and checked against the suburb tables and against what
 * PestM8 already holds. Filtered by what needs doing, fixed one tap at a
 * time or in the edit sheet, and left out where it isn't wanted.
 */
export function ReviewStep({
  sheet,
  clients,
  progress,
  checkFailed,
  businessState,
  wait,
  onFix,
  onSave,
  onToggle,
  onBack,
  onImport,
}: {
  sheet: ImportSheet
  /** Null while the addresses are being checked. */
  clients: Array<ReviewClient> | null
  progress: { done: number; total: number } | null
  /** The suburb tables couldn't be read: nothing was checked against them. */
  checkFailed: boolean
  businessState: string
  /** Why Import has to wait, while it does: an import being undone
   * (`UndoHold`) since the review was built — what it says is already in
   * PestM8 may be going — and then PestM8 being read again (`RecheckNote`). */
  wait?: ReactNode
  onFix: (client: ReviewClient, issue: ReviewIssue) => void
  onSave: (client: ReviewClient) => void
  onToggle: (client: ReviewClient) => void
  onBack: () => void
  onImport: () => void
}) {
  const hydrated = useHydrated()
  const [filter, setFilter] = useState<Filter>('all')
  const [shown, setShown] = useState(PAGE)
  const [editing, setEditing] = useState<string | null>(null)

  const all = clients ?? []
  const statuses = useMemo(
    () => new Map(all.map((client) => [client.key, statusOf(client)])),
    [all],
  )
  const counts = useMemo(() => {
    const by = summarise(all)
    return { ...by, ready: by.ready + by.fixed }
  }, [all])
  const going = useMemo(() => all.filter(importable).length, [all])
  const behind = useMemo(() => rowsNotImported(all), [all])
  const visible = useMemo(
    () =>
      filter === 'all'
        ? all
        : all.filter((c) => filterOf(bucketOf(c)) === filter),
    [all, filter],
  )

  /** The Edit button the sheet was opened from, which focus goes back to
   * when it shuts (`returnFocusRef`); and the card beside it, for when a
   * save takes that card out of the filter, its button with it. */
  const editedFrom = useRef<HTMLElement | null>(null)
  const beside = useRef<HTMLElement | null>(null)
  const edit = useCallback((client: ReviewClient, from: HTMLElement) => {
    const card = from.closest('li')
    editedFrom.current = from
    beside.current = (card?.nextElementSibling ??
      card?.previousElementSibling ??
      null) as HTMLElement | null
    setEditing(client.key)
  }, [])
  // After every change to the list, before the sheet has finished sliding
  // away: a button that has gone hands over to the card beside it, or to
  // the step's heading when there is none (`STEP_HEADING`).
  useEffect(() => {
    if (editedFrom.current?.isConnected !== false) return
    editedFrom.current = beside.current?.isConnected
      ? beside.current
      : document.querySelector<HTMLElement>('[data-step-heading]')
  })
  const editingClient = editing
    ? (all.find((client) => client.key === editing) ?? null)
    : null

  if (!clients) {
    const done = progress?.done ?? 0
    const total = progress?.total ?? 0
    return (
      <div
        role="status"
        className="mt-16 flex flex-col items-center px-6 text-center"
      >
        <LoaderCircle
          aria-hidden
          size={28}
          className="animate-spin text-muted motion-reduce:animate-none"
        />
        {/* Where focus goes after Continue (`focusStepHeading`): the
            button that had it has gone with the Match step. */}
        <h2
          {...STEP_HEADING}
          className={`mt-4 text-row-title text-ink ${STEP_HEADING_CLASS}`}
        >
          {progress ? 'Checking addresses…' : 'Checking what’s in PestM8…'}
        </h2>
        <p className="mt-1 text-caption text-muted">
          {progress
            ? `${done.toLocaleString('en-AU')} of ${plural(total, 'client')}, against Australia’s suburb list`
            : 'So nothing already here comes in twice'}
        </p>
        <div className="mt-5 w-full max-w-xs">
          <ProgressBar label="Checking addresses" done={done} total={total} />
        </div>
        {/* With no signal, what's in PestM8 waits for it; this is the way
            out meanwhile. */}
        <button
          type="button"
          onClick={onBack}
          disabled={!hydrated}
          className="mt-4 min-h-11 text-[15px] font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
        >
          Change the columns
        </button>
      </div>
    )
  }

  const download = () => {
    const csv = rowsCsv(sheet, behind.rowNumbers, behind.reasons)
    downloadText(notImportedFileName(sheet.fileName), csv)
  }

  return (
    <>
      <StepHeading
        title="Check what’s coming in"
        lede={`${plural(all.length, 'client')} from ${plural(sheet.rows.length, 'row')} of ${sheet.fileName}. Fix what you can here or leave it out — nothing is saved until you press Import.`}
      />
      <button
        type="button"
        onClick={onBack}
        disabled={!hydrated}
        className="mt-1 min-h-11 text-[15px] font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
      >
        Change the columns
      </button>

      {checkFailed && (
        <FormAlert className="mt-2">
          The addresses couldn’t be checked against the suburb list just now, so
          they’ll go in as they are. To check them, change the columns and
          continue again.
        </FormAlert>
      )}

      <div role="group" aria-label="Show" className="mt-3 flex flex-wrap gap-2">
        {FILTERS.filter(
          (f) => f.key === 'all' || f.key === filter || counts[f.key] > 0,
        ).map((f) => {
          const on = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              disabled={!hydrated}
              onClick={() => {
                setFilter(f.key)
                setShown(PAGE)
              }}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition active:scale-[.97] disabled:opacity-60 ${
                on
                  ? 'border-blue/30 bg-blue/12 text-blue'
                  : 'border-hairline bg-surface text-ink-2'
              }`}
            >
              {f.label}
              <span className={`tabular-nums ${on ? '' : 'text-muted'}`}>
                {counts[f.key].toLocaleString('en-AU')}
              </span>
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4">
          {filter === 'excluded' ? (
            <EmptyState
              title="Nothing left out"
              body="Every client you left out is back in."
            />
          ) : (
            <EmptyState
              title="Nothing left here"
              body="Everything in this list has been put right or left out."
            />
          )}
        </div>
      ) : (
        <ul aria-label="Clients" className="mt-4 flex flex-col gap-2.5">
          {visible.slice(0, shown).map((client) => (
            <ReviewCard
              key={client.key}
              client={client}
              status={statuses.get(client.key)!}
              hydrated={hydrated}
              onEdit={edit}
              onToggle={onToggle}
              onFix={onFix}
            />
          ))}
        </ul>
      )}

      {visible.length > shown && (
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => setShown((n) => n + PAGE)}
          className={`${SECONDARY_BUTTON} mt-3 w-full`}
        >
          Show {Math.min(PAGE, visible.length - shown)} more
          <span className="font-normal text-muted">
            of {(visible.length - shown).toLocaleString('en-AU')}
          </span>
        </button>
      )}

      <BottomBar>
        {wait}
        <div className="flex gap-2">
          {behind.rowNumbers.length > 0 && (
            <button
              type="button"
              onClick={download}
              disabled={!hydrated}
              aria-label="Download rows that won’t import"
              title="Download rows that won’t import"
              className={`${SECONDARY_BUTTON} shrink-0 max-sm:w-12 max-sm:px-0`}
            >
              <Download aria-hidden size={18} strokeWidth={2} />
              <span className="max-sm:sr-only">Rows that won’t import</span>
            </button>
          )}
          <button
            type="button"
            onClick={onImport}
            disabled={!hydrated || going === 0 || Boolean(wait)}
            className={`${PRIMARY_BUTTON} min-w-0 flex-1`}
          >
            {going === 0
              ? 'Nothing to import'
              : `Import ${plural(going, 'client')}`}
          </button>
        </div>
      </BottomBar>

      <EditClientSheet
        client={editingClient}
        businessState={businessState}
        returnFocusRef={editedFrom}
        onClose={() => setEditing(null)}
        onSave={(client) => {
          onSave(client)
          setEditing(null)
        }}
      />
    </>
  )
}
