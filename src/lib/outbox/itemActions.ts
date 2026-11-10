import {
  heldLockNames,
  holdTabLock,
  itemLock,
  tabLock,
  takeLock,
} from './outboxLocks'
import { STORE_OP_MS, isReadable } from './outboxSet'
import {
  beginEditChange,
  confirmStaleChange,
  discardChange,
  endEditChange,
  renewEditChange,
  replaceChange,
  resendChange,
  unreplaceChange,
} from './outboxStore'
import type { HeldLock, Locks } from './outboxLocks'
import type { BookingArgs, OutboxDisplay, OutboxItem } from './outboxItem'
import type { Change, StoreResult } from './outboxStore'
import type { Sender } from './sender'

/**
 * What a booking's sheet does to the booking (plan part 2c §9.5, §9.7,
 * §10.3): Edit, and Book from it; Discard; Send and Try again. Each is one
 * guarded change in the phone's storage (outboxStore.ts), so a booking that
 * began sending meanwhile, in this tab or another, refuses it, and the sheet
 * says so in the phone's own words (outboxInset.ts `OUTBOX_ACTION_COPY`).
 */

/** A tap the phone refused, for `FormAlert` (`OUTBOX_ACTION_COPY`). */
export type ActionRefusal = { data: string }

export type ItemDeps = {
  /** This tab (`OutboxModel.tab`), whose an Edit's lease is. */
  tab: string
  /** `OutboxModel.editingHere`: never sent from this tab while in it. */
  editingHere: Set<string>
  /** `OutboxModel.landingHere`: a tap's write the phone's storage hasn't
   * answered, still out under the booking's lock. */
  landingHere: Set<string>
  get: (localId: string) => OutboxItem | undefined
  /** `OutboxModel.refresh`: the phone's bookings read again. */
  refresh: () => Promise<void>
  /** `OutboxModel.change`. */
  change: (
    op: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ) => Promise<StoreResult<OutboxItem | 'deleted'>>
  /** `OutboxModel.changeLanded`: what the change really came to. */
  changeLanded: (
    op: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ) => Promise<StoreResult<OutboxItem | 'deleted'>>
  locks: Locks | null
  lineLive: () => boolean
  sender: Pick<Sender, 'kick' | 'sendHeld' | 'sendingHere'>
  now: () => number
}

function refusal(code: string): ActionRefusal {
  return { data: code }
}

/** Why a change to `localId` was refused, as the phone holds it now: read
 * again first, as another tab's change may not have been heard yet. An Edit
 * open in another tab is `elsewhere`: refusing an Edit here, or this one's
 * Book, whose lease that tab took once it ran out. `unheld`: not sent, with
 * nobody's Edit on it now, as a Book whose own lease was let go finds it. */
async function refusedFor(
  localId: string,
  deps: ItemDeps,
  otherwise: string,
  elsewhere = 'OUTBOX_EDIT_ELSEWHERE',
  unheld = otherwise,
): Promise<string> {
  await deps.refresh().catch(() => undefined)
  const item = deps.get(localId)
  if (item === undefined || item.state === 'sending' || item.state === 'sent') {
    return otherwise
  }
  const lease = isReadable(item) ? item.editing : null
  return lease !== null && lease.tab !== deps.tab && lease.until > deps.now()
    ? elsewhere
    : unheld
}

/**
 * Edits' leases nobody holds any more (§10.3): one left by a page that went
 * mid-Edit (a reload, a closed tab, iOS killing the app), whose tab no
 * longer holds its lock (`tabLock`); or this tab's own with no Edit open
 * here (a begin that landed after it was given up). Each is let go now,
 * rather than holding the booking from every tab, and its sheet saying
 * another tab is changing it, for the rest of EDIT_LEASE_MS. A lease of a
 * tab still open stands, however long it is suspended. Whether any went.
 */
export async function lapseLeftEdits(
  items: ReadonlyArray<OutboxItem>,
  deps: Pick<ItemDeps, 'tab' | 'editingHere' | 'locks' | 'change' | 'now'>,
): Promise<boolean> {
  const now = deps.now()
  const leases = items.flatMap((item) =>
    isReadable(item) &&
    item.editing !== null &&
    item.editing.until > now &&
    !(item.editing.tab === deps.tab && deps.editingHere.has(item.localId))
      ? [{ localId: item.localId, tab: item.editing.tab }]
      : [],
  )
  if (leases.length === 0) return false
  // Another tab's is left only once the browser says its lock is gone.
  const held =
    deps.locks !== null && leases.some((lease) => lease.tab !== deps.tab)
      ? await heldLockNames(deps.locks)
      : null
  let lapsed = false
  for (const { localId, tab } of leases) {
    const own = tab === deps.tab
    if (!own && (held === null || held.has(tabLock(tab)))) continue
    const result = await deps.change('lapse-edit', localId, (item) =>
      // An Edit begun here meanwhile is this tab's again.
      own && deps.editingHere.has(localId)
        ? 'abort'
        : endEditChange(tab, deps.now())(item),
    )
    if (typeof result === 'object') lapsed = true
  }
  return lapsed
}

/**
 * Edit opens (§10.3): first, synchronously, into this tab's editing set, so
 * this tab's sender never starts it from here on (S11); then the lease, for
 * other tabs, which only a booking nothing can have been made of takes,
 * once this tab holds its own lock (`holdTabLock`); over a lease a page
 * that has gone left behind, once that is let go (`lapseLeftEdits`). A
 * refusal (it began sending since the sheet was drawn, or another tab is
 * changing it) takes it out of the set again, and no form opens.
 */
export async function beginEdit(
  localId: string,
  deps: ItemDeps,
): Promise<{ item: OutboxItem } | ActionRefusal> {
  deps.editingHere.add(localId)
  if (deps.locks !== null && !(await holdTabLock(deps.locks, deps.tab))) {
    deps.editingHere.delete(localId)
    deps.sender.kick()
    return refusal('OUTBOX_STORAGE')
  }
  const begin = () =>
    deps.change('begin-edit', localId, beginEditChange(deps.tab, deps.now()))
  let result = await begin()
  if (result === 'refused') {
    // Held by an Edit a page that has gone left behind: let go, and asked
    // once more.
    await deps.refresh().catch(() => undefined)
    const now = deps.get(localId)
    if (now && (await lapseLeftEdits([now], deps))) result = await begin()
  }
  if (typeof result === 'object') return { item: result }
  deps.editingHere.delete(localId)
  deps.sender.kick()
  if (result === 'error') return refusal('OUTBOX_STORAGE')
  if (result === 'refused') {
    return refusal(await refusedFor(localId, deps, 'OUTBOX_EDIT_REFUSED'))
  }
  return refusal('OUTBOX_EDIT_GONE')
}

/** The Edit still open here, held a while longer for other tabs. */
export function renewEdit(localId: string, deps: ItemDeps): void {
  if (!deps.editingHere.has(localId)) return
  void deps.change('renew-edit', localId, renewEditChange(deps.tab, deps.now()))
}

/**
 * The Edit closed without Book (or after it): out of the editing set, and
 * its lease let go, so it goes again by itself. "Discard your changes?"
 * throws away the edits only, never the booking.
 */
export function endEdit(localId: string, deps: ItemDeps): void {
  if (!deps.editingHere.delete(localId)) return
  void deps
    .change('end-edit', localId, endEditChange(deps.tab, deps.now()))
    .finally(() => deps.sender.kick())
}

/** Takes `name`, waiting for it at most STORE_OP_MS: null if not had. */
async function lockWithin(
  locks: Locks,
  name: string,
): Promise<HeldLock | null> {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), STORE_OP_MS)
  try {
    return await takeLock(locks, name, { signal: stop.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `landing` (a `changeLanded`, answered only once the write really has),
 * waited for STORE_OP_MS at most, as every other tap on the sheet is, since
 * WebKit's IndexedDB can leave a request unanswered for good. `'late'`: not
 * answered by then. It may land yet, so its lock stays held until it does.
 */
function withinStoreOp<T>(landing: Promise<T>): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    landing,
    new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), STORE_OP_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Book, from an Edit of a booking on the phone (§10.3): the booking as the
 * form has it now, in place of what was kept, under the booking's lock and
 * its own ids; then, with the line live, sent as New Job sends a booking it
 * kept (`sendHeld`), whose answer is waited for ANSWER_WAIT_MS at most.
 * Refused (it was sent, or locked, while the form was open: another tab,
 * after this one's lease ran out while iOS had it suspended), it throws for
 * the form's FormAlert, and the form stays open with what was typed.
 * `replaced`: told once the change has landed, before it is sent, when
 * closing the form loses nothing. `discarded`: "Discard your changes?" was
 * confirmed while it waited, read before the change, as it lands, and once
 * more when it has, so the edits thrown away are never booked: the booking
 * stays as it was, or, confirmed as the write was committing, is put back
 * under the lock still held (`kept`). Not answered by the phone's storage
 * within STORE_OP_MS, it throws `OUTBOX_STORAGE_UNSURE`, so "Booking…" never
 * waits for good: all of the above still comes of the write if it lands,
 * under the lock, which stays held till then, and every Book or Discard of
 * it here is refused the same way meanwhile (`landingHere`). `landedLate`:
 * told when it did land, in the booking's place, so the form closes as it
 * would have.
 */
export async function replaceItem(
  localId: string,
  next: { booking: BookingArgs; display: OutboxDisplay },
  deps: ItemDeps,
  replaced?: () => void,
  discarded: () => boolean = () => false,
  landedLate?: () => void,
): Promise<{ outcome: 'sent'; id: string } | { outcome: 'kept' }> {
  if (deps.landingHere.has(localId)) throw refusal('OUTBOX_STORAGE_UNSURE')
  const lock = deps.locks
    ? await lockWithin(deps.locks, itemLock(localId))
    : null
  if (deps.locks && !lock) throw refusal('OUTBOX_EDIT_BUSY')
  // Handed to `sendHeld`, which lets the lock go itself.
  let sending = false
  const letGo = () => {
    if (sending) return
    lock?.release()
    deps.sender.kick()
  }
  let late = false
  try {
    if (discarded()) return { outcome: 'kept' }
    const replace = replaceChange(deps.tab, next, deps.now())
    let before = null as OutboxItem | null
    const landing = deps.changeLanded('replace', localId, (item) => {
      if (discarded()) return 'abort'
      before = item
      return replace(item)
    })
    const landed = async (
      result: StoreResult<OutboxItem | 'deleted'>,
      closing?: () => void,
    ): Promise<{ outcome: 'sent'; id: string } | { outcome: 'kept' }> => {
      if (result === 'refused' && discarded()) return { outcome: 'kept' }
      if (result === 'refused') {
        throw refusal(
          await refusedFor(
            localId,
            deps,
            'OUTBOX_EDIT_SENT',
            'OUTBOX_EDIT_TAKEN',
            'OUTBOX_EDIT_LAPSED',
          ),
        )
      }
      if (result === 'error') throw refusal('OUTBOX_STORAGE')
      if (typeof result !== 'object') throw refusal('OUTBOX_EDIT_GONE')
      // Discarded as the write was committing: the lock is still held, so
      // nothing has gone, and the booking goes back as the form opened on it.
      if (before !== null && discarded()) {
        await deps.changeLanded(
          'unreplace',
          localId,
          unreplaceChange(before, result, deps.now()),
        )
        return { outcome: 'kept' }
      }
      // Booked: this tab may send it now, and the form may close.
      deps.editingHere.delete(localId)
      replaced?.()
      closing?.()
      if (!lock || !deps.lineLive()) return { outcome: 'kept' }
      sending = true
      const sent = await deps.sender.sendHeld(localId, lock)
      return sent.outcome === 'sent' ? sent : { outcome: 'kept' }
    }
    const answer = await withinStoreOp(landing)
    if (answer !== 'late') return await landed(answer)
    late = true
    deps.landingHere.add(localId)
    void landing
      .then((result) => {
        deps.landingHere.delete(localId)
        return landed(result, landedLate)
      })
      .catch(() => undefined)
      .finally(letGo)
    throw refusal('OUTBOX_STORAGE_UNSURE')
  } finally {
    if (!late) letGo()
  }
}

/**
 * Discard (§9.7): the booking, with any made after it on it, while nothing
 * can have been made of it. `mayHaveGone` (§6.3): one sent with no answer
 * that can't be settled, which the person discards knowing it may be
 * booked, only while no tab holds its lock and this page has no call out
 * for it, and under that lock until the delete has really landed or failed
 * (`changeLanded`), so it never lands after the lock is let go. `refused`:
 * it began sending first. `elsewhere`: an Edit is open on it in another tab.
 * `busy`: a tab holds its lock, asking PestM8 whether it was booked, or
 * sending it again. `error`: the delete failed. `unsure`: the phone's storage
 * hadn't answered in time, so it may land yet (with `mayHaveGone`, under the
 * lock, held till it does, while the dialog goes), or a write of this tab's
 * on it is still out.
 */
export async function discardItem(
  localId: string,
  opts: { mayHaveGone?: boolean },
  deps: ItemDeps,
): Promise<
  'discarded' | 'refused' | 'elsewhere' | 'busy' | 'error' | 'unsure'
> {
  if (deps.landingHere.has(localId)) return 'unsure'
  const settle = (result: StoreResult<OutboxItem | 'deleted'>) =>
    result === 'deleted' || result === 'gone'
      ? ('discarded' as const)
      : result === 'error'
        ? ('error' as const)
        : ('refused' as const)
  if (opts.mayHaveGone !== true) {
    const result = await deps.change(
      'discard',
      localId,
      discardChange({ from: { tab: deps.tab, now: deps.now() } }),
    )
    if (result === 'error') return 'unsure'
    if (result !== 'refused') return settle(result)
    return (await refusedFor(localId, deps, 'refused', 'elsewhere')) ===
      'elsewhere'
      ? 'elsewhere'
      : 'refused'
  }
  if (!deps.locks || deps.sender.sendingHere(localId)) return 'refused'
  const lock = await takeLock(deps.locks, itemLock(localId), {
    ifAvailable: true,
  })
  if (!lock) return 'busy'
  const letGo = () => {
    lock.release()
    deps.sender.kick()
  }
  let late = false
  try {
    if (deps.sender.sendingHere(localId)) return 'refused'
    const landing = deps.changeLanded(
      'discard',
      localId,
      discardChange({ mayHaveGone: true }),
    )
    const answer = await withinStoreOp(landing)
    if (answer !== 'late') return settle(answer)
    late = true
    deps.landingHere.add(localId)
    void landing.finally(() => {
      deps.landingHere.delete(localId)
      letGo()
    })
    return 'unsure'
  } finally {
    if (!late) letGo()
  }
}

/**
 * Send, on one that waited too long (`STALE`) or that New Job couldn't take
 * off the phone (`LEFT_ON_PHONE`); Try again, on one the server wouldn't
 * take (`SERVER`): it goes, now, with the line live. `error`: the phone's
 * storage hadn't answered in time, so it may go yet.
 */
export async function sendItem(
  localId: string,
  deps: ItemDeps,
): Promise<'going' | 'refused' | 'error'> {
  const item = deps.get(localId)
  const change =
    item?.problem?.code === 'STALE'
      ? confirmStaleChange(deps.now())
      : resendChange(deps.now())
  const result = await deps.change('send-now', localId, change)
  deps.sender.kick()
  if (typeof result === 'object') return 'going'
  return result === 'error' ? 'error' : 'refused'
}
