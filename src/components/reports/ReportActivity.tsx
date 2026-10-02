import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  FilePenLine,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { RowPending } from '#/components/shell/Pending'
import { formatWhen } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { senderName } from './SendSheet'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * A finished report's history: who started, edited, finalised, corrected,
 * deleted and restored it, and in whose account — newest first, the newest
 * few and the rest a tap away.
 *
 * It was a tab of its own (Logs) that also listed every email, word for word
 * as the Email tab did. Its emails are now said once, under Email, from the
 * delivery rows, which hold every send — the ones that failed or never went
 * included — so they are left out here: they only pushed "Finalised" out of
 * sight. Each entry leads with what happened as a glyph and names who did it
 * in words; the member's colour dot that led these before was a red or blue
 * dot, which read as a status.
 */
export function ReportActivity({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}) {
  const logs = useQuery(
    convexQuery(api.auditLog.forEntity, {
      businessId,
      entityType: 'reports',
      entityId: reportId,
    }),
  )
  const entries = logs.data?.filter(
    (entry) => !entry.action.startsWith('report.email'),
  )
  const [all, setAll] = useState(false)

  return (
    <section aria-labelledby="report-activity">
      <h2 id="report-activity" className="section-label mb-2">
        Activity
      </h2>
      {entries === undefined && logs.isError ? (
        <LoadFailed what="the activity" onRetry={() => void logs.refetch()} />
      ) : entries === undefined ? (
        // Loading is not the same as nothing: "Nothing recorded yet" under a
        // report that was finalised is a lie an owner would believe.
        <div className="rounded-2xl border border-hairline bg-surface shadow-elevation">
          <RowPending />
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-surface px-3.5 py-3 text-body text-grey-ink shadow-elevation">
          Nothing recorded yet
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface shadow-elevation">
          {(all ? entries : entries.slice(0, SHOWN)).map((entry) => (
            <ActivityRow key={entry._id} entry={entry} />
          ))}
          {entries.length > SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAll((open) => !open)}
                className="flex min-h-11 w-full items-center rounded-b-2xl px-3.5 text-body font-semibold text-blue outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
              >
                {all ? 'Show fewer' : `Show all ${entries.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/** The newest few, before "Show all". */
const SHOWN = 3

/** Every action a report's own history can hold, in words — a code on
 * screen tells an owner reading who did what nothing — and the glyph it leads
 * with (one concept, one glyph: design system §8). */
const ACTION: Partial<Record<string, { label: string; glyph: ReactNode }>> = {
  'report.create': {
    label: 'Started',
    glyph: <Plus size={15} strokeWidth={2.2} />,
  },
  'report.edit': {
    label: 'Edited',
    glyph: <Pencil size={15} strokeWidth={2} />,
  },
  'report.edit.byOwner': {
    label: 'Edited by the owner',
    glyph: <Pencil size={15} strokeWidth={2} />,
  },
  'report.optionRenamed': {
    label: 'An answer was renamed with its list',
    glyph: <Pencil size={15} strokeWidth={2} />,
  },
  'report.switchVersion': {
    label: 'Moved to the current form',
    glyph: <RefreshCw size={15} strokeWidth={2} />,
  },
  'report.restart': {
    label: 'Started again on the current form',
    glyph: <RefreshCw size={15} strokeWidth={2} />,
  },
  'report.amend': {
    label: 'Started as a correction',
    glyph: <FilePenLine size={15} strokeWidth={2} />,
  },
  'report.delete': {
    label: 'Moved to Recently Deleted',
    glyph: <Trash2 size={15} strokeWidth={2} />,
  },
  'report.restore': {
    label: 'Restored',
    glyph: <RotateCcw size={15} strokeWidth={2} />,
  },
  'report.purge': {
    label: 'Deleted for good',
    glyph: <Trash2 size={15} strokeWidth={2} />,
  },
  'report.finalise': {
    label: 'Finalised',
    glyph: <Lock size={15} strokeWidth={2} />,
  },
}

function ActivityRow({
  entry,
}: {
  entry: {
    _id: string
    action: string
    at: number
    actorName?: string
    /** The account it was done in, when that was not the actor's own.
     * Absent from a backend older than switching's audit rows. */
    onBehalfOfName?: string
  }
}) {
  const timezone = useBusinessTimezone()
  const known = ACTION[entry.action]

  return (
    <li className="flex gap-2.5 px-3.5 py-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-2"
      >
        {known?.glyph ?? <Pencil size={15} strokeWidth={2} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-body text-ink">
          {known?.label ?? entry.action}
        </p>
        {/* Who, not just what: who did it — and in whose account — is the
            question a history answers. */}
        <p className="text-caption text-grey-ink">
          {entry.actorName
            ? `${senderName(entry.actorName, entry.onBehalfOfName)} · `
            : ''}
          {formatWhen(entry.at, timezone)}
        </p>
      </div>
    </li>
  )
}
