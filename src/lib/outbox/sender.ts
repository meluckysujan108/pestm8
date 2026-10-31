import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { logConnection } from '#/lib/connectionLog'
import { signedInUserId, signedOutAfterAll } from '#/lib/rootState'
import { rq } from '#/lib/routeQueries'
import { flagIfTwoStepNeeded, isTwoStepNeeded } from '#/lib/twoStep'
import { outbox as pageOutbox } from './outbox'
import { bookingCall, newRequestId } from './outboxItem'
import { SEND_LOCK, itemLock, takeLock } from './outboxLocks'
import {
  classify,
  codeOf,
  firstVisitMeant,
  holdUntil,
  preSendProblem,
  retryAt,
  skipReason,
} from './outboxRules'
import {
  ANSWER_WAIT_MS,
  EARLIER_STINT_MARGIN_MS,
  FIND_WAIT_MS,
  OUTBOX_TICK_MS,
  SENT_KEEP_MS,
  SETTLE_MIN_AGE_MS,
  SIGNED_OUT_CHECK_AFTER,
  SWITCHED_HOLD_MS,
  isReadable,
} from './outboxSet'
import {
  answeredChange,
  beginSendChange,
  forgetSentChange,
  newRequestIdChange,
  preSendChange,
  renewEditChange,
  resultChange,
  retryOutbox,
  unlockChange,
  wipeOutboxForBusiness,
  wipeOutboxWhere,
} from './outboxStore'
import { onSwitchGate, switchStarting } from './switchGate'
import type { QueryClient } from '@tanstack/react-query'
import type { ConvexReactClient } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import type { Access } from '#/lib/access'
import type { Keeper } from '#/lib/offline/keeper'
import type { Id } from '../../../convex/_generated/dataModel'
import type { OutboxModel } from './outbox'
import type { OutboxItem, SendableBooking } from './outboxItem'
import type { HeldLock, Locks } from './outboxLocks'
import type { AccessNow } from './outboxRules'
import type { OutboxKind } from './outboxSet'

/**
 * The outbox at run time: sends the bookings kept on this phone, by itself,
 * while PestM8 is open with signal (lib/outbox/, plan part 2c §4–§6).
 *
 * Attached once per page load in the browser (root-provider.tsx), where Web
 * Locks exist: without them nothing can have been kept here. It runs whether
 * or not keeping is switched on (`OUTBOX_ENABLED`), so a booking already on
 * a phone still goes; with nothing kept, which is every phone until then, it
 * reads nothing and calls nothing.
 *
 * A booking goes only while every gate holds, looked at before each step and
 * again just before the call:
 * - G0 it is still on the phone (no sign-out discarded it, nothing cleared it);
 * - G1 its person is the one signed in on this page;
 * - G2 the socket's sign-in token is theirs (another tab's sign-in can hand
 *   it someone else's), or it has none yet;
 * - G3 the business on screen is the booking's: one for another business
 *   waits until the person is back in it;
 * - G4 the line is live: connected, signal, PestM8 heard within 20 s;
 * - G5 `access:me` is live and theirs (it names the membership the booking
 *   was saved under: below), and they are writing as themselves: not in
 *   someone else's account, no switch that ended for some other reason than
 *   time (`degraded`), and saved since they were last removed from the
 *   business (below);
 * - G6 no account switch is starting, in this tab or another (switchGate.ts);
 * - G7 this build can read it (not a newer build's);
 * - G8 it is waiting or unanswered, not being edited, not held or backing
 *   off, and not waiting on the booking that makes its site;
 * - G9 two-step sign-in is not being asked for.
 * The server holds to the same (`asMembership`, convex/lib/outboxGuards.ts):
 * a send that lands in someone else's account is refused NOT_OWN_ACCOUNT.
 *
 * Each tab sends one booking at a time, and each booking from one tab at a
 * time: its Web Lock (outboxLocks.ts) is held for its call's life, and a
 * booking whose lock another tab holds is passed over, so a frozen tab
 * blocks only its own. A booking is marked as going (`beginSend`) before
 * the call, and the call is never made if that mark didn't land.
 *
 * A booking sent with no answer heard is locked: it may already be booked.
 * It is settled by asking the server whether its request id made anything
 * (`clientRequests.find`), from a fresh subscription, on a live line, at
 * least SETTLE_MIN_AGE_MS after it went, under its lock: so no tab can still
 * have the call out.
 *
 * Whose an answer is. The socket's token (`keeper.socketUserId`) is read as
 * soon as it is fetched, before the server has run anything with it, so for
 * a moment after another tab's sign-in hands this socket a token (a shared
 * tablet's), what is live on it is still the last person's. That holds a
 * send (the server refuses one in the wrong account, `NOT_OWN_ACCOUNT`), but
 * nothing could undo a booking forgotten on its word. So nothing is
 * forgotten on an answer that doesn't show it is the person's: `access:me`
 * names their membership, which is one person's in one business, and the
 * business list lists a membership one of their bookings was saved under.
 *
 * Removed and invited back: a rejoin makes the same membership active again
 * (invitations.redeem), so the membership a booking was saved under can't
 * tell the two stints apart. `access:me` says when the person was last
 * removed (`lastRemovedAt`); a booking saved before then goes as the removal
 * would have taken it, had the phone heard of it (EARLIER_STINT_MARGIN_MS),
 * whatever its state, every run (`tidy`). A backend from before the field
 * leaves it out, and this check with it.
 *
 * What it does goes into the phone's connection notes (`outbox-*`): codes,
 * counts and times, never what was booked.
 */

/** What a step did: nothing, something that keeps the item where it can't
 * go again yet, or moved it on. */
type StepResult = 'skipped' | 'acted' | 'progress'

/**
 * What the person's sheet hears of the send it started (`sendHeld`). The
 * sender never deletes a booking on an answer: what it writes is safe
 * whatever the sheet does next, and only the sheet, still open, takes a
 * booking off the phone, before it says so (book.ts).
 */
export type SendOutcome =
  | { outcome: 'sent'; id: string }
  /** Refused, nothing made: the sheet's to show, while it is still open.
   * `left`: the booking as the refusal left it, needing a look, for the
   * sheet to take off the phone first; absent, nothing of it is on it. */
  | { outcome: 'refused'; error: unknown; left?: OutboxItem }
  /** The server's kill switch: the booking held (`left`), for the sheet,
   * while it is still open, to take off the phone and send straight. */
  | { outcome: 'paused'; error: unknown; left?: OutboxItem }
  /** The sender has it from here. */
  | { outcome: 'kept' }

/**
 * Why a booking can't go now. The ones the person might need told are
 * named for the words its sheet shows; the rest are what the gates and
 * `skipReason` found.
 */
export type HeldReason =
  | 'signed-out'
  | 'other-person'
  | 'other-business'
  | 'newer-build'
  | 'state'
  | 'editing'
  | 'retry'
  | 'hold'
  | 'parent'
  | 'switched-hold'
  | 'two-step'
  | 'line'
  | 'access'
  | 'switched'
  | 'switch-starting'

type Gate = HeldReason | 'gone' | 'earlier-stint' | null

/**
 * The sheet waiting on the send it started (`sendHeld`): told once, and
 * waiting only until then, by the answer or its time running out. A refusal
 * is the sheet's to show only while it still waits: told, it may have
 * closed, and nobody would hear it.
 */
type Listener = {
  waiting: () => boolean
  /** The answer is in and the sheet's: its wait is for what becomes of it
   * now, the phone's storage at most STORE_OP_MS. */
  hold: () => void
  tell: (outcome: SendOutcome) => void
}

export type SenderConvex = Pick<ConvexReactClient, 'mutation' | 'watchQuery'>
export type SenderKeeper = Pick<
  Keeper,
  | 'lineLive'
  | 'isLive'
  | 'enteredBusiness'
  | 'socketUserId'
  | 'connection'
  | 'subscribe'
>
export type SenderDeps = {
  convex: SenderConvex
  qc: Pick<QueryClient, 'getQueryData' | 'getQueryState'>
  keeper: SenderKeeper
  locks: Locks
  /** This page load's (`outbox.ts`), unless a test hands in its own. */
  outbox?: OutboxModel
}

type Ready = Required<SenderDeps>

/** What a request id made, as `clientRequests.find` says, if anything. */
type Made = {
  id: string
  propertyId?: Id<'properties'>
  firstJobId?: Id<'jobs'>
}

type FindAnswer = { found: Made | null } | { refused: unknown } | 'timeout'

/** `clientRequests.find`'s answer, as one shape whatever its kind. */
function madeOf(
  answer: FunctionReturnType<typeof api.clientRequests.find>,
): Made | null {
  if (answer === null) return null
  return {
    id: answer.id,
    ...('propertyId' in answer &&
      answer.propertyId !== undefined && { propertyId: answer.propertyId }),
    ...('firstJobId' in answer &&
      answer.firstJobId !== undefined && { firstJobId: answer.firstJobId }),
  }
}

const LIST_KEY = convexQuery(api.businesses.listForUser, {}).queryKey

type Listed = FunctionReturnType<typeof api.businesses.listForUser>

/** How many passes one wake may make, while things keep changing. */
const MAX_ROUNDS = 5
/** Soon: after the send lock was taken by a switch starting. */
const SOON_MS = 1_000

/** Oldest first; the same moment, by key. */
function byAge(a: OutboxItem, b: OutboxItem): number {
  return a.createdAt - b.createdAt || (a.localId < b.localId ? -1 : 1)
}

/**
 * Whether `access`, the answer of `access:me` for `item`'s business, is
 * about `item`'s person: it names the membership the booking was saved
 * under. A person has one membership in a business, which a rejoin makes
 * active again (invitations.redeem), so an answer naming another is someone
 * else's, whatever the socket's token now says (the top of this file).
 */
export function answersFor(item: OutboxItem, access: Access): boolean {
  return isReadable(item) && item.membershipId === access.membershipId
}

/**
 * Whether `item` was saved in an earlier stint of the person's in its
 * business: before they were last removed from it (`lastRemovedAt`), as an
 * answer that is theirs says.
 */
export function fromEarlierStint(item: OutboxItem, access: Access): boolean {
  const removed = access.lastRemovedAt
  return (
    answersFor(item, access) &&
    typeof removed === 'number' &&
    item.createdAt < removed - EARLIER_STINT_MARGIN_MS
  )
}

export class Sender {
  private deps: Ready | null = null
  private detachNow: (() => void) | null = null

  private running = false
  private again = false
  private kickQueued = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private soonAt: number | null = null

  // The calls this tab has out, by booking, and the connection each went on.
  private readonly pending = new Map<
    string,
    { connection: number; startedAt: number }
  >()
  // The item locks this tab holds now: a step's, or a sheet's (`sendHeld`).
  private readonly heldHere = new Set<string>()
  // Bookings whose lock another tab held when this one looked.
  private readonly elsewhere = new Set<string>()
  // Sheets still open on a send they started (`watchAnswer`).
  private readonly handles = new Map<string, number>()
  // Storage didn't answer for these: not tried again until then.
  private readonly trouble = new Map<string, number>()
  private storageTrouble = false
  // A SWITCHED answer holds until access:me is pushed again, and this long.
  private readonly switchedMarks = new Map<
    string,
    { connection: number; count: number; until: number }
  >()
  // A request id this page load replaced, which isn't replaced twice.
  private readonly renewed = new Set<string>()
  // How many finds were refused, by booking (for "may already be booked").
  private readonly findRefusals = new Map<string, number>()
  // Each booking's held reason as last noted, and how many looks found it.
  private readonly heldNotes = new Map<
    string,
    { why: string | null; n: number }
  >()
  private signedOutInARow = 0
  private switchedInARow = 0
  private lastMarks = ''

  // ── Set-up ───────────────────────────────────────────────────────────────

  /**
   * Starts sending for this page load (root-provider.tsx): in the browser,
   * where Web Locks exist, after the keeper. A second attach replaces the
   * first. Returns the way to stop, for tests.
   */
  attach(deps: SenderDeps): () => void {
    this.detachNow?.()
    const ready: Ready = { ...deps, outbox: deps.outbox ?? pageOutbox }
    this.deps = ready
    const stopOutbox = ready.outbox.start()
    const stops = [
      ready.outbox.subscribe(() => this.kick()),
      ready.keeper.subscribe(() => this.onKeeper()),
      onSwitchGate(() => {
        if (!switchStarting()) this.kick()
      }),
    ]
    const doc = typeof document === 'undefined' ? null : document
    const onVisibility = () => {
      if (doc?.visibilityState !== 'visible') return
      this.renewEdits()
      retryOutbox()
      this.kick()
    }
    doc?.addEventListener('visibilitychange', onVisibility)
    const detach = () => {
      for (const stop of stops) stop()
      stopOutbox()
      doc?.removeEventListener('visibilitychange', onVisibility)
      clearTimeout(this.timer)
      this.timer = undefined
      if (this.detachNow === detach) {
        this.detachNow = null
        this.deps = null
      }
    }
    this.detachNow = detach
    this.kick()
    return detach
  }

  /** Looks for something to send, once whatever is under way has finished. */
  kick(): void {
    if (!this.deps || this.kickQueued) return
    this.kickQueued = true
    queueMicrotask(() => {
      this.kickQueued = false
      if (!this.deps) return
      if (this.running) this.again = true
      else void this.loop()
    })
  }

  // ── For the screens ──────────────────────────────────────────────────────

  /**
   * How many calls of the outbox's this tab has out. They wait on the
   * phone's storage, not only in the Convex client's memory, so a reload
   * loses none of them (lib/reach.ts `savesWaiting`).
   */
  inflight(): number {
    return this.pending.size
  }

  /**
   * The person's bookings not sent yet for the business on screen, waiting
   * or unanswered, for ConnectionNotice: and whether they wait on the person
   * being back in their own account. Null with none.
   */
  notice(): { count: number; held: 'switched' | null } | null {
    const deps = this.deps
    const userId = signedInUserId()
    const b = deps?.keeper.enteredBusiness()
    if (!deps || userId === null || !b) return null
    const count = deps.outbox
      .all()
      .filter(
        (item) =>
          item.userId === userId &&
          item.businessId === b._id &&
          (item.state === 'waiting' || item.state === 'sending'),
      ).length
    if (count === 0) return null
    const access = deps.qc.getQueryData<Access>(rq.access(b._id).queryKey)
    const switched =
      access !== undefined &&
      (access.actingAs !== null ||
        access.degraded !== null ||
        access.view?.mode === 'account')
    return { count, held: switched ? 'switched' : null }
  }

  /** Why `localId` can't go now, if it can't: for its sheet's words. */
  heldReason(localId: string): HeldReason | null {
    const item = this.deps?.outbox.get(localId)
    if (!item) return null
    const why = this.gate(item)
    return why === 'gone' || why === 'earlier-stint' ? null : why
  }

  /** Whether another tab or window had `localId`'s lock when this looked. */
  sendingElsewhere(localId: string): boolean {
    return this.elsewhere.has(localId)
  }

  /** Whether this tab has a call out for `localId`. */
  sendingHere(localId: string): boolean {
    return this.pending.has(localId)
  }

  /** Whether the phone's storage failed to answer the last send's mark. */
  storageNotAnswering(): boolean {
    return this.storageTrouble
  }

  /** How many times the server refused to say whether it was booked. */
  refusedFinds(localId: string): number {
    return this.findRefusals.get(localId) ?? 0
  }

  // ── From the sheet ───────────────────────────────────────────────────────

  /**
   * A sheet still open on the booking it just kept: while this is held and
   * the sheet still waits on the send it started (`sendHeld`), a refusal
   * that made nothing is the sheet's to hear, once the booking needs a look
   * on the phone (or the kill switch's, once it is held): the sheet, if it
   * is still open then, takes it off the phone before its FormAlert says so
   * (book.ts). Otherwise, once released, on the sender's own send, or once
   * `sendHeld` has answered, nobody hears of it, and it stays as written.
   * Decided in the same turn as the answer. Released when the sheet closes
   * or unmounts.
   */
  watchAnswer(localId: string): { release: () => void } {
    this.handles.set(localId, (this.handles.get(localId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        const left = (this.handles.get(localId) ?? 1) - 1
        if (left > 0) this.handles.set(localId, left)
        else this.handles.delete(localId)
      },
    }
  }

  /**
   * Sends `localId` now, as the sender would, under the item lock the sheet
   * took when it kept it (`lock`), which is released once the call it
   * covers has settled, never with the sheet. Answers as soon as the server
   * does, and within ANSWER_WAIT_MS whatever happens: `kept` at once when a
   * gate doesn't hold or the booking isn't waiting to go, and `kept` once
   * that time is up with no answer, when the sender has it from there and a
   * refusal that comes later makes it need a look. The sheet waits on this
   * alone, so it can never stop waiting while a refusal is still its to
   * show. An answer in time that is the sheet's is waited for until the
   * phone has written what it says.
   */
  sendHeld(localId: string, lock: HeldLock): Promise<SendOutcome> {
    return new Promise((resolve) => {
      let told = false
      const listener: Listener = {
        waiting: () => !told,
        hold: () => clearTimeout(timer),
        tell: (outcome) => {
          if (told) return
          told = true
          clearTimeout(timer)
          resolve(outcome)
        },
      }
      const timer = setTimeout(
        () => listener.tell({ outcome: 'kept' }),
        ANSWER_WAIT_MS,
      )
      this.heldHere.add(localId)
      void this.stepItem(localId, listener)
        .catch(() => undefined)
        .finally(() => {
          this.heldHere.delete(localId)
          lock.release()
          listener.tell({ outcome: 'kept' })
          this.kick()
        })
    })
  }

  // ── The run ──────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    this.running = true
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        this.again = false
        const userId = signedInUserId()
        if (userId === null) break
        await this.tidy(userId)
        const tried = new Set<string>()
        while (await this.step(userId, tried)) {
          // One booking at a time, each tried once a round.
        }
        if (!this.kickedSince()) break
      }
      if (this.kickedSince()) this.soon()
    } catch {
      logConnection('outbox-store-failed', { op: 'run' })
    } finally {
      this.running = false
      this.schedule()
    }
  }

  /** Whether a kick came while the run was under way. */
  private kickedSince(): boolean {
    return this.again && this.deps !== null
  }

  /**
   * The bookings that may go now, oldest first, noting why each of the rest
   * can't (once per change of reason), and forgetting any from an earlier
   * stint.
   */
  private candidates(userId: string): Array<OutboxItem> {
    const deps = this.deps
    if (!deps) return []
    const out: Array<OutboxItem> = []
    const all = deps.outbox.all().sort(byAge)
    for (const item of all) {
      if (item.userId !== userId) continue
      const why = this.gate(item)
      if (why === 'earlier-stint') {
        this.forgetEarlierStint(item)
        continue
      }
      this.noteHeld(item, why)
      if (why === null) out.push(item)
    }
    // What has gone from the phone has no reason to note any more.
    const here = new Set(all.map((item) => item.localId))
    for (const localId of this.heldNotes.keys()) {
      if (!here.has(localId)) this.heldNotes.delete(localId)
    }
    return out
  }

  /** One booking moved on, if any could be: whether anything was done. */
  private async step(userId: string, tried: Set<string>): Promise<boolean> {
    const deps = this.deps
    if (!deps) return false
    const now = Date.now()
    for (const item of this.candidates(userId)) {
      const id = item.localId
      if (tried.has(id) || this.pending.has(id) || this.heldHere.has(id))
        continue
      if ((this.trouble.get(id) ?? 0) > now) continue
      // Not settled while a page just closed may still have its call on
      // the way: a timer comes back for it (`schedule`).
      if (
        item.state === 'sending' &&
        now - (item.lastAttemptAt ?? 0) < SETTLE_MIN_AGE_MS
      ) {
        continue
      }
      tried.add(id)
      const lock = await takeLock(deps.locks, itemLock(id), {
        ifAvailable: true,
      })
      if (!lock) {
        // Another tab has it: its call is out, or it is settling it.
        this.elsewhere.add(id)
        continue
      }
      this.elsewhere.delete(id)
      this.heldHere.add(id)
      let result: StepResult
      try {
        result = await this.stepItem(id)
      } finally {
        this.heldHere.delete(id)
        lock.release()
      }
      if (result !== 'skipped') return true
    }
    return false
  }

  /**
   * One booking, under its lock: read afresh, then settled if it went
   * unanswered, checked before it goes, or sent.
   */
  private async stepItem(
    localId: string,
    listener?: Listener,
  ): Promise<StepResult> {
    const deps = this.deps
    if (!deps) return 'skipped'
    await deps.outbox.refresh()
    const item = deps.outbox.get(localId)
    if (!item) return 'skipped'
    const why = this.gate(item)
    if (why === 'earlier-stint') {
      return this.forgetEarlierStint(item) ? 'progress' : 'skipped'
    }
    if (why !== null) return 'skipped'
    if (item.state === 'sending') {
      // A sheet's own send is of one just kept: never unanswered yet.
      return listener ? 'skipped' : this.settle(item)
    }
    const problem = preSendProblem(item, Date.now())
    // A booking its sheet sends as it is made, with signal, is booked as
    // online books it: whether its first visit has gone is the server's to
    // say (`refuseBackfill`, a day back), not the phone's hour inside that.
    if (
      problem !== null &&
      !(listener !== undefined && problem === 'FIRST_VISIT_PAST')
    ) {
      const changed = await deps.outbox.change(
        'pre-send',
        localId,
        preSendChange(problem, Date.now()),
      )
      if (typeof changed !== 'object') return 'skipped'
      if (problem === 'STALE') logConnection('outbox-stale')
      return 'progress'
    }
    return this.send(item, listener)
  }

  // ── The gates ────────────────────────────────────────────────────────────

  /**
   * The first gate that doesn't hold for `item` (the top of this file), or
   * null when it may go. `forCall`: just before the call, on one already
   * marked as going, whose own state the step has seen to.
   */
  private gate(item: OutboxItem, forCall = false): Gate {
    const deps = this.deps
    if (!deps) return 'signed-out'
    const now = Date.now()
    if (!deps.outbox.get(item.localId)) return 'gone' // G0
    const userId = signedInUserId()
    if (userId === null || userId !== item.userId) return 'signed-out' // G1
    const socket = deps.keeper.socketUserId()
    if (socket !== null && socket !== item.userId) return 'other-person' // G2
    if (deps.keeper.enteredBusiness()?._id !== item.businessId) {
      return 'other-business' // G3
    }
    if (!isReadable(item)) return 'newer-build' // G7
    if (deps.outbox.editingHere.has(item.localId)) return 'editing'
    if (!forCall) {
      // G8
      const skip = skipReason(item, deps.outbox.all(), {
        now,
        editingHere: deps.outbox.editingHere,
      })
      if (skip !== null) return skip === 'foreign' ? 'newer-build' : skip
      if (this.switchedHeld(item, now)) return 'switched-hold'
    }
    if (isTwoStepNeeded()) return 'two-step' // G9
    if (!deps.keeper.lineLive()) return 'line' // G4
    const own = this.ownWriter(item) // G5
    if (own !== null) return own
    if (switchStarting()) return 'switch-starting' // G6, this tab
    return null
  }

  /**
   * G5: live and theirs, and writing as themselves, in the stint it was
   * saved in. An answer naming another membership is someone else's: it
   * holds the booking, and says nothing else about it.
   */
  private ownWriter(item: OutboxItem): Gate {
    const now = this.accessNow(item)
    if (now.kind !== 'live' || !answersFor(item, now.access)) return 'access'
    const access = now.access
    if (
      access.actingAs !== null ||
      access.degraded !== null ||
      access.view?.mode === 'account'
    ) {
      return 'switched'
    }
    if (fromEarlierStint(item, access)) {
      return this.deps?.keeper.socketUserId() === item.userId
        ? 'earlier-stint'
        : 'access'
    }
    return null
  }

  /** What `access:me` says now for `item`'s business, and whose it is. */
  private accessNow(
    item: OutboxItem,
  ):
    | { kind: 'live'; access: Access }
    | { kind: 'removed' }
    | { kind: 'unknown' } {
    const deps = this.deps
    if (!deps) return { kind: 'unknown' }
    const key = rq.access(item.businessId).queryKey
    const state = deps.qc.getQueryState(key)
    if (
      state?.status === 'error' &&
      codeOf(state.error) === 'NO_ACCESS' &&
      deps.keeper.socketUserId() === item.userId
    ) {
      return { kind: 'removed' }
    }
    if (!deps.keeper.isLive(key)) return { kind: 'unknown' }
    const access = deps.qc.getQueryData<Access>(key)
    return access ? { kind: 'live', access } : { kind: 'unknown' }
  }

  /** What an answer's class is decided on (outboxRules.ts `AccessNow`). */
  private accessContext(item: OutboxItem): AccessNow {
    const now = this.accessNow(item)
    if (now.kind === 'removed') return 'removed'
    return now.kind === 'live' && this.ownWriter(item) === null
      ? 'live'
      : 'unknown'
  }

  /** How many times access:me's answer has been set, for `switchedHeld`. */
  private accessCount(businessId: Id<'businesses'>): number {
    return (
      this.deps?.qc.getQueryState(rq.access(businessId).queryKey)
        ?.dataUpdateCount ?? 0
    )
  }

  /**
   * After a SWITCHED answer: held until access:me has been pushed again on
   * this connection (the switch it was refused for has shown, and gone), or
   * a new connection, which pushes everything again. The stored hold
   * (`holdUntil`) holds it at least as long, and the longest of those holds
   * lets it go whatever access:me does.
   */
  private switchedHeld(item: OutboxItem, now: number): boolean {
    const deps = this.deps
    const mark = this.switchedMarks.get(item.localId)
    if (!deps || !mark) return false
    if (
      now < mark.until &&
      mark.connection === deps.keeper.connection() &&
      mark.count === this.accessCount(item.businessId)
    ) {
      return true
    }
    this.switchedMarks.delete(item.localId)
    return false
  }

  /**
   * The person was removed and has been invited back since `item` was
   * saved: it, and every booking of theirs for that business from before,
   * in whatever state, goes as the removal would have taken them. Only on
   * an answer that is theirs, while the socket is theirs too. What goes is
   * handed out by nothing from then (`wipeOutboxWhere`), so it is asked once.
   * Whether it was asked.
   */
  private forgetEarlierStint(item: OutboxItem): boolean {
    const now = this.accessNow(item)
    if (
      now.kind !== 'live' ||
      this.deps?.keeper.socketUserId() !== item.userId ||
      !fromEarlierStint(item, now.access) ||
      // Dated ahead of the phone's clock (set back since), which a wipe,
      // taking only what was kept by when it is asked, would never take:
      // held, rather than asked for again every run.
      item.createdAt > Date.now()
    ) {
      return false
    }
    const access = now.access
    void wipeOutboxWhere(
      item.userId,
      (other) =>
        other.businessId === item.businessId && fromEarlierStint(other, access),
      'earlier-stint',
    )
    return true
  }

  /** `outbox-held`, only when a booking's reason changes (F20). */
  private noteHeld(item: OutboxItem, why: Gate): void {
    if (item.state !== 'waiting' && item.state !== 'sending') {
      this.heldNotes.delete(item.localId)
      return
    }
    const reason = why === 'gone' || why === 'earlier-stint' ? null : why
    const last = this.heldNotes.get(item.localId)
    if (last && last.why === reason) {
      last.n++
      return
    }
    if (reason !== null) {
      logConnection('outbox-held', {
        why: reason,
        n: last?.n ?? 0,
        was: last?.why ?? 'none',
      })
    }
    this.heldNotes.set(item.localId, { why: reason, n: 1 })
  }

  // ── Before a run ─────────────────────────────────────────────────────────

  /**
   * Deletes what was sent a while ago; forgets the person's bookings from an
   * earlier stint in a business, whatever their state (`forgetEarlierStint`:
   * one needing a look would otherwise go the moment the person sent it on);
   * and forgets the bookings for any business the person's `listForUser`,
   * live on this connection, no longer lists: offboarding from someone's
   * last business ends their session, so access:me never says NO_ACCESS
   * then. The last two only while the socket is theirs.
   */
  private async tidy(userId: string): Promise<void> {
    const deps = this.deps
    if (!deps) return
    const mine = deps.outbox.all().filter((item) => item.userId === userId)
    const now = Date.now()
    for (const item of mine) {
      if (
        item.state !== 'sent' ||
        !isReadable(item) ||
        item.sentAt === null ||
        item.sentAt + SENT_KEEP_MS > now ||
        // A booking made after it on its site still needs its answer.
        mine.some((other) => other.dependsOn === item.localId)
      ) {
        continue
      }
      await deps.outbox.change('forget-sent', item.localId, forgetSentChange())
    }
    if (deps.keeper.socketUserId() !== userId) return
    for (const item of deps.outbox.all()) {
      if (item.userId === userId) this.forgetEarlierStint(item)
    }
    this.forgetNotListed(userId)
  }

  /**
   * The bookings for any business the person's `listForUser`, live on this
   * connection, no longer lists. Theirs for certain only when it lists a
   * membership one of their bookings was saved under, a membership being
   * one person's: the socket's token alone can be theirs a moment before
   * the list is (the top of this file). A list that shows nothing of theirs
   * forgets nothing, and their bookings for a business they have left wait,
   * held, until it does (their next booking anywhere it lists) or they sign
   * out.
   */
  private forgetNotListed(userId: string): void {
    const deps = this.deps
    if (!deps || !deps.keeper.isLive(LIST_KEY)) return
    const listed = deps.qc.getQueryData<Listed>(LIST_KEY)
    if (!Array.isArray(listed)) return
    const mine = deps.outbox.all().filter((item) => item.userId === userId)
    const known = new Set(
      mine.filter(isReadable).map((item) => item.membershipId),
    )
    if (!listed.some((b) => known.has(b.membershipId))) return
    const theirs = new Set<string>(listed.map((b) => b.businessId))
    const now = Date.now()
    const gone = new Set(
      mine
        // What goes is handed out by nothing from then, so it is asked once;
        // one dated ahead of the phone's clock is never taken
        // (`forgetEarlierStint`), and isn't asked for over and over.
        .filter((item) => !theirs.has(item.businessId) && item.createdAt <= now)
        .map((item) => item.businessId),
    )
    for (const businessId of gone) {
      void wipeOutboxForBusiness({ businessId }, userId, 'not-listed')
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /**
   * The booking as it goes: one made on a client or site not sent yet goes
   * to the site that one made, once it has. Null while that waits; a
   * problem when its site can't be had.
   */
  private resolve(
    item: OutboxItem,
  ): SendableBooking | 'wait' | { problem: 'NOT_FOUND' } {
    const property = item.booking.property
    if (!('local' in property)) {
      return { ...item.booking, property }
    }
    const parent = this.deps?.outbox.get(property.local)
    if (parent && parent.state !== 'sent') return 'wait'
    const propertyId = parent?.result?.propertyId
    if (propertyId === undefined) {
      // Just sent, from another tab perhaps, whose ask for the site it made
      // may still be on its way (`followUp`).
      const justSent =
        parent !== undefined &&
        parent.sentAt !== null &&
        Date.now() - parent.sentAt < 2 * FIND_WAIT_MS
      return justSent ? 'wait' : { problem: 'NOT_FOUND' }
    }
    return { ...item.booking, property: { propertyId } }
  }

  private async send(
    item: OutboxItem,
    listener?: Listener,
  ): Promise<StepResult> {
    const deps = this.deps
    if (!deps) return 'skipped'
    const id = item.localId
    const args = this.resolve(item)
    if (args === 'wait') return 'skipped'
    if ('problem' in args) {
      const changed = await deps.outbox.change(
        'pre-send',
        id,
        preSendChange(args.problem, Date.now()),
      )
      return typeof changed === 'object' ? 'progress' : 'skipped'
    }
    if (this.gate(item) !== null) return 'skipped'
    const sendLock = await takeLock(deps.locks, SEND_LOCK, {
      mode: 'shared',
      ifAvailable: true,
    })
    if (!sendLock) {
      // An account switch is starting, here or in another tab.
      this.soon()
      return 'skipped'
    }
    try {
      if (this.gate(item) !== null) return 'skipped'
      const begun = await deps.outbox.change(
        'beginSend',
        id,
        beginSendChange(Date.now()),
      )
      if (begun === 'error') {
        // Never a call the phone hasn't marked: one that then lands late
        // leaves it locked with no call out, settled after a while.
        this.storageTrouble = true
        this.trouble.set(id, Date.now() + OUTBOX_TICK_MS)
        return 'acted'
      }
      // Refused: another tab or an Edit moved first, or it has outlived its
      // session since this step looked (`beginSendChange`), which the next
      // look says it needs a look for. The refusal reads it again.
      if (typeof begun !== 'object') return 'skipped'
      this.storageTrouble = false
      // The booking as that mark read it, in the same transaction: an Edit
      // in another tab may have changed it since this step read it. And a
      // switch, a sign-in or the line can have moved while it was written.
      // Nothing has gone, so either way it waits again.
      const going = this.resolve(begun)
      if (
        going === 'wait' ||
        'problem' in going ||
        this.gate(begun, true) !== null
      ) {
        await deps.outbox.change('unlock', id, unlockChange(Date.now()))
        return 'skipped'
      }
      const call = bookingCall(going, {
        clientRequestId: begun.requestId,
        asMembership: begun.membershipId,
        ...(firstVisitMeant(begun) && { refuseBackfill: true as const }),
      })
      const connection = deps.keeper.connection()
      const startedAt = Date.now()
      let sent: Promise<unknown>
      try {
        sent =
          call.fn === 'jobs.create'
            ? deps.convex.mutation(api.jobs.create, call.args)
            : deps.convex.mutation(api.recurrences.create, call.args)
      } catch (error) {
        sent = Promise.reject(error)
      }
      this.pending.set(id, { connection, startedAt })
      logConnection('outbox-send', {
        kind: begun.kind,
        attempt: begun.attempts,
        ms: startedAt - begun.createdAt,
      })
      let answer: { ok: unknown } | { error: unknown }
      try {
        answer = { ok: await sent }
      } catch (error) {
        answer = { error }
      }
      // No longer out, as the Convex client counts it (`inflight`), and no
      // call for a switch starting to wait on: what follows, the ask after a
      // Recurring Job included, holds the booking's own lock alone.
      this.pending.delete(id)
      sendLock.release()
      return await this.answered(begun, answer, connection, listener)
    } finally {
      this.pending.delete(id)
      sendLock.release()
    }
  }

  // ── Answers ──────────────────────────────────────────────────────────────

  private async answered(
    item: OutboxItem,
    answer: { ok: unknown } | { error: unknown },
    connection: number,
    listener?: Listener,
  ): Promise<StepResult> {
    const deps = this.deps
    if (!deps) return 'acted'
    // Decided now, in the turn the answer came in: whether the sheet that
    // sent it is still open on it, and still waiting, to hear of a refusal
    // that made nothing. Either way the booking is never deleted here: a
    // refusal makes it need a look, and the kill switch holds it, whatever
    // the sheet does while that is written (F1). The sheet, told, takes it
    // off the phone only if it is still open then (book.ts).
    const sheetOwns =
      listener !== undefined &&
      listener.waiting() &&
      (this.handles.get(item.localId) ?? 0) > 0
    // Its wait now ends with what this answer does, not with its time.
    if (sheetOwns) listener.hold()
    const id = item.localId
    const now = Date.now()
    const change = (
      op: string,
      apply: (i: OutboxItem) => OutboxItem | 'delete',
    ) => deps.outbox.change(op, id, answeredChange(apply))
    const hold = (until: number | null) =>
      change('answered', (i) => ({
        ...i,
        state: 'waiting',
        holdUntil: until,
        updatedAt: now,
      }))
    const needsLook = (code: string, extra: Partial<OutboxItem> = {}) =>
      change('answered', (i) => ({
        ...i,
        ...extra,
        state: 'needsLook',
        problem: { code },
        holdUntil: null,
        retryAt: null,
        updatedAt: now,
      }))

    if ('ok' in answer) {
      const resultId = String(answer.ok)
      // In memory before anything waits on the phone's storage: a day's list
      // takes the job for the booking's as soon as it shows (latchSlots.ts).
      deps.outbox.noteAnswered(id, resultId, now)
      listener?.tell({ outcome: 'sent', id: resultId })
      this.signedOutInARow = 0
      this.switchedInARow = 0
      this.switchedMarks.delete(id)
      const repeat = item.result?.id === resultId
      const done = await change('answered', (i) => ({
        ...i,
        state: 'sent',
        result: { ...(i.result ?? {}), id: resultId },
        sentAt: now,
        problem: null,
        holdUntil: null,
        retryAt: null,
        updatedAt: now,
      }))
      logConnection('outbox-sent', { ms: now - item.createdAt, repeat })
      if (typeof done === 'object') await this.followUp(done)
      return 'progress'
    }

    const error = answer.error
    const sameConnection = connection === deps.keeper.connection()
    const c = classify(error, {
      sameConnection,
      access: this.accessContext(item),
    })
    logConnection('outbox-refused', {
      code: c.code ?? 'none',
      cls: c.cls,
      ...(c.requestId !== undefined && { requestId: c.requestId }),
    })
    if (c.cls !== 'SIGNED_OUT') this.signedOutInARow = 0

    switch (c.cls) {
      case 'UNSETTLED':
        // Heard across a reconnect: it may follow a commit nobody heard.
        // Locked, and settled by asking (`settle`).
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      case 'SIGNED_OUT': {
        const inARow = ++this.signedOutInARow
        await hold(holdUntil('SIGNED_OUT', inARow, now))
        // A session revoked on the server answers nothing else, ever.
        if (inARow >= SIGNED_OUT_CHECK_AFTER && deps.keeper.lineLive()) {
          void signedOutAfterAll()
        }
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      }
      case 'TWO_STEP':
        flagIfTwoStepNeeded(error)
        await hold(null)
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      case 'SWITCHED': {
        const inARow = ++this.switchedInARow
        this.switchedMarks.set(id, {
          connection: deps.keeper.connection(),
          count: this.accessCount(item.businessId),
          until: now + SWITCHED_HOLD_MS[SWITCHED_HOLD_MS.length - 1],
        })
        await hold(holdUntil('SWITCHED', inARow, now))
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      }
      case 'PAUSED': {
        // Nothing was made. Held, so it never goes until the hold is up;
        // the sheet still open on it sends it straight instead.
        const left = await hold(holdUntil('PAUSED', 1, now))
        if (sheetOwns && (typeof left === 'object' || left === 'gone')) {
          listener.tell({
            outcome: 'paused',
            error,
            ...(typeof left === 'object' && { left }),
          })
          return 'acted'
        }
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      }
      case 'ACCESS':
        await hold(holdUntil('ACCESS', 1, now))
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      case 'NEW_ID':
        if (this.renewed.has(id)) {
          await needsLook(c.code ?? 'INVALID_REQUEST_ID')
        } else {
          this.renewed.add(id)
          await deps.outbox.change(
            'new-id',
            id,
            newRequestIdChange(newRequestId(), now),
          )
          logConnection('outbox-new-id')
        }
        listener?.tell({ outcome: 'kept' })
        return 'progress'
      case 'REMOVED':
        void wipeOutboxForBusiness(
          { businessId: item.businessId },
          item.userId,
          'no-access',
        )
        listener?.tell({ outcome: 'refused', error })
        return 'progress'
      case 'ASSIGNEE':
      case 'SITE_GONE':
      case 'FIELD': {
        const code = c.code ?? 'CONVEX_ERROR'
        // Nothing was made. Needing a look, it never goes by itself; the
        // sheet still open on it shows the refusal, as today, once it has
        // taken it off the phone. A mark that didn't land leaves it locked,
        // the sender's, so the sheet closes with it kept.
        const left = await needsLook(code)
        if (sheetOwns) {
          if (typeof left === 'object') {
            listener.tell({ outcome: 'refused', error, left })
          } else if (left === 'gone') {
            listener.tell({ outcome: 'refused', error })
          } else {
            listener.tell({ outcome: 'kept' })
          }
        }
        return 'progress'
      }
      case 'SERVER': {
        const failures = item.serverFailures + 1
        const at = retryAt(failures, item.lastAttemptAt ?? now)
        if (at === null) {
          await needsLook('SERVER', { serverFailures: failures })
          listener?.tell({ outcome: 'kept' })
          return 'progress'
        }
        await change('answered', (i) => ({
          ...i,
          state: 'waiting',
          serverFailures: failures,
          retryAt: at,
          updatedAt: now,
        }))
        listener?.tell({ outcome: 'kept' })
        return 'acted'
      }
    }
  }

  /**
   * Once a Recurring Job, or a booking another waits on for its site, is
   * sent: what it made, asked once on the line it went on, for the first
   * visit its card becomes and the site the next one goes to.
   */
  private async followUp(item: OutboxItem): Promise<void> {
    const deps = this.deps
    if (!deps || !isReadable(item)) return
    const waitedOn = deps.outbox
      .all()
      .some((other) => other.dependsOn === item.localId)
    if (item.kind !== 'series' && !waitedOn) return
    if (!deps.keeper.lineLive()) return
    const answer = await this.find(item, item.kind as OutboxKind)
    if (answer === 'timeout' || !('found' in answer) || !answer.found) return
    await deps.outbox.change(
      'result',
      item.localId,
      resultChange(
        {
          ...(answer.found.propertyId !== undefined && {
            propertyId: answer.found.propertyId,
          }),
          ...(answer.found.firstJobId !== undefined && {
            firstJobId: answer.found.firstJobId,
          }),
        },
        Date.now(),
      ),
    )
  }

  // ── Settling ─────────────────────────────────────────────────────────────

  /**
   * A booking sent with no answer heard, here or on an earlier page: asks
   * the server whether its request id made anything, for every kind it has
   * gone as. A record of any is its answer; nothing for every one unlocks
   * it, to go again with the same id. Anything else leaves it locked.
   */
  private async settle(item: OutboxItem): Promise<StepResult> {
    const deps = this.deps
    if (!deps) return 'skipped'
    const id = item.localId
    const started = Date.now()
    if (this.pending.has(id)) return 'skipped'
    if (started - (item.lastAttemptAt ?? 0) < SETTLE_MIN_AGE_MS) {
      return 'skipped'
    }
    if (!deps.keeper.lineLive()) return 'skipped'
    const kinds: Array<OutboxKind> =
      item.sentKinds.length > 0 ? item.sentKinds : [item.kind as OutboxKind]
    const answers = await Promise.all(
      kinds.map((kind) => this.find(item, kind)),
    )
    const ms = Date.now() - started
    for (const answer of answers) {
      if (answer === 'timeout' || !('found' in answer) || !answer.found) {
        continue
      }
      const found = answer.found
      const now = Date.now()
      await deps.outbox.change(
        'settle',
        id,
        answeredChange((i) => ({
          ...i,
          state: 'sent',
          result: {
            id: found.id,
            ...(found.propertyId !== undefined && {
              propertyId: found.propertyId,
            }),
            ...(found.firstJobId !== undefined && {
              firstJobId: found.firstJobId,
            }),
          },
          sentAt: now,
          problem: null,
          holdUntil: null,
          retryAt: null,
          updatedAt: now,
        })),
      )
      logConnection('outbox-settle', { found: true, ms })
      return 'progress'
    }
    if (answers.every((a) => a !== 'timeout' && 'found' in a)) {
      const unlocked = await deps.outbox.change(
        'unlock',
        id,
        unlockChange(Date.now()),
      )
      logConnection('outbox-settle', { found: false, ms })
      return typeof unlocked === 'object' ? 'progress' : 'acted'
    }
    for (const answer of answers) {
      if (answer === 'timeout' || !('refused' in answer)) continue
      const code = codeOf(answer.refused)
      flagIfTwoStepNeeded(answer.refused)
      if (code === 'NO_ACCESS' && this.accessNow(item).kind === 'removed') {
        void wipeOutboxForBusiness(
          { businessId: item.businessId },
          item.userId,
          'no-access',
        )
        return 'progress'
      }
      this.findRefusals.set(id, (this.findRefusals.get(id) ?? 0) + 1)
    }
    return 'acted'
  }

  /**
   * `clientRequests.find`, from a subscription of its own: never
   * `ConvexReactClient.query`, which may answer from what the client holds
   * and has no limit. Its arguments carry a key nothing else watches, so its
   * first answer is the server's. Given up after FIND_WAIT_MS, and stopped
   * on every path.
   */
  private find(item: OutboxItem, kind: OutboxKind): Promise<FindAnswer> {
    const deps = this.deps
    if (!deps) return Promise.resolve('timeout')
    return new Promise((resolve) => {
      const watching: { done: boolean; stop: (() => void) | null } = {
        done: false,
        stop: null,
      }
      const watch = deps.convex.watchQuery(api.clientRequests.find, {
        businessId: item.businessId,
        clientRequestId: item.requestId,
        kind,
      })
      const timer = setTimeout(() => finish('timeout'), FIND_WAIT_MS)
      function finish(answer: FindAnswer): void {
        if (watching.done) return
        watching.done = true
        clearTimeout(timer)
        watching.stop?.()
        resolve(answer)
      }
      const stop = watch.onUpdate(() => {
        try {
          const value = watch.localQueryResult()
          if (value !== undefined) finish({ found: madeOf(value) })
        } catch (error) {
          finish({ refused: error })
        }
      })
      // Answered as it subscribed: stopped now rather than left watching.
      if (watching.done) stop()
      else watching.stop = stop
    })
  }

  // ── Wakes ────────────────────────────────────────────────────────────────

  /**
   * The keeper changed: the line, a push, a sign-in token. A run only when
   * this person has bookings and something that decides whether they go
   * has moved, so a page with none does nothing here.
   */
  private onKeeper(): void {
    const deps = this.deps
    const userId = signedInUserId()
    if (!deps || userId === null) return
    const mine = deps.outbox.all().filter((item) => item.userId === userId)
    if (mine.length === 0) return
    const b = deps.keeper.enteredBusiness()
    const marks = [
      deps.keeper.lineLive(),
      b?._id ?? '-',
      deps.keeper.socketUserId() ?? '-',
      deps.keeper.connection(),
      b ? this.accessCount(b._id) : 0,
      b
        ? (deps.qc.getQueryState(rq.access(b._id).queryKey)?.status ?? '-')
        : '-',
      deps.keeper.isLive(LIST_KEY),
      deps.qc.getQueryState(LIST_KEY)?.dataUpdateCount ?? 0,
      isTwoStepNeeded(),
    ].join('|')
    if (marks === this.lastMarks) return
    this.lastMarks = marks
    this.kick()
  }

  /** This tab's Edits held a while longer: before the wake's run. */
  private renewEdits(): void {
    const deps = this.deps
    if (!deps) return
    const now = Date.now()
    for (const localId of deps.outbox.editingHere) {
      void deps.outbox.change(
        'renew-edit',
        localId,
        renewEditChange(deps.outbox.tab, now),
      )
    }
  }

  private soon(): void {
    this.soonAt = Date.now() + SOON_MS
  }

  /**
   * The next wake: the moment a booking's hold, backoff or wait to settle
   * ends, one sent long enough ago to delete, a switch starting has had its
   * time, and every OUTBOX_TICK_MS while anything waits, since nothing says
   * when a connected line goes quiet.
   */
  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const deps = this.deps
    const userId = signedInUserId()
    if (!deps || userId === null) return
    const now = Date.now()
    let next = this.soonAt ?? Infinity
    this.soonAt = null
    const at = (time: number | null) => {
      if (time !== null && time > now && time < next) next = time
    }
    for (const item of deps.outbox.all()) {
      if (item.userId !== userId || !isReadable(item)) continue
      if (item.state === 'waiting' || item.state === 'sending') {
        at(now + OUTBOX_TICK_MS)
        at(item.retryAt)
        at(item.holdUntil)
        if (item.editing) at(item.editing.until)
      }
      if (item.state === 'sending' && !this.pending.has(item.localId)) {
        at((item.lastAttemptAt ?? 0) + SETTLE_MIN_AGE_MS)
      }
      if (item.state === 'sent' && item.sentAt !== null) {
        at(item.sentAt + SENT_KEEP_MS)
      }
      at(this.trouble.get(item.localId) ?? null)
      at(this.switchedMarks.get(item.localId)?.until ?? null)
    }
    if (next === Infinity) return
    this.timer = setTimeout(() => this.kick(), Math.max(next - now, 0))
  }
}

/** This page load's. */
export const sender = new Sender()
