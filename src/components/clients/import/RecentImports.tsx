import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSpreadsheet } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { RowBadge } from '#/components/settings/ui'
import { useHydrated } from '#/lib/useHydrated'
import { dateTimeFormat } from '../../../../convex/lib/dates'
import { recentImports } from './queries'
import { plural } from './ui'
import {
  UNDO_ERROR_COPY,
  UndoDialog,
  useUndoImport,
  withinUndoWindow,
} from './undo'
import type { RecentImport } from './queries'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * The business's last few imports, under the file picker: what each brought
 * in, and — for the week after, to whoever ran it or the owner — Undo. The
 * place to come back to when a list turns out to have gone in wrong.
 */
export function RecentImports({
  businessId,
  timezone,
}: {
  businessId: Id<'businesses'>
  timezone: string
}) {
  const hydrated = useHydrated()
  const { data } = useQuery(recentImports(businessId))
  const undo = useUndoImport(businessId)
  // Read once per visit. The week is days long; a page left open past its
  // end is refused by the server, which says so.
  const [now] = useState(() => Date.now())

  if (!data || data.length === 0) return null

  const failedId = undo.mutation.isError ? undo.mutation.variables : null

  return (
    <section className="mt-8" aria-labelledby="recent-imports">
      <h2 id="recent-imports" className="section-label mb-2 px-1">
        Recent imports
      </h2>
      <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {data.map((row) => {
          const undoable =
            row.canUndo &&
            row.undoneAt === undefined &&
            withinUndoWindow(row.createdAt, now)
          const pending =
            undo.mutation.isPending && undo.mutation.variables === row._id
          return (
            <li key={row._id} className="px-3.5 py-3">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-muted"
                >
                  <FileSpreadsheet size={17} strokeWidth={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body text-ink">{row.fileName}</p>
                  <p className="truncate text-caption text-muted">
                    {summary(row, timezone)}
                  </p>
                </div>
                <State row={row} />
                {undoable && (
                  <button
                    type="button"
                    disabled={!hydrated || pending}
                    onClick={() => undo.ask(row._id)}
                    aria-label={pending ? undefined : `Undo ${row.fileName}`}
                    className="min-h-11 shrink-0 rounded-lg px-2 text-[15px] font-semibold text-red transition active:opacity-60 disabled:opacity-50"
                  >
                    {pending ? 'Undoing…' : 'Undo'}
                  </button>
                )}
              </div>
              {failedId === row._id && (
                <FormAlert
                  error={undo.mutation.error}
                  copy={UNDO_ERROR_COPY}
                  className="mt-2"
                />
              )}
            </li>
          )
        })}
      </ul>
      <UndoDialog undo={undo} />
    </section>
  )
}

/** "212 clients · 240 sites · 26 Sep · Jo" — and, once undone, what undo
 * left where it was. */
function summary(row: RecentImport, timezone: string): string {
  // In the business's time zone, as every date in the app is: the server's
  // render and the phone's then agree.
  const date = dateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(row.createdAt)
  const kept = row.undoState === 'done' ? (row.undoKept ?? 0) : 0
  return [
    plural(row.clients, 'client'),
    plural(row.sites, 'site'),
    date,
    row.byName || null,
    kept > 0 ? `${kept} kept, as they’d been worked on` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Undone, or on its way there. Nothing for an import that stands. */
function State({ row }: { row: RecentImport }) {
  if (row.undoneAt === undefined) return null
  return row.undoState === 'done' ? (
    <RowBadge tone="grey">Undone</RowBadge>
  ) : (
    <RowBadge tone="amber">Undoing…</RowBadge>
  )
}
