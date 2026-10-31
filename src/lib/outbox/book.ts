import { logConnection } from '#/lib/connectionLog'
import { bookingCall, itemFromBooking } from './outboxItem'
import { itemLock, takeLock } from './outboxLocks'
import { codeOf } from './outboxRules'
import { KEEP_WAIT_MS } from './outboxSet'
import type { Id } from '../../../convex/_generated/dataModel'
import type {
  BookingCall,
  OutboxDisplay,
  OutboxItem,
  SendableBooking,
} from './outboxItem'
import type { HeldLock, Locks } from './outboxLocks'
import type { Change, StoreResult } from './outboxStore'
import type { SendOutcome, Sender } from './sender'

/**
 * Book, in New Job (plan part 2c §3): the booking written to the phone
 * first, then sent.
 *
 * 1. **Can it be kept?** Only with keeping switched on (`OUTBOX_ENABLED`),
 *    Web Locks, the outbox read this page load, localStorage taking the
 *    page's notes (`localNotesWork`: what step 2 and a sign-out leave there
 *    is what every tab and the next page load go by), the person signed in,
 *    in their own account and not looking at it as someone else (`lensOf`),
 *    and a draft that hasn't given up keeping. Otherwise it goes **straight**
 *    to the server, through the Convex client as it always has, which holds
 *    it until the line is back for as long as PestM8 is open. Straight or
 *    not, it carries the draft's request id (`clientRequestId`), so a send
 *    repeated after a lost answer gets the first one's job back.
 * 2. **Kept**, under the booking's own Web Lock, taken first, within
 *    KEEP_WAIT_MS. Otherwise New Job sends it straight after all, saying
 *    whose it is (`asMembership`), and it stays straight: nothing that call
 *    comes to depends on the keep, and the draft keeps nothing more, every
 *    press of it after going straight as the person's own too. The
 *    keep is given up on at once (`giveUpKeep`): one that hasn't written yet
 *    never will, and one that had lands all the same and is taken off the
 *    phone again as it does (`settle`), under the lock, which is held till
 *    then however long that takes, so nothing can send it meanwhile. Until
 *    it is off, no tab shows or sends it, and the next page load deletes it
 *    if this one never got to. Only if the phone's storage really fails to
 *    delete it does it stay, needing a look: shown, and never sent by
 *    itself (`leftOnPhoneChange`). If that fails too, the lock is held for
 *    the rest of the page's life, as for a keep that never lands.
 * 3. **Sent**, once kept and shown kept, if the line is live: the sender's
 *    own send (`Sender.sendHeld`), which owns the wait for the answer,
 *    ANSWER_WAIT_MS at most. A job back closes the sheet; a refusal that
 *    made nothing is the sheet's FormAlert; the server's kill switch
 *    (`OUTBOX_PAUSED`) sends it straight instead; and anything else, or
 *    nothing in time, closes the sheet with the booking kept, the sender
 *    having it from there. With the line down, the sheet closes as soon as
 *    it shows the booking kept.
 * 4. **Taken off the phone**, for a refusal or the kill switch: the sender
 *    writes what is safe whatever the sheet does meanwhile (needing a look,
 *    or held), and the sheet takes it off the phone only if it is still
 *    open when it hears (`leftDropChange`), saying first that it isn't kept
 *    any more, and only once the screen shows that, so closing it asks
 *    first. What it shows then is what the phone's storage really did,
 *    however long it takes to say ("Booking…" till then), not its answer
 *    for taking too long: deleted, the refusal is FormAlert's and the kill
 *    switch's booking goes straight; still on the phone, the sheet closes
 *    with it kept. Closed as kept before then, the booking stays as the
 *    answer left it, as the sheet said (F1).
 * 5. **Discarded**: "Discard your changes?" confirmed (`discard`), or the
 *    sheet gone while the screen didn't show it kept (being kept, going
 *    straight, or being taken off after a refusal). That is the end of it on
 *    the phone: a keep still on its way is given up on at once, nothing
 *    goes straight from then, and whatever of it the phone kept, then or
 *    later, is taken off it again, as in 2. Only a call already out can
 *    still make the job, as on the straight path, which keeps nothing. The
 *    draft keeps nothing more, as in 2: pressed again on a sheet that
 *    didn't close (a Back whose move never landed), it goes straight as the
 *    person's own, never kept again under the key whose booking may still
 *    be coming off the phone.
 *
 * So what the sheet shows of a booking is what the phone does with it:
 * FormAlert, a straight call or a discard only once nothing of it is left
 * for the phone to send, and the sheet closed as kept whenever something is.
 * A close is decided on what the screen showed (`shown`, from the commit
 * that drew it, the sheet's lock with it), never on where the press had got
 * to a moment before React drew it; and the phone goes on with a booking as
 * kept (sending it, closing on it) or as not kept (taking it off) only once
 * the screen shows it so.
 *
 * What the sheet does with the outcome is guarded by its mount (S10): once
 * the person has closed it, or it has been opened again, a late answer
 * changes nothing on screen. With keeping switched off, it is as it was:
 * the sheet closes, and its `onBooked` runs, whenever the job comes back.
 */

export type KeepResult = 'kept' | 'exists' | 'refused' | 'error'

/** A call's answer: its value, or what it threw. */
export type Answer = { ok: unknown } | { error: unknown }

/** What is known so far of a press of Book. */
export type BookFacts = {
  /** Whether the booking can be kept on the phone (`canKeepNow`). */
  canKeep: boolean
  /**
   * The draft keeps nothing more (`BookingDraft.keepable` false: a keep of
   * it took too long, or was discarded), so every straight call of it says
   * whose it is, as one after a keep that took too long does.
   */
  asOwn?: boolean
  /** How the keep went within KEEP_WAIT_MS: `late`, still out by then. */
  keep?: KeepResult | 'late'
  /** Whether the line was live when it was kept. */
  lineLive?: boolean
  /** What the sender's own send came to (`Sender.sendHeld`). */
  sent?: SendOutcome
  /** The last straight call's answer, and whether it said whose it was. */
  direct?: { answer: Answer; asMembership: boolean }
  /**
   * Whether the sheet has gone (`dispose`) or been discarded (`discard`),
   * and how: closed with the booking kept (`booked` said), or discarded
   * before it was. Absent while it is open. Gone, an answer is nobody's on
   * screen, and nothing more goes straight for it.
   */
  closed?: 'kept' | 'discarded'
  /**
   * Discarded with the booking kept on the phone: it is being taken off
   * again (step 5 above).
   */
  unkept?: true
  /**
   * What became of the booking a refusal or the kill switch left on the
   * phone (`SendOutcome.left`) once the sheet tried to take it off, as the
   * phone's storage really answered: `gone`, or `kept` when it is still on
   * the phone (someone had changed it since, or the delete failed).
   */
  dropped?: 'gone' | 'kept'
}

/** What to do next, or how it ended. */
export type BookAction =
  | { do: 'keep' }
  | { do: 'send' }
  | { do: 'direct'; asMembership: boolean; stopKeeping: boolean }
  /** Take `left` off the phone (step 4 above), then refuse or go straight. */
  | { do: 'drop'; left: OutboxItem; paused: boolean }
  /** Discarded with it kept on the phone: take it off, and send nothing
   * (step 5 above). */
  | { do: 'unkeep' }
  | { done: 'sent'; id: string }
  | { done: 'kept' }
  | { done: 'refused'; error: unknown }
  | { done: 'discarded' }

/**
 * The next step of a press of Book, from what is known so far (above): the
 * one place each of §3.2's rows is decided.
 */
export function bookOutcome(facts: BookFacts): BookAction {
  if (facts.direct) {
    const { answer, asMembership } = facts.direct
    if ('ok' in answer) return { done: 'sent', id: String(answer.ok) }
    // Phones' sends are paused on the server; a booking made with signal is
    // booked as online always booked it, without saying whose it is: while
    // the sheet is open. Discarded, nothing was made, and nothing goes.
    if (
      asMembership &&
      codeOf(answer.error) === 'OUTBOX_PAUSED' &&
      facts.closed === undefined
    ) {
      return { do: 'direct', asMembership: false, stopKeeping: false }
    }
    return { done: 'refused', error: answer.error }
  }
  if (!facts.canKeep) {
    // Straight, as online always booked it. A draft that went straight as
    // the person's own stays theirs on every press after: refused for being
    // booked while PestM8 works in someone else's account (NOT_OWN_ACCOUNT),
    // a retry is refused again, never booked in that account.
    return {
      do: 'direct',
      asMembership: facts.asOwn === true,
      stopKeeping: false,
    }
  }
  if (facts.keep === undefined) return { do: 'keep' }
  if (facts.keep !== 'kept') {
    // Not kept in time: given up on, whatever of it the phone keeps late
    // comes off again (`settle`), and nothing of it is the phone's to send.
    // Discarded while it was being kept, nothing goes straight either.
    if (facts.closed === 'discarded') return { done: 'discarded' }
    // Otherwise straight to the server, as the person's own, and this draft
    // keeps nothing more, so a retry never makes a second row under the
    // same request id.
    return { do: 'direct', asMembership: true, stopKeeping: true }
  }
  // Kept, and discarded before the sheet could say so: nothing of it goes,
  // and it comes off the phone again.
  if (facts.closed === 'discarded' && facts.sent === undefined) {
    return facts.unkept ? { done: 'discarded' } : { do: 'unkeep' }
  }
  if (facts.lineLive !== true) return { done: 'kept' }
  if (facts.sent === undefined) return { do: 'send' }
  return afterSend(facts.sent, facts)
}

/** What the sheet does once the sender has answered for the booking. */
function afterSend(sent: SendOutcome, facts: BookFacts): BookAction {
  switch (sent.outcome) {
    case 'sent':
      return { done: 'sent', id: sent.id }
    case 'kept':
      return { done: 'kept' }
    case 'refused':
    case 'paused': {
      const paused = sent.outcome === 'paused'
      if (sent.left !== undefined && facts.dropped === undefined) {
        // Closed with it kept, the sheet said so as it went: it stays as
        // the answer left it, needing a look or held, never deleted (F1).
        if (facts.closed === 'kept') return { done: 'kept' }
        return { do: 'drop', left: sent.left, paused }
      }
      // Still on the phone after the sheet tried to take it off: never
      // FormAlert, nor a straight call, over a booking the phone holds. The
      // sheet open, it closes with it kept, as the phone has it; discarded
      // meanwhile, it comes off again.
      if (facts.dropped === 'kept') {
        if (facts.closed !== 'discarded') return { done: 'kept' }
        return facts.unkept ? { done: 'discarded' } : { do: 'unkeep' }
      }
      // Nothing of it on the phone. The kill switch's: sent straight with
      // the same id, while the sheet is open.
      if (paused && facts.closed === undefined) {
        return { do: 'direct', asMembership: false, stopKeeping: false }
      }
      return { done: 'refused', error: sent.error }
    }
  }
}

/**
 * The booking of a press that nothing is to send any more, taken off the
 * phone (`settle`): a keep that landed after New Job went straight, or the
 * booking of a sheet discarded before it said the booking was kept. Gone,
 * whatever an answer made of it (waiting to go again, held, needing a look,
 * or locked after an answer heard across a reconnect, which nothing will
 * send now), unless its job was made: a job made is on the server, in the
 * list, as a straight call already out could always make it.
 */
export function takeOffChange(): (item: OutboxItem) => Change {
  return (item) => (item.state === 'sent' ? 'abort' : 'delete')
}

/** Why a booking left on the phone by mistake needs a look
 * (`leftOnPhoneChange`, `outboxProblemCopy`). */
export const LEFT_ON_PHONE = 'LEFT_ON_PHONE'

/**
 * A booking the phone's storage failed to take off (`takeOffChange`): left
 * on the phone, needing a look, so it shows and never goes by itself. Not
 * one that went, or may have.
 */
export function leftOnPhoneChange(now: number): (item: OutboxItem) => Change {
  return (item) =>
    item.state === 'waiting' || item.state === 'needsLook'
      ? {
          ...item,
          state: 'needsLook',
          problem: { code: LEFT_ON_PHONE },
          holdUntil: null,
          retryAt: null,
          updatedAt: now,
        }
      : 'abort'
}

/**
 * The booking a refusal or the kill switch left on the phone
 * (`SendOutcome.left`), taken off it by the sheet still open on it: only as
 * that answer left it. Anyone's change since (an Edit, a Send) keeps it.
 */
export function leftDropChange(left: OutboxItem): (item: OutboxItem) => Change {
  return (item) =>
    item.state === left.state && item.updatedAt === left.updatedAt
      ? 'delete'
      : 'abort'
}

/** Whether a booking can be kept on this phone now (step 1 above). */
export function canKeepNow(at: {
  enabled: boolean
  locks: boolean
  readable: boolean
  /** `localNotesWork()`. */
  notes: boolean
  keepable: boolean
  lens: string | null
  userId: string | null
}): boolean {
  return (
    at.enabled &&
    at.locks &&
    at.readable &&
    at.notes &&
    at.keepable &&
    at.lens !== null &&
    at.userId !== null
  )
}

/** A draft's ids: new each time New Job opens (`useDraftRequestId`). */
export type BookingDraft = {
  /** The `clientRequestId` every send of this draft carries. */
  requestId: string
  /** The kept booking's key. */
  localId: string
  /** False once a keep of it was given up (it took too long, or the press
   * was discarded): this draft goes straight from then, as the person's own
   * (`BookFacts.asOwn`). */
  keepable: boolean
  stopKeeping: () => void
  /** New ids, for the next booking. */
  renew: () => void
}

/** Who is booking, and what the card will show: read as Book is pressed. */
export type BookingWho = {
  userId: string | null
  /** `lensOf(access)`: null while in someone else's account. */
  lens: string | null
  /** The person's own membership, sent as `asMembership`. */
  membershipId: Id<'memberships'>
  business: { slug: string; name: string }
  /** What the card of a booking kept shows: worked out only to keep one. */
  display: () => OutboxDisplay
}

export type BookResult =
  | { outcome: 'sent'; id: string }
  | { outcome: 'kept' }
  /** The sheet discarded first: nobody's to hear it (step 5 above). */
  | { outcome: 'discarded' }

/** What a press of Book needs of the page. */
export type BookingDeps = {
  /** `OUTBOX_ENABLED`. */
  enabled: boolean
  locks: Locks | null
  /** `outboxReadable()`. */
  readable: () => boolean
  /** `localNotesWork()`: asked at each press. */
  notes: () => boolean
  lineLive: () => boolean
  /** A straight call, through the Convex client. */
  call: (call: BookingCall) => Promise<unknown>
  /** `outbox.keep`: within STORE_OP_MS, `'error'` once that is up; and
   * `landed`, what it came to in the end, which may be later. */
  keep: (
    item: OutboxItem,
    landed: (result: KeepResult) => void,
  ) => Promise<KeepResult>
  /** `giveUpKeep`: a keep still on its way is refused, never written, and
   * until the sheet has taken one that had written off again, no tab shows
   * or sends it, and the next page load deletes it. */
  giveUp: (localId: string) => void
  /** `forgetGivenUp`: taken off, or left needing a look, where it shows. */
  forgetGivenUp: (localId: string) => void
  /** `outbox.changeLanded`: answered with what the change really came to,
   * however long that takes, never the store's `'error'` for taking too
   * long. For a booking taken off the phone (`takeOffChange`, then
   * `leftOnPhoneChange`), and the booking an answer left on it
   * (`leftDropChange`). */
  change: (
    op: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ) => Promise<StoreResult<OutboxItem | 'deleted'>>
  /** While the sheet is still deciding what became of a booking, a day's
   * list doesn't draw it (`OutboxModel.deciding`). */
  deciding: (localId: string, on: boolean) => void
  /** The sheet closed on the booking's job: the list draws the job, never
   * the booking (`OutboxModel.answeredOnScreen`). */
  answeredOnScreen: (localId: string) => void
  sender: Pick<Sender, 'sendHeld' | 'watchAnswer' | 'kick'>
}

/**
 * Where the booking of the press under way is: being kept, kept on the
 * phone (closing the sheet loses nothing), or going straight, nothing of it
 * on the phone; null with no press, after a refusal, or while the sheet
 * takes off the phone the booking a refusal left there.
 */
export type BookingPath = 'keeping' | 'kept' | 'direct' | null

/** What the sheet does as a press of Book goes. */
export type BookingSheet = {
  booked: () => void
  close: () => void
  /** Where the booking is now (`BookingPath`): told as it changes. The
   * screen says back what it then shows (`BookingSession.shown`). */
  path: (path: BookingPath) => void
}

/**
 * Whether the words above Book job say the booking is kept on the phone
 * (`BOOKING_KEPT`): while a press is under way, as that press goes, never
 * once it has gone straight; otherwise as a press now would (`canKeep`).
 */
export function saysKept(at: {
  pending: boolean
  path: BookingPath
  canKeep: boolean
}): boolean {
  return at.pending && at.path !== null ? at.path !== 'direct' : at.canKeep
}

/** A step that goes on with the booking as kept: sent by the sender, or the
 * sheet closed on it kept. */
function goesOnAsKept(next: BookAction): boolean {
  return 'do' in next ? next.do === 'send' : next.done === 'kept'
}

function answerOf(call: Promise<unknown>): Promise<Answer> {
  return call.then(
    (ok) => ({ ok }),
    (error: unknown) => ({ error }),
  )
}

function within<T>(ms: number, work: Promise<T>): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** The booking of a press is still to be kept, or is on the phone now. */
type Keeping = Promise<KeepResult> | 'kept'

/**
 * New Job's Book for one opening of the sheet (its mount): what each press
 * does (`book`), and what becomes of a booking when the sheet goes
 * (`dispose`) or is discarded (`discard`).
 */
export class BookingSession {
  private disposed = false
  /**
   * Whether the screen last showed the booking kept (`shown`), so that
   * closing the sheet asked nothing: what a close means is decided on this.
   */
  private shownKept = false
  /** "Discard your changes?" confirmed for the press under way. */
  private discarded = false
  /** `booked` has been said: once only. */
  private told = false
  /** The booking a press under way is deciding, while it is. */
  private decidingId: string | null = null
  /** Where the sheet was last told the booking is. */
  private path: BookingPath = null
  private readonly handles: Array<{ release: () => void }> = []
  /** A press waiting for the screen to show what it was told (`onScreen`). */
  private readonly waiting: Array<() => void> = []

  constructor(
    private readonly deps: BookingDeps,
    private readonly sheet: BookingSheet,
  ) {}

  /** The sheet is on screen (again, after React's dev double mount). */
  revive(): void {
    this.disposed = false
  }

  /**
   * What the screen shows now, told by the commit that draws it
   * (`useBooking`'s layout effect, the sheet's lock going in the same
   * commit, before a tap can land): whether the booking is shown kept, so
   * that closing the sheet asks nothing.
   */
  shown(kept: boolean): void {
    this.shownKept = kept
    this.wake()
  }

  /**
   * "Discard your changes?" confirmed (✕, Escape or Back), as it is: before
   * the sheet goes, which after a Back is only once the move has landed.
   * The press under way is discarded from now, whatever the screen shows
   * meanwhile (step 5 above): given up on (`giveUp`), so a keep of it still
   * on its way is refused, and nothing of it the phone holds is shown or
   * sent while the press takes it off. Nothing, once `booked` was said.
   */
  discard(): void {
    if (this.told || this.discarded) return
    this.discarded = true
    if (this.decidingId !== null) this.deps.giveUp(this.decidingId)
    this.wake()
  }

  /**
   * The sheet has gone: closed by the person or by an outcome, or the page
   * left. Closed as the screen showed the booking kept, with nothing asked,
   * it is the person's booking made (D3), said once, and drawn in its day's
   * list from now, as the sheet goes; whatever is still to come of it
   * changes nothing on screen, and a refusal of it from now on makes it
   * need a look rather than go (F1).
   *
   * Otherwise it was discarded ("Discard your changes?"), and so was the
   * booking of a press still under way (`discard`).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.handles.splice(0)) handle.release()
    if (this.told || (this.shownKept && !this.discarded)) {
      this.tellBooked()
      if (this.decidingId !== null) this.deps.deciding(this.decidingId, false)
    } else {
      this.discard()
    }
    this.wake()
  }

  /**
   * One press of Book. Resolves with how it ended; a refusal that made
   * nothing throws, for the sheet's FormAlert, and the draft keeps its ids.
   */
  async book(
    args: SendableBooking,
    draft: BookingDraft,
    who: BookingWho,
  ): Promise<BookResult> {
    const deps = this.deps
    const localId = draft.localId
    // A press after a refusal: the booking it refused is gone from the
    // phone, and its answer is in. After a Discard the sheet didn't close
    // on (a Back whose move never landed), a new press of its own.
    for (const handle of this.handles.splice(0)) handle.release()
    this.discarded = false
    const facts: BookFacts = {
      canKeep: canKeepNow({
        enabled: deps.enabled,
        locks: deps.locks !== null,
        readable: deps.readable(),
        notes: deps.notes(),
        keepable: draft.keepable,
        lens: who.lens,
        userId: who.userId,
      }),
      asOwn: !draft.keepable,
    }
    this.setPath(facts.canKeep ? 'keeping' : 'direct')
    let lock: HeldLock | null = null
    // Whether this press has the saying of when the day's list may draw its
    // booking again (`deciding`): from its keep until it hands that on to
    // `settle`. A press that kept nothing leaves it to the one that did.
    let deciding = false
    try {
      for (;;) {
        const closed = this.closed()
        if (closed) facts.closed = closed
        else delete facts.closed
        const next = bookOutcome(facts)
        // On as kept (sent, or the sheet closed on it) only once the screen
        // shows it kept: until then closing the sheet asks first, and a
        // Discard then means it.
        if (
          goesOnAsKept(next) &&
          facts.closed === undefined &&
          !this.shownKept
        ) {
          await this.onScreen(true)
          continue
        }
        if ('done' in next) {
          if (next.done === 'discarded') {
            // This draft keeps nothing more: what the press left on the
            // phone may still be coming off it, given up and under its lock
            // (`settle`), and a press of the draft again on a sheet that
            // didn't close goes straight, never kept again under that key.
            draft.stopKeeping()
            return { outcome: 'discarded' }
          }
          if (next.done === 'refused') {
            // Nothing was made, and nothing of it is the person's booking.
            this.setPath(null)
            throw next.error
          }
          // Closed on its job with signal: the day's list draws the job as
          // it always did, never the booking, whichever the phone's storage
          // or the list has first.
          if (next.done === 'sent' && !this.disposed) {
            deps.answeredOnScreen(localId)
          }
          return this.finish(
            next.done === 'sent'
              ? { outcome: 'sent', id: next.id }
              : { outcome: 'kept' },
            draft,
          )
        }
        if (next.do === 'keep') {
          this.decidingId = localId
          deps.deciding(localId, true)
          deciding = true
          const pressedAt = Date.now()
          const keep = await this.keep(args, draft, who)
          lock = keep.lock
          facts.keep = keep.result
          if (keep.result === 'kept') {
            facts.lineLive = deps.lineLive()
            continue
          }
          // Not kept in time, or not at all: from now nothing of this press
          // is the phone's to keep or send, whatever the keep comes to. A
          // keep still on its way is refused; one that had written lands,
          // and comes off again, under the lock, held till then.
          deps.giveUp(localId)
          this.settle(localId, keep.landing, lock, {
            late: keep.result === 'late' ? pressedAt : null,
          })
          lock = null
          deciding = false
          continue
        }
        if (next.do === 'unkeep') {
          // Discarded with it on the phone: taken off, under the lock while
          // this press still holds it, nothing having sent it.
          facts.unkept = true
          this.settle(localId, 'kept', lock, { late: null })
          lock = null
          deciding = false
          continue
        }
        if (next.do === 'drop') {
          // The sheet's to take off the phone, once closing it asks first,
          // and says nothing was booked: until the screen shows that, a
          // close is a close as kept, and the booking stays as the answer
          // left it (F1).
          this.setPath(next.paused ? 'direct' : null)
          await this.onScreen(false)
          if (this.told) continue
          // Decided on what the phone's storage really did, however long it
          // takes to say ("Booking…" till then): a delete it didn't answer
          // in time may land yet, or may never have happened.
          const dropped = await deps.change(
            'answered-drop',
            localId,
            leftDropChange(next.left),
          )
          if (dropped === 'deleted' || dropped === 'gone') {
            facts.dropped = 'gone'
            deps.forgetGivenUp(localId)
          } else {
            // Still on the phone, needing a look or held: the delete failed,
            // or someone changed it first. Never FormAlert, nor a straight
            // call, over a booking the phone holds.
            facts.dropped = 'kept'
            logConnection('outbox-drop-kept', {
              result: typeof dropped === 'object' ? 'changed' : dropped,
            })
            this.setPath('kept')
          }
          continue
        }
        if (next.do === 'send') {
          // The lock goes with the send it covers (`sendHeld` lets it go
          // once the call has settled), never with the sheet.
          const held = lock
          lock = null
          facts.sent = held
            ? await deps.sender.sendHeld(localId, held)
            : { outcome: 'kept' }
          continue
        }
        if (next.stopKeeping) draft.stopKeeping()
        // Nothing of this press is the phone's now: a keep that took too
        // long, or one the server's kill switch sent straight (the sheet
        // took it off the phone). Closing the sheet would lose it, so it
        // asks again.
        this.setPath('direct')
        const call = bookingCall(args, {
          clientRequestId: draft.requestId,
          ...(next.asMembership && { asMembership: who.membershipId }),
        })
        facts.direct = {
          answer: await answerOf(Promise.resolve().then(() => deps.call(call))),
          asMembership: next.asMembership,
        }
      }
    } finally {
      if (lock) {
        lock.release()
        deps.sender.kick()
      }
      if (this.decidingId === localId) this.decidingId = null
      if (deciding) deps.deciding(localId, false)
    }
  }

  /**
   * Whether the sheet has gone or been discarded, and how (`BookFacts`): it
   * either said the booking was kept as it went, or was discarded before it
   * could be.
   */
  private closed(): BookFacts['closed'] {
    if (!this.disposed && !this.discarded) return undefined
    return this.told ? 'kept' : 'discarded'
  }

  /** Tells the sheet where the booking is, while it is on screen and its
   * press isn't discarded: a sheet going after a Back never says kept. */
  private setPath(path: BookingPath): void {
    if (this.disposed || this.discarded || path === this.path) return
    this.path = path
    this.sheet.path(path)
  }

  /** The booking kept on the phone, under its lock, taken first. */
  private async keep(
    args: SendableBooking,
    draft: BookingDraft,
    who: BookingWho,
  ): Promise<{
    result: KeepResult | 'late'
    lock: HeldLock | null
    /** What the keep came to in the end; null when none was asked. */
    landing: Promise<KeepResult> | null
  }> {
    const deps = this.deps
    const lock =
      deps.locks && who.userId !== null
        ? await takeLock(deps.locks, itemLock(draft.localId), {
            ifAvailable: true,
          })
        : null
    if (!lock || who.userId === null) {
      return { result: 'refused', lock, landing: null }
    }
    const started = Date.now()
    let item: OutboxItem
    try {
      item = itemFromBooking(args, {
        localId: draft.localId,
        requestId: draft.requestId,
        userId: who.userId,
        business: who.business,
        membershipId: who.membershipId,
        display: who.display(),
        now: started,
      })
    } catch {
      // What its card would show couldn't be worked out: never a reason
      // not to book it. It goes straight.
      logConnection('outbox-keep', { ms: 0, result: 'error' })
      return { result: 'error', lock, landing: null }
    }
    // What the keep came to in the end: `keep`'s own answer, unless that is
    // the store's `'error'` for taking too long, which may yet land.
    let landedWith: (result: KeepResult) => void = () => {}
    const landing = new Promise<KeepResult>((resolve) => {
      landedWith = resolve
    })
    const keeping = deps
      .keep(item, (result) => landedWith(result))
      .then(
        (result) => {
          if (result !== 'error') landedWith(result)
          return result
        },
        () => {
          landedWith('error')
          return 'error' as const
        },
      )
    const result = await within(KEEP_WAIT_MS, keeping)
    logConnection('outbox-keep', { ms: Date.now() - started, result })
    if (result === 'kept') {
      this.hold(draft.localId)
      this.setPath('kept')
    }
    return { result, lock, landing }
  }

  /**
   * Until the screen shows the booking as `kept` says (`shown`), or the
   * press has been discarded, or the sheet has gone: one commit, as a rule.
   */
  private async onScreen(kept: boolean): Promise<void> {
    while (!this.disposed && !this.discarded && this.shownKept !== kept) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve()
  }

  /**
   * Takes off the phone the booking of a press that nothing is to send any
   * more (steps 2 and 5 above), once the keep has said what it came to
   * (`keeping`, its real answer however late, never the store's for taking
   * too long), or now if it is on the phone (`'kept'`). Under the booking's
   * lock, while the press holds it, which goes only once nothing of it is
   * left for the phone to send by itself, however long that takes: no tab
   * can send it meanwhile. Given up on already (`giveUp`), it is shown and
   * sent by no tab meanwhile either, and a day's list leaves it out
   * (`deciding`) until it is off. `late`: when the press began a keep that
   * was still out at KEEP_WAIT_MS, for the note of when it landed.
   */
  private settle(
    localId: string,
    keeping: Keeping | null,
    lock: HeldLock | null,
    at: { late: number | null },
  ): void {
    const deps = this.deps
    void (async () => {
      const landed =
        keeping === null || keeping === 'kept' ? keeping : await keeping
      if (at.late !== null) {
        logConnection('outbox-keep', {
          ms: Date.now() - at.late,
          result: 'late',
          landed: landed ?? 'none',
        })
      }
      if (landed === 'kept') return this.takeOff(localId)
      deps.forgetGivenUp(localId)
      return true
    })()
      .catch(() => false)
      .then((settled) => {
        // Still on the phone as it was, neither off nor needing a look: held
        // for the rest of the page's life, as a keep that never lands is.
        if (!settled) return
        lock?.release()
        deps.deciding(localId, false)
        deps.sender.kick()
      })
  }

  /**
   * A booking nothing is to send, taken off the phone (`takeOffChange`),
   * decided on what the phone's storage really did: deleted, or gone
   * already, it is forgotten as given up. A delete that failed leaves it on
   * the phone, so it is marked as needing a look (`leftOnPhoneChange`): shown
   * once that has landed, and never sent by itself. Whether nothing of it is
   * left for the phone to send by itself now: not if even that failed, when
   * it stays given up, shown and sent by nothing, and deleted by the next
   * page load, and its lock is never let go (`settle`).
   */
  private async takeOff(localId: string): Promise<boolean> {
    const deps = this.deps
    const off = await deps.change('taken-off', localId, takeOffChange())
    logConnection('outbox-taken-off', {
      result: typeof off === 'object' ? 'changed' : off,
    })
    if (off === 'deleted' || off === 'gone') {
      deps.forgetGivenUp(localId)
      return true
    }
    // Refused: its job was made, and the next page load clears it as sent.
    if (off !== 'error') return true
    const looked = await deps.change(
      'left-on-phone',
      localId,
      leftOnPhoneChange(Date.now()),
    )
    logConnection('outbox-left-on-phone', {
      result: typeof looked === 'object' ? 'needsLook' : looked,
    })
    if (typeof looked === 'object' || looked === 'gone') {
      deps.forgetGivenUp(localId)
    }
    return looked !== 'error'
  }

  /** The sheet's handle on a booking's answer (`watchAnswer`), while open. */
  private hold(localId: string): void {
    if (this.disposed) return
    this.handles.push(this.deps.sender.watchAnswer(localId))
  }

  /** How it ended, on screen: only while the sheet is, undiscarded (S10). */
  private finish(result: BookResult, draft: BookingDraft): BookResult {
    // Keeping switched off, it is as it always was: the sheet's outcome
    // runs whenever the job comes back.
    if ((this.disposed || this.discarded) && this.deps.enabled) return result
    this.tellBooked()
    this.sheet.close()
    draft.renew()
    return result
  }

  private tellBooked(): void {
    if (this.told) return
    this.told = true
    this.sheet.booked()
  }
}
