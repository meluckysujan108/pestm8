import { VisitRow } from '#/components/schedule/VisitRow'
import type { InlineReport } from '#/components/reports/ReportRows'
import type { LatchRow } from '#/lib/outbox/latchSlots'
import type { OutboxList, OutboxListSlot } from '#/lib/outbox/useOutbox'

/** As much of a client's visit (`clients.summary`) as a row draws. */
type VisitLike = LatchRow & {
  scheduledAt: number
  status: string
  jobType: string
}

/**
 * A client's bookings on this phone, not sent yet (lib/outbox/), as rows in
 * a card of their jobs: at the end of their Jobs tab's "Coming up"
 * (`ClientJobsTab`), or under the Jobs row of their sheet kept on the phone
 * (`KeptClientView`). Headed as a day's group is, its counts changing in
 * place ("1 job not sent yet", "1 job sending", then "Sent"), each a
 * `VisitRow` with its `OutboxChip` where the status pill goes, opening the
 * booking's sheet on the Schedule. Each keeps its slot until the next
 * redraw (a site or tab chosen, the account, the sheet closed), drawing its
 * visit there once their jobs have it, with its number's pill
 * (`useOutboxList`). Nothing when there are none.
 */
export function OutboxVisits<TRow extends VisitLike>({
  list,
  businessSlug,
  timezone,
  siteOf,
  reportsOf,
  className = 'border-t border-hairline-2 first:border-t-0',
}: {
  list: OutboxList<TRow>
  businessSlug: string
  timezone: string
  /** Which of the client's sites, where they have more than one; or the
   * new site a booking makes, from what it saved. */
  siteOf: (slot: OutboxListSlot<TRow>) => string | undefined
  /** The reports of a visit a slot now draws. */
  reportsOf?: (visitId: string) => ReadonlyArray<InlineReport>
  className?: string
}) {
  if (list.slots.length === 0) return null
  return (
    <div className={className}>
      {/* Its counts change in place as the bookings go. */}
      <h4 aria-live="polite" className="section-label px-3.5 pb-0.5 pt-3">
        {list.heading}
      </h4>
      <div className="divide-y divide-hairline-2">
        {list.slots.map((slot) => (
          <VisitRow
            key={slot.key}
            businessSlug={businessSlug}
            timezone={timezone}
            visit={
              slot.real ?? {
                _id: slot.card._id,
                scheduledAt: slot.card.scheduledAt,
                status: slot.card.status,
                jobType: slot.card.jobType,
                // A Recurring Job's first visit, marked as its visit will be.
                recurrenceId:
                  slot.item.kind === 'series' ? slot.localId : undefined,
              }
            }
            reports={slot.real ? (reportsOf?.(slot.real._id) ?? []) : []}
            site={siteOf(slot)}
            outbox={
              slot.chip === null
                ? undefined
                : {
                    chip: slot.chip,
                    lineLive: list.lineLive,
                    localId: slot.localId,
                  }
            }
          />
        ))}
      </div>
    </div>
  )
}
