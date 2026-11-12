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
import { hasService, isOnJob } from '#/lib/scheduleFilters'
import { useHydrated } from '#/lib/useHydrated'
import { outbox } from './outbox'
import { BookingSession, canKeepNow } from './book'
import {
  ADD_AFTER_DRAW_MS,
  addRule,
  answeredView,
  latchForeign,
  latchSlots,
} from './latchSlots'
import { browserLocks } from './outboxLocks'
import { newRequestId } from './outboxItem'
import { bookingDay, outboxRow } from './outboxRow'
import { OUTBOX_ENABLED, isReadable } from './outboxSet'
import {
  forgetGivenUp,
  giveUpKeep,
  keptBefore,
  localNotesWork,
  outboxReadable,
} from './outboxStore'
import { countsOf, outboxHeading } from './outboxRules'
import { sender } from './sender'
import { dayKeyOf } from '../../../convex/lib/dates'
import type { Id } from '../../../convex/_generated/dataModel'
import type { JobRow } from '#/components/schedule/JobCard'
import type { BookingDraft, BookingPath, BookingSheet } from './book'
import type { ItemDeps } from './itemActions'
import type { DrawnSlot, ForeignLatch, SlotLatch } from './latchSlots'
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
  /** Those saved by a newer build too, which this one can't read
   * (`isReadable`): for their sheet and today's group (plan D13). */
  { foreign = false }: { foreign?: boolean } = {},
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
          (foreign || isReadable(item)),
      )
    // `revision` is what says the outbox changed.
  }, [hydrated, revision, ownLens, businessId, foreign])
}

/** One booking on this phone, as `useOutboxItems` would show it (one saved
 * by a newer build included, for its Discard): null until the outbox can be
 * read, undefined when it isn't on the phone. */
export function useOutboxItem(
  businessId: Id<'businesses'>,
  localId: string,
): OutboxItem | undefined | null {
  const items = useOutboxItems(businessId, { foreign: true })
  return items === null ? null : items.find((item) => item.localId === localId)
}

/** A slot as a day's group draws it: its card's row too. */
export type OutboxDaySlot = DrawnSlot<JobRow> & { row: JobRow }

export type OutboxDay = {
  slots: Array<OutboxDaySlot>
  /** Bookings saved by a newer build, whose day can't be read: today's
   * group lists them after its slots (plan D13). */
  foreign?: ReadonlyArray<OutboxItem>
  /** The jobs the slots draw, which the day's ordered list leaves out. */
  hidden: ReadonlySet<string>
  heading: string | null
  /** For the "Sending…" chip's spinner. */
  lineLive: boolean
}

/**
 * Whether a day's group (`OutboxGroup`) draws anything: a slot, or one of
 * today's bookings saved by a newer build. A day that does draws no
 * EmptyState or NoMatches, which would be untrue, and keeps WeatherCredit
 * under the group, the last thing on the day (plan §9.3).
 */
export function outboxDrawn(day: OutboxDay): boolean {
  return day.slots.length > 0 || (day.foreign?.length ?? 0) > 0
}

/**
 * A day's bookings not sent yet, slotted (`latchSlots`): those of the day
 * shown, under the status filter "All" only (a booking has no status yet),
 * and, like the jobs, only those the staff and service filters or "Just my
 * jobs" would let through (the lead, or someone also going; any of its
 * services). Each as the server's
 * answer has it, the moment it is heard (`answeredView`). Today's group
 * also lists every booking of another day that needs a look, with its date
 * (`JobCard` prints it), kept in its slot until the day is drawn afresh
 * once it no longer does, or until it is sent (plan D13, S18); and, after
 * its slots, every booking saved by a newer build, whose day this build
 * can't read, under the status filter "All" only, coming on and staying as
 * a slot does (`latchForeign`).
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
  /** The service filter's, or 'all'. */
  service?: string
  /** "Just my jobs": the person's own membership. */
  mineOnly: string | null
  /**
   * The Week View's day (plan §9.3): its own bookings only, as every day of
   * the week is on screen (no other day's needing a look, and none saved by
   * a newer build), and coming on only at the week's first drawing, since
   * the days under it would move (`addRule`'s `movesBelow`).
   */
  inWeek?: boolean
}): OutboxDay {
  const access = useAccess()
  const queryClient = useQueryClient()
  const everything = useOutboxItems(at.businessId, { foreign: true })
  const items = useMemo(
    () => everything?.filter((item) => isReadable(item)) ?? null,
    [everything],
  )
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
  const hydrated = useHydrated()
  const [latch, setLatch] = useState<SlotLatch | null>(null)
  const [foreignLatch, setForeignLatch] = useState<ForeignLatch | null>(null)
  // Only once drawn in the browser: the phone's clock.
  const today = items === null ? null : dayKeyOf(Date.now(), at.timezone)
  const showsToday = today !== null && at.dayShown === today
  const passes = (item: OutboxItem) => {
    if (bookingDay(item, at.timezone) !== at.dayShown) {
      // Another day's, in today's group: needing a look, or slotted there
      // already until the day is drawn afresh (D13).
      const latched =
        latch?.redrawKey === at.redrawKey &&
        latch.slots.some((slot) => slot.localId === item.localId)
      if (
        at.inWeek === true ||
        !showsToday ||
        (item.state !== 'needsLook' && !latched)
      ) {
        return false
      }
    }
    if (!at.allStatuses) return false
    const row = outboxRow(item, live)
    if (at.staffId !== 'all' && !isOnJob(row, at.staffId)) return false
    if (at.service && at.service !== 'all' && !hasService(row, at.service))
      return false
    if (at.mineOnly !== null && !isOnJob(row, at.mineOnly)) return false
    return true
  }
  const now = Date.now()
  // Not while its sheet is still deciding, nor once it closed on its job
  // (booked with signal, it lands in the list as it always did); then
  // wherever it moves nothing.
  const mayAdd = addRule(outbox, {
    drawsCards: at.drawsCards,
    now,
    movesBelow: at.inWeek === true,
  })
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
    mayAdd,
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
  // Saved by a newer build: today's, under "All" only, whatever the other
  // filters, since nothing of it can be read to filter on.
  const foreignDrawn = latchForeign(foreignLatch, {
    items:
      showsToday && at.allStatuses && at.inWeek !== true && everything !== null
        ? everything.filter(
            (item) => !isReadable(item) && item.state !== 'sent',
          )
        : [],
    redrawKey: at.redrawKey,
    mayAdd: (item, drawn) =>
      drawn > 0 || (result.latch !== null && mayAdd(item, result.latch)),
  })
  if (foreignDrawn.latch !== foreignLatch) setForeignLatch(foreignDrawn.latch)
  const foreign = foreignDrawn.shown
  const heading =
    foreign.length === 0
      ? result.heading
      : outboxHeading(
          countsOf([
            ...result.slots.map((slot) => ({
              state: slot.real !== null ? ('sent' as const) : slot.item.state,
            })),
            ...foreign,
          ]),
        )
  return {
    slots: result.slots.map((slot) => ({
      ...slot,
      row: slot.real ?? outboxRow(slot.item, live),
    })),
    foreign,
    hidden: result.hidden,
    heading,
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

/**
 * Whether the Week View's days have all they will draw of the bookings on
 * this phone as the week first draws (`useOutboxDay`'s `inWeek`, which
 * puts one on only then): the phone has been read, or ADD_AFTER_DRAW_MS
 * has gone by, after which nothing comes on until the week is drawn
 * afresh. Its first scroll to a day waits for it, so the groups of the
 * days above don't push the day off screen as they come. At once where
 * nothing can be on the phone (keeping switched off, on a phone that never
 * kept), as before there was any.
 */
export function useOutboxSettled(): boolean {
  const readable = useOutboxReadable()
  const mayHold = OUTBOX_ENABLED || keptBefore()
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (!mayHold) return
    const timer = setTimeout(() => setWaited(true), ADD_AFTER_DRAW_MS)
    return () => clearTimeout(timer)
  }, [mayHold])
  return !mayHold || readable || waited
}

/** What a booking's sheet changes it with (lib/outbox/itemActions.ts): the
 * page's own outbox, its sender, the browser's locks. */
export function pageItemDeps(): ItemDeps {
  return {
    tab: outbox.tab,
    editingHere: outbox.editingHere,
    landingHere: outbox.landingHere,
    get: (localId) => outbox.get(localId),
    refresh: () => outbox.refresh(),
    change: (op, localId, change) => outbox.change(op, localId, change),
    changeLanded: (op, localId, change) =>
      outbox.changeLanded(op, localId, change),
    locks: browserLocks(),
    lineLive: () => keeper.lineLive(),
    sender,
    now: () => Date.now(),
    bookedHere: (localId) => outbox.bookedHere(localId),
  }
}
