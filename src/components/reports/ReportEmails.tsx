import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { RowPending } from '#/components/shell/Pending'
import { formatWhen } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { newAddressLine, senderName } from './SendSheet'
import { deliveryState } from './deliveryWords'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Where a finished report went: every email of it, newest first, each with
 * who it went to, how it got on and what to do if it did not go.
 *
 * Locking is what sends a report — the form asks whether to send the client a
 * copy "when you submit this form" — so the page a technician lands on after
 * Finalise is where "did it go, and to whom?" is answered: "Sending…" for the
 * few seconds the PDF takes to draw, then who it went to and where the
 * business's copy went. It replaces the line above the old tabs and the Email
 * tab's history, which said the same thing twice.
 *
 * Read from the delivery rows rather than the audit log: a row exists from the
 * moment someone asks, so a send still on its way, or one that died
 * mid-flight, appears here too, rather than only the ones that finished.
 *
 * "Sent" means the email service took it (no delivery webhook is registered),
 * so nothing here claims more than that.
 */
export function ReportEmails({
  businessId,
  reportId,
  hydrated,
  onSendAgain,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  hydrated: boolean
  /** Opens the Send sheet with these addresses chosen. */
  onSendAgain: (addresses: ReadonlyArray<string>) => void
}) {
  const timezone = useBusinessTimezone()
  const history = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )
  const rows = history.data
  const [all, setAll] = useState(false)
  const now = useClock((rows ?? []).some((row) => row.status === 'queued'))

  return (
    <section aria-labelledby="report-emails">
      <h2 id="report-emails" className="section-label mb-2">
        Email
      </h2>
      {rows === undefined && history.isError ? (
        <LoadFailed
          what="where this report was sent"
          onRetry={() => void history.refetch()}
        />
      ) : rows === undefined ? (
        // Loading is not the same as nothing: "Not emailed yet" under a report
        // the form already sent is a lie, and one a technician would act on by
        // sending it again.
        <div className="rounded-2xl border border-hairline bg-surface shadow-elevation">
          <RowPending />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-surface px-3.5 py-3 text-body text-grey-ink shadow-elevation">
          Not emailed yet.
        </p>
      ) : (
        // Polite, so "Sending…" turning into "Sent" is heard: it changes by
        // itself a few seconds after the page opens.
        <ul
          aria-live="polite"
          className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation"
        >
          {(all ? rows : rows.slice(0, SHOWN)).map((row) => {
            const stuck =
              row.status === 'queued' &&
              !row.waitingForEmailSetup &&
              now - row.createdAt > STUCK_AFTER_MS
            const state = deliveryState(row, stuck)
            const copies = copiesOf(row)
            return (
              <li key={row._id} className="flex gap-2.5 px-3.5 py-3">
                <span aria-hidden className="mt-0.5 shrink-0">
                  {state.warn ? (
                    <TriangleAlert
                      size={16}
                      strokeWidth={2}
                      className="text-amber-ink"
                    />
                  ) : state.sending ? (
                    <LoaderCircle
                      size={16}
                      strokeWidth={2}
                      className="animate-spin text-muted"
                    />
                  ) : (
                    <Check size={16} strokeWidth={2.2} className="text-green" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {/* Whole, never cut off: the end of an address is where a
                      typo in its domain would be. */}
                  <p className="break-words text-body text-ink">
                    {row.to.join(', ')}
                  </p>
                  {/* Grey-ink, not muted: with no approval step, who sent it
                      — and from whose account — is the record an owner reads. */}
                  <p className="text-caption text-grey-ink">
                    {state.word} ·{' '}
                    {formatWhen(row.sentAt ?? row.createdAt, timezone)}
                    {row.sentBy?.name
                      ? ` · ${senderName(row.sentBy.name, row.onBehalfOf?.name)}`
                      : ''}
                    {row.trigger === 'finalise'
                      ? ' · asked for by the form'
                      : ''}
                  </p>
                  {/* Only once it went: on a failed row it would read as
                      though the copy had gone when nothing did. */}
                  {(row.status === 'sent' || state.sending) &&
                    copies.length > 0 && (
                      <p className="break-words text-caption text-muted">
                        {state.sending ? 'A copy goes to ' : 'Copy to '}
                        {copies.join(', ')}
                      </p>
                    )}
                  {/* What went, once it went: the report's own PDF was more
                      than an email carries, so its copy with smaller photos
                      did. */}
                  {(row.status === 'sent' || row.status === 'bounced') &&
                    row.lighterCopy && (
                      <p className="text-caption text-muted">
                        Photos made smaller to fit an email
                      </p>
                    )}
                  {/* Nothing waited on it; this is what an owner reads to see
                      a report went somewhere new. As it was when it was sent. */}
                  {row.newAddresses && row.newAddresses.length > 0 && (
                    <p className="break-words text-caption text-ink-2">
                      {newAddressLine(row.newAddresses)}
                    </p>
                  )}
                  {state.next && (
                    <p className="mt-1 text-caption text-amber-ink">
                      {state.next}
                    </p>
                  )}
                  {state.retry && (
                    <button
                      type="button"
                      disabled={!hydrated}
                      onClick={() => onSendAgain(row.to)}
                      className="relative tap-target mt-1 text-caption font-semibold text-blue transition active:opacity-50"
                    >
                      Send again
                    </button>
                  )}
                </div>
              </li>
            )
          })}
          {rows.length > SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAll((open) => !open)}
                className="flex min-h-11 w-full items-center px-3.5 text-body font-semibold text-blue transition active:bg-surface-2"
              >
                {all ? 'Show fewer' : `Show all ${rows.length}`}
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

/**
 * How long a delivery may sit queued before it is plainly not on its way.
 *
 * Five minutes, not two, since a report too big to email has its PDF drawn
 * and then a copy with smaller photos made before it goes (convex/emailCopy.ts)
 * — a minute or so for a big job, which two minutes cut close to calling
 * stuck while it was still on its way.
 */
const STUCK_AFTER_MS = 5 * 60_000

/**
 * The time, read again every fifteen seconds while `ticking` — so a page left
 * open stops saying "Sending…" once a queued row has plainly stopped.
 */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/**
 * Who else a delivery went to: the business's blind copy, and — on a row from
 * before copies were blind (29 Sept 2026), or one an API caller asked for —
 * its visible cc.
 */
function copiesOf(row: {
  cc: Array<string>
  bcc?: Array<string>
}): Array<string> {
  return [...new Set([...(row.bcc ?? []), ...row.cc])]
}
