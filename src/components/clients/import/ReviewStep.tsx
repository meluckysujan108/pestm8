import { useCallback, useMemo, useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { EmptyState } from '#/components/primitives/EmptyState'
import { FormAlert } from '#/components/forms/FormAlert'
import { importable, statusOf, summarise } from '#/lib/clientImport/convert'
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
  StepHeading,
  plural,
} from './ui'
import type {
  ImportSheet,
  ReviewClient,
  ReviewIssue,
  ReviewStatus,
} from '#/lib/clientImport/types'

/** The review's filter: its statuses, with "fine as it is" and "fine, with
 * something put right" as one — both simply go in. */
type Filter = 'all' | 'warning' | 'error' | 'duplicate' | 'ready'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'warning', label: 'Needs a look' },
  { key: 'error', label: 'Can’t import' },
  { key: 'duplicate', label: 'Already in PestM8' },
  { key: 'ready', label: 'Ready' },
]

const filterOf = (status: ReviewStatus): Filter =>
  status === 'fixed' ? 'ready' : status

/** Cards drawn at once. A 2,000-client file is 2,000 cards with an issue
 * list each; a hundred is more than a screen, and cheap. */
const PAGE = 100

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
        : all.filter((c) => filterOf(statuses.get(c.key)!) === filter),
    [all, filter, statuses],
  )

  const edit = useCallback((client: ReviewClient) => setEditing(client.key), [])
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
        <p className="mt-4 text-row-title text-ink">Checking addresses…</p>
        <p className="mt-1 text-caption text-muted">
          {total > 0
            ? `${done.toLocaleString('en-AU')} of ${plural(total, 'client')}, against Australia’s suburb list`
            : 'Against Australia’s suburb list'}
        </p>
        <div className="mt-5 w-full max-w-xs">
          <ProgressBar label="Checking addresses" done={done} total={total} />
        </div>
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
          <EmptyState
            title="Nothing left here"
            body="Everything in this list has been put right or left out."
          />
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
            disabled={!hydrated || going === 0}
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
        onClose={() => setEditing(null)}
        onSave={(client) => {
          onSave(client)
          setEditing(null)
        }}
      />
    </>
  )
}
