import { chipFor, countsOf, outboxHeading } from './outboxRules'
import { bookingDay, outboxKey } from './outboxRow'
import type { OutboxItem } from './outboxItem'
import type { OutboxChip } from './outboxRules'

/**
 * Where the bookings on the phone, not sent yet, sit in a day's list (plan
 * part 2c §9.3–§9.4), decided so that nothing on screen moves under a thumb:
 *
 * - **Below the day's cards, in a group of their own** (`OutboxGroup`),
 *   never among them: a group appended under the last card moves nothing
 *   above it, so it can come at any time once the page has hydrated.
 * - **Each keeps its slot.** A booking on screen keeps its place and its key
 *   while it goes from "Not sent yet" to "Sending…" to sent, and once sent,
 *   the slot draws the real job through the same card (its number and its
 *   Pending pill where the chip was), and that job is kept out of the
 *   ordered list above, which would otherwise take it in mid-list and push
 *   every card under it down by a card's height. Until the next redraw: a
 *   change of day, view, filter, staff, mode or page (`redrawKey`), when the
 *   list is drawn afresh in its own order and the group is gone.
 * - **Sent, with nothing to show for it yet** (settled after a reload, or a
 *   day the phone keeps but PestM8 hasn't pushed): "Sent", until the day is
 *   live on this connection; then, with still no job to draw (binned, wiped,
 *   out of this view), the slot goes, which moves nothing, being last. A
 *   slot on screen as its answer comes waits ROW_WAIT_MS for its job first:
 *   the answer is heard before the day's list has drawn the job it made.
 *   One of another day than the one shown goes as soon as it is sent: its
 *   day may never come live here.
 * - **Never twice:** a booking whose job is in the list is never also drawn
 *   as itself. The server's answer counts from the moment it is heard
 *   (`answeredView`), and a job carries the booking's request id
 *   (`clientRequestId`), so this holds whichever comes first: the answer,
 *   the phone's storage, or the day's list.
 * - **A booking not on screen yet** comes onto it only where that moves
 *   nothing a thumb may be on (`mayAdd`): never in place of an empty day's
 *   "This day is clear." or a filter's "No matches" once those have been on
 *   screen a while, unless the person booked it just now.
 *
 * Pure: the screen's hook (`useOutboxDay`) holds the latch between renders.
 * Counts are the server's, and this changes none of them: only what is
 * drawn where.
 */

/**
 * How soon after a list first draws a booking may still come onto it in
 * place of "This day is clear." or "No matches": the Schedule's own window
 * for the phone's copy to replace what the HTML drew (`UPGRADE_WITHIN_MS`).
 * Later, it waits for the next redraw.
 */
export const ADD_AFTER_DRAW_MS = 500

/**
 * How long a slot on screen, its booking just sent, waits for the day's list
 * to draw the job it made, the day being live: the answer reaches the phone
 * a moment before the list's own copy of the day does. Then, with still no
 * job, it goes.
 */
export const ROW_WAIT_MS = 10_000

/** A slot held for one booking, until the next redraw. */
export type LatchedSlot = {
  localId: string
  /** The booking as last seen, which the slot keeps once it has gone from
   * the phone: a sent one is deleted from it in time. */
  item: OutboxItem
}

export type SlotLatch = {
  redrawKey: string
  /** When this redraw first drew. */
  since: number
  slots: ReadonlyArray<LatchedSlot>
}

/** As much of a day's row (`jobs.listDay`) as a match reads. */
export type LatchRow = {
  _id: string
  recurrenceId?: string
  /** The booking's request id, on a job it made (a series' visits never
   * carry it). */
  clientRequestId?: string
}

/** What one slot draws. */
export type DrawnSlot<TRow extends LatchRow = LatchRow> = {
  /** The card's key: the same for the slot's whole life. */
  key: string
  localId: string
  item: OutboxItem
  /** The real job, once the booking has made it and it is in the list: the
   * slot then draws it, as itself. */
  real: TRow | null
  /** The chip in the job number's place; null while it draws the real job. */
  chip: OutboxChip | null
}

export type LatchInput<TRow extends LatchRow = LatchRow> = {
  /**
   * The bookings this group may show: the person's, for the business, as
   * the list's filters let through, and of this group's days (the day
   * shown), each as its answer has it (`answeredView`). Null while they
   * can't be read (hydrating, or the outbox not read yet): nothing is
   * drawn, and nothing is decided, but the list's first draw is noted.
   */
  items: ReadonlyArray<OutboxItem> | null
  /**
   * Whether the list is drawn as the page has it, hydrated: its window for
   * a booking to come in place of "This day is clear." (ADD_AFTER_DRAW_MS)
   * runs from its first such draw, whether or not the phone's bookings
   * have been read by then.
   */
  drawing: boolean
  /** The day's list, as the server has it: what a sent booking became. */
  rows: ReadonlyArray<TRow>
  redrawKey: string
  dayShown: string
  timezone: string
  /** Whether the day is live on this connection: what isn't in it by now
   * isn't coming. */
  dayLive: boolean
  now: number
  /** Whether a booking not on screen may be put there now (see the top). */
  mayAdd: (item: OutboxItem, latch: SlotLatch) => boolean
}

export type LatchResult<TRow extends LatchRow = LatchRow> = {
  latch: SlotLatch | null
  slots: Array<DrawnSlot<TRow>>
  /** The real jobs the slots draw, which the ordered list leaves out. */
  hidden: ReadonlySet<string>
  /** The group's heading ("2 jobs not sent yet", "Sent"), or null with no
   * slots. */
  heading: string | null
  /** When a slot waiting for its job (ROW_WAIT_MS) stops waiting, for the
   * screen to look again then; null with none. */
  recheckAt: number | null
}

/** What a day's list needs of the bookings in memory (`OutboxModel`). */
export type DrawSource = {
  /** Not while its New Job sheet is still deciding, nor once that sheet
   * closed on its job (`OutboxModel.mayDraw`). */
  mayDraw: (localId: string) => boolean
  /** Booked in this tab just now (`OutboxModel.keptHere`). */
  keptHere: ReadonlySet<string>
}

/**
 * Whether a booking not on screen may be put there now (the top of this
 * file): never one its sheet is still deciding, or closed on its job; else
 * where it moves nothing, being under the day's cards or a group already
 * there; in place of "This day is clear." or "No matches" only within
 * ADD_AFTER_DRAW_MS of the list first drawing, or when the person booked it
 * just now.
 */
export function addRule(
  source: DrawSource,
  at: { drawsCards: boolean; now: number },
): LatchInput['mayAdd'] {
  return (item, held) =>
    source.mayDraw(item.localId) &&
    (at.drawsCards ||
      held.slots.length > 0 ||
      at.now - held.since <= ADD_AFTER_DRAW_MS ||
      source.keptHere.has(item.localId))
}

/**
 * A booking as a day's list draws it: as sent, with its job, from the moment
 * the server's answer is heard (`OutboxModel.noteAnswered`), though the
 * phone's storage, which the sender reads, may not have it as sent yet.
 */
export function answeredView(
  item: OutboxItem,
  answer: { id: string; at: number } | undefined,
): OutboxItem {
  if (answer === undefined || item.state === 'sent') return item
  return {
    ...item,
    state: 'sent',
    result: { ...(item.result ?? {}), id: answer.id },
    sentAt: answer.at,
    updatedAt: Math.max(item.updatedAt, answer.at),
  }
}

/**
 * The job a booking made, if the list has it: once sent, the job it was
 * answered with, a Recurring Job by its series on the booking's day
 * (`recurrenceId`) or its first visit (`firstJobId`); and, sent or not, a
 * job carrying its request id (`clientRequestId`), made by a send whose
 * answer the phone hasn't had yet, here or in another tab.
 */
export function realRowOf<TRow extends LatchRow>(
  item: OutboxItem,
  rows: ReadonlyArray<TRow>,
): TRow | null {
  const made = item.state === 'sent' ? item.result : null
  const series = item.kind === 'series'
  return (
    rows.find(
      (row) =>
        (made !== null &&
          (series
            ? row.recurrenceId === made.id ||
              (made.firstJobId !== undefined && row._id === made.firstJobId)
            : row._id === made.id)) ||
        (!series && row.clientRequestId === item.requestId),
    ) ?? null
  )
}

/** Where a booking sorts among those put on screen together: by when it is
 * booked for, then when it was saved. */
function byTime(a: OutboxItem, b: OutboxItem): number {
  return (
    a.booking.scheduledAt - b.booking.scheduledAt ||
    a.createdAt - b.createdAt ||
    (a.localId < b.localId ? -1 : 1)
  )
}

/** The same slots, the same bookings, as last drawn. */
function sameSlots(
  a: ReadonlyArray<LatchedSlot>,
  b: ReadonlyArray<LatchedSlot>,
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (slot, i) =>
        slot.localId === b[i].localId &&
        slot.item.updatedAt === b[i].item.updatedAt &&
        slot.item.state === b[i].item.state,
    )
  )
}

export function latchSlots<TRow extends LatchRow>(
  prev: SlotLatch | null,
  input: LatchInput<TRow>,
): LatchResult<TRow> {
  const fresh = prev === null || prev.redrawKey !== input.redrawKey
  if (input.items === null) {
    // Nothing to draw yet, but the list has drawn: its window runs from now.
    const latch =
      input.drawing && fresh
        ? { redrawKey: input.redrawKey, since: input.now, slots: [] }
        : prev
    return {
      latch,
      slots: [],
      hidden: new Set(),
      heading: null,
      recheckAt: null,
    }
  }
  const base: SlotLatch =
    prev === null || fresh
      ? { redrawKey: input.redrawKey, since: input.now, slots: [] }
      : prev
  const byId = new Map(input.items.map((item) => [item.localId, item]))
  const kept: Array<LatchedSlot> = []
  const drawn: Array<DrawnSlot<TRow>> = []
  const hidden = new Set<string>()
  let recheckAt: number | null = null

  /**
   * A slot for `item`, if it still has one: what it draws, else null.
   * `onScreen`: it has a slot already, which waits for its job a while.
   */
  const draw = (
    item: OutboxItem,
    onScreen: boolean,
  ): DrawnSlot<TRow> | null => {
    const key = outboxKey(item.localId)
    const real = realRowOf(item, input.rows)
    if (real !== null) {
      return { key, localId: item.localId, item, real, chip: null }
    }
    if (item.state !== 'sent') {
      return {
        key,
        localId: item.localId,
        item,
        real: null,
        chip: chipFor(item),
      }
    }
    // Sent, and nothing to draw it as yet.
    if (bookingDay(item, input.timezone) !== input.dayShown) return null
    if (input.dayLive) {
      const until =
        onScreen && item.sentAt !== null ? item.sentAt + ROW_WAIT_MS : null
      if (until === null || input.now >= until) return null
      recheckAt = recheckAt === null ? until : Math.min(recheckAt, until)
    }
    return { key, localId: item.localId, item, real: null, chip: 'sent' }
  }

  for (const slot of base.slots) {
    const now = byId.get(slot.localId)
    // Gone from what this group may show: kept only once it is sent, when
    // the phone deletes it in time; discarded, wiped or moved to another
    // day, its slot goes with it.
    const item = now ?? (slot.item.state === 'sent' ? slot.item : null)
    if (item === null) continue
    const slotDrawn = draw(item, true)
    if (slotDrawn === null) continue
    kept.push({ localId: slot.localId, item })
    drawn.push(slotDrawn)
    if (slotDrawn.real) hidden.add(slotDrawn.real._id)
  }

  const onScreen = new Set(kept.map((slot) => slot.localId))
  const latchSoFar: SlotLatch = { ...base, slots: kept }
  const newcomers = input.items
    .filter((item) => !onScreen.has(item.localId))
    .filter((item) => realRowOf(item, input.rows) === null)
    .sort(byTime)
  for (const item of newcomers) {
    const slotDrawn = draw(item, false)
    if (slotDrawn === null || slotDrawn.real !== null) continue
    if (!input.mayAdd(item, latchSoFar)) continue
    kept.push({ localId: item.localId, item })
    drawn.push(slotDrawn)
  }

  const latch: SlotLatch =
    prev !== null && !fresh && sameSlots(prev.slots, kept)
      ? prev
      : { ...base, slots: kept }
  const counts = countsOf(
    drawn.map((slot) => ({
      state: slot.real !== null ? ('sent' as const) : slot.item.state,
    })),
  )
  return {
    latch,
    slots: drawn,
    hidden,
    heading: outboxHeading(counts),
    recheckAt,
  }
}
