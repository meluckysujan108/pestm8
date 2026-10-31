import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccess } from '#/lib/access'
import { keeper } from '#/lib/offline/keeper'
import { lensOf } from '#/lib/offline/keptSet'
import { signedInUserId } from '#/lib/rootState'
import { rq } from '#/lib/routeQueries'
import { isOnJob } from '#/lib/scheduleFilters'
import { useHydrated } from '#/lib/useHydrated'
import { outbox } from './outbox'
import { BookingSession, canKeepNow } from './book'
import { addRule, answeredView, latchSlots } from './latchSlots'
import { browserLocks } from './outboxLocks'
import { newRequestId } from './outboxItem'
import { bookingDay, outboxRow } from './outboxRow'
import { OUTBOX_ENABLED, isReadable } from './outboxSet'
import {
  forgetGivenUp,
  giveUpKeep,
  localNotesWork,
  outboxReadable,
} from './outboxStore'
import { sender } from './sender'
import type { Id } from '../../../convex/_generated/dataModel'
import type { JobRow } from '#/components/schedule/JobCard'
import type { BookingDraft, BookingPath, BookingSheet } from './book'
import type { DrawnSlot, SlotLatch } from './latchSlots'
import type { BookingCall, OutboxItem } from './outboxItem'
import type { RosterPerson } from './outboxRow'

/**
 * The screens' hooks on the bookings kept on this phone (lib/outbox/):
 * New Job's draft and its Book, and what a day's list shows of them.
 */

// ── New Job ────────────────────────────────────────────────────────────────

function freshDraft(): Omit<BookingDraft, 'stopKeeping' | 'renew'> {
  return { requestId: newRequestId(), localId: newRequestId(), keepable: true }
}

/**
 * A draft's ids (plan §3.1): made as New Job opens, which mounts its form
 * afresh each time, so one per draft. Kept after a refusal, so a retry from
 * the same sheet sends the same request id (the refusal made nothing) and
 * keeps over the same row. `stopKeeping`, once a keep took too long or a
 * press was discarded: the draft goes straight from then on, so no second
 * row ever carries its id, and its key is never kept again while what the
 * phone kept of it may still be coming off.
 * `renew` once the sheet closes on a booking kept or sent.
 */
export function useDraftRequestId(): BookingDraft {
  const [ids, setIds] = useState(freshDraft)
  return useMemo(
    () => ({
      ...ids,
      stopKeeping: () => setIds((now) => ({ ...now, keepable: false })),
      renew: () => setIds(freshDraft()),
    }),
    [ids],
  )
}

/**
 * New Job's Book for this opening of the sheet (`BookingSession`), with the
 * page's own parts: the Convex client's call through `call`, the outbox,
 * the sender. `path`: where the booking of the press under way is
 * (`BookingPath`), for the words above Book job; `kept`, whether it is on
 * the phone now, so closing the sheet loses nothing and needs no "Discard
 * your changes?": false again once it isn't (refused, or sent straight
 * after all). Its outcome reaches the sheet only while the sheet is on
 * screen.
 *
 * The session hears `kept` from the commit that draws it (`shown`), so a
 * close is decided on what the screen showed: the sheet's lock goes in the
 * same commit (`useSheetLock`, a layout effect too), before a tap can land.
 */
export function useBooking(
  sheet: { booked?: () => void; close: () => void },
  call: (call: BookingCall) => Promise<unknown>,
): { session: BookingSession; kept: boolean; path: BookingPath } {
  const latest = useRef({ sheet, call })
  latest.current = { sheet, call }
  const [path, setPath] = useState<BookingPath>(null)
  const [session] = useState(() => {
    const on: BookingSheet = {
      booked: () => latest.current.sheet.booked?.(),
      close: () => latest.current.sheet.close(),
      path: setPath,
    }
    return new BookingSession(
      {
        enabled: OUTBOX_ENABLED,
        locks: browserLocks(),
        readable: outboxReadable,
        notes: localNotesWork,
        lineLive: () => keeper.lineLive(),
        call: (made) => latest.current.call(made),
        keep: (item, landed) => outbox.keep(item, landed),
        giveUp: giveUpKeep,
        forgetGivenUp,
        change: (op, localId, change) =>
          outbox.changeLanded(op, localId, change),
        deciding: (localId, deciding) => outbox.deciding(localId, deciding),
        answeredOnScreen: (localId) => outbox.answeredOnScreen(localId),
        sender,
      },
      on,
    )
  })
  // In a layout effect, so the sheet's handle goes in the same commit as
  // the sheet: a refusal heard after that is never the sheet's.
  useLayoutEffect(() => {
    session.revive()
    return () => session.dispose()
  }, [session])
  const kept = path === 'kept'
  useLayoutEffect(() => session.shown(kept), [session, kept])
  return { session, kept, path }
}

/**
 * Whether a booking made now would be kept on the phone (`canKeepNow`),
 * for the words above Book job. Read again as the outbox is first read.
 * Whether localStorage takes the page's notes is tried once as the sheet
 * opens, not at every render; a press tries it afresh.
 */
export function useCanKeep(keepable: boolean): boolean {
  const access = useAccess()
  const readable = useSyncExternalStore(
    outbox.subscribe,
    outboxReadable,
    () => false,
  )
  const [notes] = useState(localNotesWork)
  return canKeepNow({
    enabled: OUTBOX_ENABLED,
    locks: browserLocks() !== null,
    readable,
    notes,
    keepable,
    lens: lensOf(access),
    userId: signedInUserId(),
  })
}

// ── What the screens show ──────────────────────────────────────────────────

/**
 * The bookings on this phone that the person may see here: theirs, for
 * this business, that this build reads, and none while they work in
 * someone else's account or look at the business as them (`lensOf`), whose
 * screen it then is. Null while hydrating (the server knows nothing of
 * them) and until the outbox has been read.
 */
export function useOutboxItems(
  businessId: Id<'businesses'>,
): ReadonlyArray<OutboxItem> | null {
  const hydrated = useHydrated()
  const revision = useSyncExternalStore(
    outbox.subscribe,
    () => outbox.revision(),
    () => -1,
  )
  const ownLens = lensOf(useAccess()) !== null
  return useMemo(() => {
    if (!hydrated || revision < 0 || !outbox.readable()) return null
    if (!ownLens) return []
    const userId = signedInUserId()
    return outbox
      .all()
      .filter(
        (item) =>
          item.userId === userId &&
          item.businessId === businessId &&
          isReadable(item),
      )
    // `revision` is what says the outbox changed.
  }, [hydrated, revision, ownLens, businessId])
}

/** One booking on this phone, as `useOutboxItems` would show it: null
 * until the outbox can be read, undefined when it isn't on the phone. */
export function useOutboxItem(
  businessId: Id<'businesses'>,
  localId: string,
): OutboxItem | undefined | null {
  const items = useOutboxItems(businessId)
  return items === null ? null : items.find((item) => item.localId === localId)
}

/** A slot as a day's group draws it: its card's row too. */
export type OutboxDaySlot = DrawnSlot<JobRow> & { row: JobRow }

export type OutboxDay = {
  slots: Array<OutboxDaySlot>
  /** The jobs the slots draw, which the day's ordered list leaves out. */
  hidden: ReadonlySet<string>
  heading: string | null
  /** For the "Sending…" chip's spinner. */
  lineLive: boolean
}

/**
 * A day's bookings not sent yet, slotted (`latchSlots`): those of the day
 * shown, under the status filter "All" only (a booking has no status yet),
 * and, like the jobs, only those the staff filter or "Just my jobs" would
 * let through (the lead, or someone also going). Each as the server's
 * answer has it, the moment it is heard (`answeredView`). Needs-a-look
 * bookings of other days join today's group with 2c-E (plan D13), with the
 * sheet that settles them; until then a booking shows on its own day.
 */
export function useOutboxDay(at: {
  businessId: Id<'businesses'>
  dayShown: string
  timezone: string
  /** The day's list, as the server has it. */
  rows: ReadonlyArray<JobRow>
  /** Whether the list draws any cards above the group now. */
  drawsCards: boolean
  /** What starts the day's drawing over: day, view, filters, staff, mode. */
  redrawKey: string
  /** The status filter is "All". */
  allStatuses: boolean
  /** The staff filter's person, or 'all'. */
  staffId: string
  /** "Just my jobs": the person's own membership. */
  mineOnly: string | null
}): OutboxDay {
  const access = useAccess()
  const queryClient = useQueryClient()
  const items = useOutboxItems(at.businessId)
  const dayKey = rq.day(at.businessId, at.dayShown).queryKey
  const dayLive = useSyncExternalStore(
    keeper.subscribe,
    () => keeper.isLive(dayKey),
    () => false,
  )
  const lineLive = useSyncExternalStore(
    keeper.subscribe,
    () => keeper.lineLive(),
    () => false,
  )
  const live = {
    seesPrices: access.caps['prices.see'],
    roster: queryClient.getQueryData<Array<RosterPerson>>(
      rq.roster(at.businessId).queryKey,
    ),
  }
  const passes = (item: OutboxItem) => {
    if (bookingDay(item, at.timezone) !== at.dayShown) return false
    if (!at.allStatuses) return false
    const row = outboxRow(item, live)
    if (at.staffId !== 'all' && !isOnJob(row, at.staffId)) return false
    if (at.mineOnly !== null && !isOnJob(row, at.mineOnly)) return false
    return true
  }
  const hydrated = useHydrated()
  const [latch, setLatch] = useState<SlotLatch | null>(null)
  const now = Date.now()
  const result = latchSlots(latch, {
    items:
      items === null
        ? null
        : items
            .filter(passes)
            .map((item) =>
              answeredView(item, outbox.answeredWith(item.localId)),
            ),
    drawing: hydrated,
    rows: at.rows,
    redrawKey: at.redrawKey,
    dayShown: at.dayShown,
    timezone: at.timezone,
    dayLive,
    now,
    // Not while its sheet is still deciding, nor once it closed on its job
    // (booked with signal, it lands in the list as it always did); then
    // wherever it moves nothing.
    mayAdd: addRule(outbox, { drawsCards: at.drawsCards, now }),
  })
  // Held between renders, as React holds state adjusted while rendering.
  if (result.latch !== latch) setLatch(result.latch)
  // A slot waiting for its job looks again once it has waited long enough.
  const [, setLooked] = useState(0)
  const recheckAt = result.recheckAt
  useEffect(() => {
    if (recheckAt === null) return
    const timer = setTimeout(
      () => setLooked((n) => n + 1),
      Math.max(0, recheckAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [recheckAt])
  return {
    slots: result.slots.map((slot) => ({
      ...slot,
      row: slot.real ?? outboxRow(slot.item, live),
    })),
    hidden: result.hidden,
    heading: result.heading,
    lineLive,
  }
}

/**
 * Where a day's bookings not sent yet are, whatever the filters: for the
 * day's forecast, asked for with the jobs', so a booking's weather strip is
 * there when its card is, and the phone's list and the desktop's agenda ask
 * for the same days.
 */
export function useOutboxPlaces(
  businessId: Id<'businesses'>,
  dayShown: string,
  timezone: string,
): Array<{ suburb: string; postcode: string; propertyState: string }> {
  const items = useOutboxItems(businessId)
  return useMemo(
    () =>
      (items ?? [])
        .filter((item) => bookingDay(item, timezone) === dayShown)
        .map((item) => ({
          suburb: item.display.suburb,
          postcode: item.display.postcode,
          propertyState: item.display.propertyState,
        })),
    [items, dayShown, timezone],
  )
}

/**
 * Whether the bookings on this phone can be shown: once hydrated (the
 * server knows nothing of them), and once the outbox has been read. A
 * booking's sheet opens only then, so a reload or an iOS restore of its
 * address never opens a sheet with nothing in it.
 */
export function useOutboxReadable(): boolean {
  const hydrated = useHydrated()
  const readable = useSyncExternalStore(
    outbox.subscribe,
    () => outbox.readable(),
    () => false,
  )
  return hydrated && readable
}
