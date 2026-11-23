import { isOnJob } from '#/lib/scheduleFilters'
import { addRule } from './latchSlots'
import type { DrawSource, LatchInput } from './latchSlots'
import type { OutboxItem } from './outboxItem'

/**
 * The bookings on this phone, not sent yet, in a list of every day rather
 * than a day's (plan part 2c §9.8): the Job tab's "Not sent yet" group above
 * its list, and a client's, at the end of their Jobs tab's "Coming up" and
 * under the Jobs row of the sheet kept on the phone (`KeptClientView`).
 * Each keeps its slot as a day's do (lib/outbox/latchSlots.ts, `dayShown`
 * null), and since what is under the group moves when one comes, they come
 * as the Week View's days' do: only as the list first draws, or booked
 * here just now.
 *
 * Pure: the screens' hook is `useOutboxList` (useOutbox.ts).
 */

/**
 * Whether a list whose group sits above it (the Job tab) may put bookings
 * on screen as it first draws: decided on the page's first render, then
 * kept (`useFirstDrawOffer`), as the schedule's install card is. Never on a
 * hydrating render, which is a full page load: the HTML drew the list with
 * none, and a thumb may be on it already. Nor on a page reached with Back or
 * Forward (`cameByHistory`), whose scroll the router puts back where it was.
 */
export function firstDrawOffers(at: {
  hydrating: boolean
  byHistory: boolean
}): boolean {
  return !at.hydrating && !at.byHistory
}

/**
 * Whether a booking not on screen may come onto a list of every day now:
 * never one its sheet is still deciding, or closed on its job; else, since
 * what is under the group would move, as on the Week View's days
 * (`addRule`'s `movesBelow`): within ADD_AFTER_DRAW_MS of the list first
 * drawing, or booked in this tab just now (a client sheet's Book a job, an
 * Edit's Book: `keptHere`). At the page's first drawing only where
 * `offered` (`firstDrawOffers`), or booked (or Edit-booked) here since it
 * drew, by when this tab did so: one booked earlier in this page load is no
 * more the person's doing just now than any other, on a page whose scroll
 * Back put back, however the sender has changed it since (sending, held,
 * refused). A later redraw (a filter, a site, the view) is the person's own
 * doing, and always may.
 */
export function listAddRule(
  source: DrawSource,
  at: { now: number; offered: boolean },
): LatchInput['mayAdd'] {
  const rule = addRule(source, {
    drawsCards: false,
    now: at.now,
    movesBelow: true,
  })
  return (item, held) => {
    if (!rule(item, held)) return false
    if (at.offered) return true
    const bookedAt = source.keptHere.get(item.localId)
    return bookedAt !== undefined && bookedAt >= held.since
  }
}

/**
 * Which bookings the Job tab's group lists, by the card each will be
 * (`outboxRow`): only under "All statuses", as a booking has no status yet;
 * for the person chosen, and with My jobs for the person's own
 * membership, only those they lead or are also going on (`isOnJob`), as the
 * list's own jobs are.
 */
export function jobTabShows(filters: {
  /** The status filter's; undefined for "All statuses". */
  status: string | undefined
  /** The person chosen; undefined for everyone. */
  person: string | undefined
  /** My jobs: the person's own membership; null otherwise. */
  mine: string | null
}): (
  item: OutboxItem,
  card: {
    assignedMembershipId: string
    alsoGoing?: ReadonlyArray<{ _id: string }>
  },
) => boolean {
  return (_item, card) =>
    filters.status === undefined &&
    (filters.person === undefined || isOnJob(card, filters.person)) &&
    (filters.mine === null || isOnJob(card, filters.mine))
}

/**
 * Whether a booking is one of a client's, for their sheet: made on a site
 * of theirs (`propertyIds`, or the one site their Jobs tab shows), or on a
 * new site for them (`newProperty.clientId`), which has no id yet, so only
 * "every site" lists it. A new client's is nobody's on the phone yet (the
 * server makes the client as it books), nor is one made on a client or site
 * still on the phone itself (2c-I).
 */
export function bookedForClient(
  item: Pick<OutboxItem, 'booking'>,
  client: {
    clientId: string
    propertyIds: ReadonlySet<string>
    /** The one site shown; every site where undefined. */
    site?: string
  },
): boolean {
  const property = item.booking.property
  if ('propertyId' in property) {
    return client.site !== undefined
      ? property.propertyId === client.site
      : client.propertyIds.has(property.propertyId)
  }
  if ('newProperty' in property) {
    return (
      client.site === undefined &&
      property.newProperty.clientId === client.clientId
    )
  }
  return false
}
