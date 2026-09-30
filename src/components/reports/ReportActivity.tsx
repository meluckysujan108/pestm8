import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  Check,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  TriangleAlert,
  X,
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
 * A finished report's history: everything done to it, newest first — who
 * started, edited, finalised, corrected and emailed it, and in whose account.
 *
 * One list at the foot of the page, the newest few and the rest a tap away,
 * where it was a tab of its own that repeated the Email tab's sends word for
 * word. An email here is one line — what, to whom, who and when — and its
 * copy, new addresses and failure are said once, in the Email list. Each
 * entry leads with what happened as a glyph (a lock, a send, a
 * warning) and names who did it in words: the member's colour dot that led
 * these before was a red or blue dot beside "Emailed", which read as a status.
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
  const entries = logs.data
  const [all, setAll] = useState(false)

  return (
    <section aria-labelledby="report-activity">
      <h2 id="report-activity" className="section-label mb-2">
        Activity
      </h2>
      {entries === undefined && logs.isError ? (
        <LoadFailed what="the activity" onRetry={() => void logs.refetch()} />
      ) : entries === undefined ? (
        // Loading is not the same as nothing: "Nothing yet" under a report
        // that was finalised and emailed is a lie an owner checking who sent
        // it where would believe.
        <div className="rounded-2xl border border-hairline bg-surface shadow-elevation">
          <RowPending />
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-surface px-3.5 py-3 text-body text-grey-ink shadow-elevation">
          Nothing recorded yet.
        </p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {(all ? entries : entries.slice(0, SHOWN)).map((entry) => (
            <ActivityRow key={entry._id} entry={entry} />
          ))}
          {entries.length > SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAll((open) => !open)}
                className="flex min-h-11 w-full items-center px-3.5 text-body font-semibold text-blue transition active:bg-surface-2"
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

type Kind =
  | 'start'
  | 'edit'
  | 'redo'
  | 'lock'
  | 'send'
  | 'warn'
  | 'bin'
  | 'back'
  | 'yes'
  | 'no'

/** Every action a report's history can hold, in words — a code on screen
 * tells an owner reading who did what nothing — and the glyph it leads with. */
const ACTION: Partial<Record<string, { label: string; kind: Kind }>> = {
  'report.create': { label: 'Started', kind: 'start' },
  'report.edit': { label: 'Edited', kind: 'edit' },
  'report.edit.byOwner': { label: 'Edited by the owner', kind: 'edit' },
  'report.optionRenamed': {
    label: 'An answer was renamed with its list',
    kind: 'edit',
  },
  'report.switchVersion': { label: 'Moved to the current form', kind: 'redo' },
  'report.restart': {
    label: 'Started again on the current form',
    kind: 'redo',
  },
  'report.amend': { label: 'Started as a correction', kind: 'edit' },
  'report.delete': { label: 'Moved to Recently Deleted', kind: 'bin' },
  'report.restore': { label: 'Restored', kind: 'back' },
  'report.purge': { label: 'Deleted for good', kind: 'bin' },
  'report.finalise': { label: 'Finalised', kind: 'lock' },
  'report.email': { label: 'Emailed', kind: 'send' },
  'report.email.sent': { label: 'Emailed', kind: 'send' },
  'report.email.failed': { label: 'Email failed', kind: 'warn' },
  'report.email.bounced': { label: 'Email bounced', kind: 'warn' },
  // Written before approval was retired (29 Sept 2026), and kept as they
  // happened: nothing writes them now.
  'report.email.pending_approval': { label: 'Held for approval', kind: 'send' },
  'report.email.approved': { label: 'Approved to send', kind: 'yes' },
  'report.email.rejected': { label: 'Not approved', kind: 'no' },
}

/** One concept, one glyph (design system §8). */
const GLYPH: Record<Kind, ReactNode> = {
  start: <Plus size={15} strokeWidth={2.2} />,
  edit: <Pencil size={15} strokeWidth={2} />,
  redo: <RefreshCw size={15} strokeWidth={2} />,
  lock: <Lock size={15} strokeWidth={2} />,
  send: <Send size={15} strokeWidth={2} />,
  warn: <TriangleAlert size={15} strokeWidth={2} />,
  bin: <Trash2 size={15} strokeWidth={2} />,
  back: <RotateCcw size={15} strokeWidth={2} />,
  yes: <Check size={15} strokeWidth={2.2} />,
  no: <X size={15} strokeWidth={2.2} />,
}

function ActivityRow({
  entry,
}: {
  entry: {
    _id: string
    action: string
    meta: unknown
    at: number
    actorName?: string
    /** The account it was done in, when that was not the actor's own.
     * Absent from a backend older than switching's audit rows. */
    onBehalfOfName?: string
  }
}) {
  const timezone = useBusinessTimezone()
  // What `email.deliver` records about a send (`addressedTo`): an older row
  // has only `to`. The rest of what it records — the copy, addresses new to
  // the client, why one failed — is said once, in the Email list above.
  const meta = (entry.meta ?? {}) as {
    to?: string | Array<string>
    trigger?: 'finalise' | 'manual'
    /** On a provider event: a bounce, or the recipient marking it spam. */
    event?: 'bounced' | 'complained'
  }
  const to = Array.isArray(meta.to) ? meta.to.join(', ') : meta.to
  const spam =
    entry.action === 'report.email.bounced' && meta.event === 'complained'
  const known = ACTION[entry.action]
  const label = spam ? 'Marked as spam' : (known?.label ?? entry.action)
  const kind: Kind = spam ? 'warn' : (known?.kind ?? 'edit')

  return (
    <li className="flex gap-2.5 px-3.5 py-3">
      <span
        aria-hidden
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 ${kind === 'warn' ? 'text-amber-ink' : 'text-ink-2'}`}
      >
        {GLYPH[kind]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-body text-ink">
          {label}
          {to ? ` to ${to}` : ''}
        </p>
        {/* Who, not just what: who did it — and in whose account — is the
            question a history answers. */}
        <p className="text-caption text-grey-ink">
          {entry.actorName
            ? `${senderName(entry.actorName, entry.onBehalfOfName)} · `
            : ''}
          {formatWhen(entry.at, timezone)}
          {meta.trigger === 'finalise' ? ' · asked for by the form' : ''}
        </p>
        {/* A line from before approval was retired, which nothing will ever
            follow up: the one-off that released them wrote no line of its own. */}
        {entry.action === 'report.email.pending_approval' && (
          <p className="text-caption text-ink-2">
            Approval isn’t needed any more. The Email list above shows whether
            it went.
          </p>
        )}
      </div>
    </li>
  )
}
