import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { Smartphone } from 'lucide-react'
import {
  SHEET_BODY,
  SHEET_BODY_ABOVE_FOOTER,
  SHEET_FOOTER,
} from '#/components/primitives/Sheet'
import {
  NEUTRAL_BUTTON_COMPACT,
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { useAccess } from '#/lib/access'
import { keeper } from '#/lib/offline/keeper'
import { useLineDown } from '#/lib/offline/useLineDown'
import { useHydrated } from '#/lib/useHydrated'
import {
  beginEdit,
  discardItem,
  endEdit,
  lapseLeftEdits,
  renewEdit,
  sendItem,
} from '#/lib/outbox/itemActions'
import {
  EDITED_ELSEWHERE_WORDS,
  FIX_LABELS,
  OUTBOX_ACTION_COPY,
  discardDialog,
  mayAlreadyBeBooked,
  outboxFooter,
  outboxInset,
  outboxProblemCopy,
  savedLine,
} from '#/lib/outbox/outboxInset'
import { browserLocks, itemLock, lockHeld } from '#/lib/outbox/outboxLocks'
import { chipFor } from '#/lib/outbox/outboxRules'
import { bookingDay, outboxRow } from '#/lib/outbox/outboxRow'
import { EDIT_RENEW_MS, FIND_WAIT_MS, isReadable } from '#/lib/outbox/outboxSet'
import { outbox } from '#/lib/outbox/outbox'
import { sender } from '#/lib/outbox/sender'
import { pageItemDeps, useOutboxItem } from '#/lib/outbox/useOutbox'
import { rq } from '#/lib/routeQueries'
import { api } from '../../../convex/_generated/api'
import { dayKeyOf } from '../../../convex/lib/dates'
import { BOOKING_ERROR_COPY } from './bookingCopy'
import { KeptJobView } from './KeptJobView'
import { OutboxChip } from './OutboxChip'
import type { ReactNode, RefObject } from 'react'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { BodyLanding } from '#/lib/offline/useKept'
import type { FunctionReturnType } from 'convex/server'
import type {
  InsetFacts,
  OutboxFix,
  OutboxFooter,
} from '#/lib/outbox/outboxInset'
import type { OutboxItem } from '#/lib/outbox/outboxItem'
import type { Id } from '../../../convex/_generated/dataModel'

type Roster = FunctionReturnType<typeof api.memberships.listForBusiness>

/** A booking's sheet, once it has gone from the phone. */
export const NOT_ON_PHONE =
  'Not on this phone any more: it was sent, or discarded.'

/** How often a sheet on a booking sent with no answer looks whether any
 * tab still holds its lock, for "This may already be booked" (§6.3). */
const LOCK_LOOK_MS = 5_000

/** What a refused Discard says, by what the phone answered. */
const DISCARD_REFUSALS = {
  refused: 'OUTBOX_DISCARD_REFUSED',
  elsewhere: 'OUTBOX_DISCARD_ELSEWHERE',
  busy: 'OUTBOX_DISCARD_BUSY',
  error: 'OUTBOX_STORAGE',
  unsure: 'OUTBOX_STORAGE_UNSURE',
} as const

/**
 * Loaded when Edit is pressed, as the client sheet loads it: New Job brings
 * its pickers, the interval model and the save checks, which a booking's
 * sheet opened to read never needs.
 */
const NewJobSheet = lazy(() =>
  import('./NewJobSheet').then((m) => ({ default: m.NewJobSheet })),
)

/**
 * The job a booking's sheet hands over to once it is sent (plan §9.5): a
 * one-off's own, the moment PestM8's answer is heard; a Recurring Job's
 * first visit, from the `find` the sender asks once after it went. Null
 * until there is one.
 */
export function handOverTo(
  item: OutboxItem,
  answered: { id: string } | undefined,
): string | null {
  if (!isReadable(item)) return null
  if (item.kind === 'job') {
    return item.result?.id ?? answered?.id ?? null
  }
  return item.result?.firstJobId ?? null
}

/** The words for why it needs a look: its own, New Job's, then the item's
 * fallback, never the "offline" words describeError has for an unknown code. */
function problemWords(code: string, copy: ErrorCopy): string {
  return describeError({ data: code }, { ...copy, offline: copy.default })
}

/**
 * A booking on this phone, not sent yet (plan part 2c §9.5), drawn from
 * what it says of itself: laid out as its job's sheet will be
 * (`KeptJobView`, from its own row), its chip in the status pill's place,
 * under who to call where it is or why it needs a look, and its fix in the
 * footer with Discard. One saved by a newer PestM8 has its chip, its line
 * and Discard alone.
 */
export function OutboxItemView({
  facts,
  footer,
  holdFooter = false,
  roster,
  down,
  seesPrices,
  alert = null,
  busy = false,
  onFix,
  onEdit,
  onDiscard,
  bodyRef,
  footerRef,
  children,
}: {
  facts: InsetFacts
  footer: OutboxFooter | null
  /** With no footer now, its space kept, as it had one: a sheet is as tall
   * as what is in it, so its going would move the sheet's top edge. */
  holdFooter?: boolean
  roster: Roster | undefined
  down: ReturnType<typeof useLineDown>
  seesPrices: boolean
  /** A tap the phone refused (`OUTBOX_ACTION_COPY`), by code. */
  alert?: string | null
  /** A tap is being carried out: the footer waits. */
  busy?: boolean
  onFix?: (fix: OutboxFix) => void
  onEdit?: () => void
  onDiscard?: () => void
  /** The scrolling body, measured as its job's takes its place. */
  bodyRef?: RefObject<HTMLDivElement | null>
  /** The footer, where focus goes back to once a Discard the phone refused
   * leaves Discard locked. */
  footerRef?: RefObject<HTMLDivElement | null>
  /** Its dialogs, and New Job over it for an Edit. */
  children?: ReactNode
}) {
  const hydrated = useHydrated()
  const { item, timezone, todayKey } = facts
  const readable = isReadable(item)
  const said = outboxInset(facts)
  const chip = <OutboxChip chip={chipFor(item)} lineLive={facts.lineLive} />
  const inset =
    'problem' in said ? (
      <FormAlert className="mt-3">
        {problemWords(said.problem, {
          ...BOOKING_ERROR_COPY,
          ...outboxProblemCopy(item, timezone, todayKey),
        })}
      </FormAlert>
    ) : (
      <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2">
        <Smartphone
          aria-hidden
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0"
        />
        <span>
          {said.words} {savedLine(item, timezone, todayKey)}
        </span>
      </p>
    )
  const locked = footer?.locked === true
  const off = locked || busy || !hydrated
  return (
    <>
      <div
        ref={bodyRef}
        className={`${footer === null && !holdFooter ? SHEET_BODY : SHEET_BODY_ABOVE_FOOTER} pt-3`}
      >
        {readable ? (
          <KeptJobView
            job={outboxRow(item, { seesPrices, roster })}
            asOf={item.createdAt}
            down={down}
            timezone={timezone}
            roster={roster}
            head={{
              readOnly: false,
              clientNumber: item.display.clientNumber,
            }}
            outbox={{ chip, inset }}
          />
        ) : (
          <>
            <Drawer.Title className="text-sheet-title text-ink">
              Job
            </Drawer.Title>
            <div className="mt-2">{chip}</div>
            {inset}
          </>
        )}
      </div>
      {footer === null && holdFooter && (
        <div
          ref={footerRef}
          aria-hidden
          className={`${SHEET_FOOTER} invisible`}
        >
          <div className="min-h-11" />
        </div>
      )}
      {footer !== null && (
        <div
          ref={footerRef}
          tabIndex={-1}
          className={`${SHEET_FOOTER} flex flex-col gap-2 outline-none`}
        >
          {alert !== null && (
            <FormAlert error={{ data: alert }} copy={OUTBOX_ACTION_COPY} />
          )}
          {/* Locked by an Edit in another tab: its inset says so only while
              it waits, so one needing a look says it here. */}
          {locked && item.state === 'needsLook' && (
            <p className="text-caption text-ink-2">{EDITED_ELSEWHERE_WORDS}</p>
          )}
          <div className="flex items-center justify-between gap-3">
            {footer.discard !== null ? (
              <button
                type="button"
                onClick={onDiscard}
                disabled={off}
                className="relative tap-target inline-flex min-h-11 items-center text-body font-semibold text-red transition active:opacity-60 disabled:opacity-50"
              >
                Discard
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              {footer.alsoEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  disabled={off}
                  className={`${SECONDARY_BUTTON_COMPACT} min-w-11 px-4`}
                >
                  Edit
                </button>
              )}
              {footer.fix !== null && (
                <button
                  type="button"
                  onClick={() => footer.fix && onFix?.(footer.fix)}
                  disabled={off}
                  className={`${
                    // Send and Try again commit: red. Edit and Change the
                    // date open the form: ink.
                    footer.fix === 'send' || footer.fix === 'tryAgain'
                      ? PRIMARY_BUTTON_COMPACT
                      : NEUTRAL_BUTTON_COMPACT
                  } min-w-11 px-4`}
                >
                  {FIX_LABELS[footer.fix]}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {children}
    </>
  )
}

/**
 * A booking on this phone, opened from its card (`?outboxId=`): the sheet
 * (`OutboxItemView`) with what it does. Edit opens New Job on it, over the
 * sheet, holding the booking's Edit for the while (`beginEdit`, renewed
 * every EDIT_RENEW_MS); Discard asks first; Send and Try again send it.
 * Once it is sent the sheet hands over to its job (`onSent`): a one-off at
 * once, a Recurring Job once its first visit is known, waited for at most
 * FIND_WAIT_MS ("Sent" meanwhile, and after, with no visit), telling it how
 * this body stood, so the job lands there and nothing moves. Discarded or
 * wiped while open, it closes; gone when opened, it says so.
 */
export function OutboxItemBody({
  businessId,
  localId,
  timezone,
  onSent,
  onClose,
}: {
  businessId: Id<'businesses'>
  localId: string
  timezone: string
  /** It was sent: the sheet becomes its job's, landing as this one stood. */
  onSent?: (jobId: string, landing: BodyLanding | null) => void
  onClose?: () => void
}) {
  const item = useOutboxItem(businessId, localId)
  const access = useAccess()
  const queryClient = useQueryClient()
  const roster = queryClient.getQueryData<Roster>(
    rq.roster(businessId).queryKey,
  )
  const down = useLineDown()
  const lineLive = useSyncExternalStore(
    keeper.subscribe,
    () => keeper.lineLive(),
    () => false,
  )
  const [deps] = useState(pageItemDeps)
  const [alert, setAlert] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'item' | 'mayHaveGone' | null>(null)
  const [editing, setEditing] = useState<{
    item: OutboxItem
    focusDate: boolean
  } | null>(null)
  const editOpen = editing !== null
  const bodyRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  // Whether its footer has been on screen: its space stays for the sheet's
  // while, as the footer's going would move the sheet's top edge.
  const hadFooter = useRef(false)
  // Whether the sheet is still up: what a tap began may answer after it.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Discarded or wiped while open: the sheet closes.
  const seen = useRef(false)
  if (item) seen.current = true
  const gone = item === undefined && seen.current
  const latestClose = useRef(onClose)
  latestClose.current = onClose
  useEffect(() => {
    if (gone) latestClose.current?.()
  }, [gone])

  // Sent: the sheet becomes its job's, a Recurring Job's once its first
  // visit is known, for FIND_WAIT_MS at most after it is seen sent. Not
  // while an Edit is open on it: its Book says it was sent meanwhile, and
  // what was typed stays until the form is closed (§10.3). Handed over once
  // the job can be drawn (`jobs.get` read, FIND_WAIT_MS at most), so the
  // sheet goes from this to the job, never through bones.
  const target = item ? handOverTo(item, outbox.answeredWith(localId)) : null
  const sentSeen = item?.state === 'sent'
  const [waitedOut, setWaitedOut] = useState(false)
  useEffect(() => {
    if (!sentSeen || editOpen) return
    const timer = setTimeout(() => setWaitedOut(true), FIND_WAIT_MS)
    return () => clearTimeout(timer)
  }, [sentSeen, editOpen])
  const latestSent = useRef(onSent)
  latestSent.current = onSent
  const handed = useRef(false)
  useEffect(() => {
    if (target === null || handed.current || waitedOut || editOpen) return
    handed.current = true
    let done = false
    const handOver = () => {
      if (done || !mounted.current) return
      done = true
      const body = bodyRef.current
      latestSent.current?.(
        target,
        body && {
          height:
            body.getBoundingClientRect().height +
            (footerRef.current?.getBoundingClientRect().height ?? 0),
          scrollTop: body.scrollTop,
        },
      )
    }
    setTimeout(handOver, FIND_WAIT_MS)
    void queryClient
      .prefetchQuery({
        ...convexQuery(api.jobs.get, {
          businessId,
          jobId: target as Id<'jobs'>,
        }),
        retry: false,
      })
      .then(handOver, handOver)
  }, [target, waitedOut, editOpen, queryClient, businessId])

  // Sent with no answer: whether any tab still holds it, looked at every
  // LOCK_LOOK_MS, for "This may already be booked" (§6.3); for each send,
  // so what one found never stands for the next.
  const sending = item?.state === 'sending'
  const sentAt = item?.lastAttemptAt ?? null
  const [lockFree, setLockFree] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!sending) return
    const locks = browserLocks()
    if (!locks) return
    let stopped = false
    const look = async () => {
      const held = await lockHeld(locks, itemLock(localId))
      if (stopped) return
      setLockFree(!held)
      setNow(Date.now())
    }
    void look()
    const timer = setInterval(() => void look(), LOCK_LOOK_MS)
    return () => {
      stopped = true
      clearInterval(timer)
      setLockFree(false)
    }
  }, [sending, sentAt, localId])

  // An Edit open in another tab: the sheet looks again when its lease runs
  // out, and every LOCK_LOOK_MS whether that tab has gone, which lets it go
  // (`lapseLeftEdits`), so it is never locked by a lease nobody holds.
  const lease =
    item && isReadable(item) && item.editing?.tab !== outbox.tab
      ? item.editing
      : null
  const leaseTab = lease?.tab ?? null
  const leaseUntil = lease?.until ?? 0
  useEffect(() => {
    if (leaseTab === null) return
    const lapse = setTimeout(
      () => setNow(Date.now()),
      Math.max(leaseUntil - Date.now(), 0) + 1,
    )
    const look = () => {
      const held = deps.get(localId)
      if (held) void lapseLeftEdits([held], deps)
    }
    look()
    const timer = setInterval(look, LOCK_LOOK_MS)
    return () => {
      clearTimeout(lapse)
      clearInterval(timer)
    }
  }, [leaseTab, leaseUntil, localId, deps])

  // An Edit open: held for other tabs while it is, let go when it closes or
  // the sheet goes.
  useEffect(() => {
    if (!editOpen) return
    const timer = setInterval(() => renewEdit(localId, deps), EDIT_RENEW_MS)
    return () => {
      clearInterval(timer)
      endEdit(localId, deps)
    }
  }, [editOpen, localId, deps])

  if (item === null) return null
  if (item === undefined) {
    return (
      <div className="px-4 py-10">
        <Drawer.Title className="text-sheet-title text-ink">Job</Drawer.Title>
        <p className="mt-1 text-body text-ink-2">{NOT_ON_PHONE}</p>
      </div>
    )
  }
  // Drawn only in the browser, once the outbox is read: the phone's clock.
  const todayKey = dayKeyOf(Date.now(), timezone)
  const parent =
    isReadable(item) && 'local' in item.booking.property
      ? outbox.get(item.booking.property.local)
      : undefined
  const facts: InsetFacts = {
    item,
    lineLive,
    held: sender.heldReason(localId),
    sendingHere: sender.sendingHere(localId),
    sendingElsewhere: sender.sendingElsewhere(localId),
    storageTrouble: sender.storageNotAnswering(),
    timezone,
    todayKey,
    editingHere: outbox.editingHere.has(localId),
    parentClient: parent?.display.clientName ?? null,
    now,
    tab: outbox.tab,
  }
  const footer = outboxFooter(item, {
    now,
    tab: outbox.tab,
    mayHaveGone: mayAlreadyBeBooked(item, {
      now,
      refusedFinds: sender.refusedFinds(localId),
      sendingHere: facts.sendingHere,
      lockFree,
    }),
  })
  if (footer !== null) hadFooter.current = true

  async function edit(focusDate: boolean) {
    setAlert(null)
    setBusy(true)
    const begun = await beginEdit(localId, deps)
    // Closed meanwhile: nothing is open to hold it, so it is let go now.
    if (!mounted.current) {
      if ('item' in begun) endEdit(localId, deps)
      return
    }
    setBusy(false)
    if ('item' in begun) setEditing({ item: begun.item, focusDate })
    else setAlert(begun.data)
  }

  async function send() {
    setAlert(null)
    setBusy(true)
    const sent = await sendItem(localId, deps)
    setBusy(false)
    if (sent === 'error') setAlert('OUTBOX_STORAGE_UNSURE')
  }

  async function discard() {
    const mayHaveGone = confirm === 'mayHaveGone'
    setBusy(true)
    const result = await discardItem(localId, { mayHaveGone }, deps)
    // Gone meanwhile (Back, ✕): nothing is open to close, and the page's
    // close would act on whatever page is on screen now.
    if (!mounted.current) return
    setBusy(false)
    setConfirm(null)
    if (result === 'discarded') {
      onClose?.()
      return
    }
    // It began sending meanwhile, or a tab is asking whether it was booked:
    // the dialog goes, and the sheet, drawn in its new state, says why
    // (S22b).
    setAlert(DISCARD_REFUSALS[result])
  }

  const dialog = discardDialog(item, confirm ?? footer?.discard ?? 'item')
  return (
    <OutboxItemView
      facts={facts}
      footer={footer}
      holdFooter={footer === null && hadFooter.current}
      roster={roster}
      down={down}
      seesPrices={access.caps['prices.see']}
      alert={alert}
      busy={busy}
      bodyRef={bodyRef}
      footerRef={footerRef}
      onFix={(fix) => {
        if (fix === 'send' || fix === 'tryAgain') void send()
        else void edit(fix === 'changeDate')
      }}
      onEdit={() => void edit(false)}
      onDiscard={() => {
        setAlert(null)
        setConfirm(footer?.discard ?? 'item')
      }}
    >
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null)
        }}
        title={dialog.title}
        body={dialog.body}
        confirm={dialog.confirm}
        cancel={dialog.cancel}
        onConfirm={() => void discard()}
        // Refused, Discard is locked under the dialog: focus goes to the
        // footer, whose FormAlert says why, never to a button it can't take.
        returnFocus={(confirmed) => (confirmed ? footerRef.current : null)}
        pending={busy}
        pendingLabel="Discarding…"
        closeOnConfirm={false}
      />
      {editing !== null && isReadable(item) && (
        <Suspense fallback={null}>
          <NewJobSheet
            open
            businessId={businessId}
            dayKey={bookingDay(editing.item, timezone)}
            timezone={timezone}
            onClose={() => setEditing(null)}
            item={editing.item}
            focusDate={editing.focusDate}
          />
        </Suspense>
      )}
    </OutboxItemView>
  )
}
