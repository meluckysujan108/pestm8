import { ANSWER_WAIT_MS, PEEK_TIMEOUT_MS } from './outboxSet'
import { goesOnlyAfterALook, jobsWord, onPhoneWords } from './outboxRules'
import type { LeaveGuard, LeaveReason } from '#/lib/offline/leaveGuard'
import type { OutboxItem } from './outboxItem'
import type { OutboxPeek } from './outboxStore'

/**
 * What leaving asks about the bookings on this phone, not sent yet (plan part
 * 2c §11.1–§11.2): the question `OutboxLeaveGuard` puts to the person before
 * a sign-out discards them, or a switch of business leaves them behind, and
 * whether to ask at all. Pure but for the waits, so each rule is tested here.
 *
 * - **Nothing could have been kept** (no IndexedDB or no Web Locks): go.
 * - **A switch** keeps them whatever they are, so it waits for nothing: it
 *   counts what this tab has read of the business being left, and goes if
 *   it hasn't read them.
 * - **A sign-out** holds every send from the phone (switchGate.ts
 *   `holdSends`) while it counts; a send already out, in any tab, is waited
 *   for, up to ANSWER_WAIT_MS (S22e), so a booking that has just gone isn't
 *   counted as discarded. Then it counts from a fresh read of the phone,
 *   never what an earlier read left (F4), given up to PEEK_TIMEOUT_MS: not
 *   read by then, it asks the generic question ("Jobs not sent yet may be
 *   on this phone."), never a plain yes (S2). While the question is up it
 *   holds this tab's sends alone (`holdSendsHere`): it is up for as long as
 *   the person leaves it, and no tab may hold every other's for that long
 *   (D6, S12). Answered yes, it holds every tab's again, as before it
 *   counted, counts again from a fresh read, and asks again if anything
 *   counted has started going or gone, or more have come.
 * - **A phone that never kept a booking**, in a build with keeping switched
 *   off (every phone until it is switched on), holds nothing and reads
 *   nothing new: it counts what this tab has read, and goes if it hasn't. A
 *   phone that has (`keptBefore`) is asked as above whatever the build, as
 *   switching keeping off leaves what it holds shown and sent (D14).
 * - **None of the person's** (not counting one a sign-out already discarded,
 *   or one sent): go. Otherwise ask: a sign-out counts them in every
 *   business, a switch the business being left.
 */

/** What the guard reads. The page's own (`OutboxLeaveGuard`), or a test's. */
export type LeaveFacts = {
  /** Whether this browser could have kept anything: IndexedDB and Web
   * Locks, which nothing is kept without. */
  storage: boolean
  /** Keeping is switched on (`OUTBOX_ENABLED`). */
  enabled: boolean
  /** Whether this phone has ever kept a booking (outboxStore.ts
   * `keptBefore`). */
  keptBefore: () => boolean
  /** Whether this tab has read the phone's bookings (`OutboxModel`). */
  readable: () => boolean
  /** Reads them afresh, and says whether a read was taken
   * (`OutboxModel.refreshed`): false where the storage didn't answer. */
  readFresh: () => Promise<boolean>
  /** Told whenever what is handed out here may have changed. */
  subscribe: (listener: () => void) => () => void
  /** Every booking still on the phone (`OutboxModel.all`, so none a
   * sign-out has discarded). */
  items: () => ReadonlyArray<OutboxItem>
  /** How many of the outbox's calls this tab has out (`Sender.inflight`). */
  inflight: () => number
  /** Holds every send from the phone until the function it resolves to is
   * called, having waited up to `waitMs` for one already out in any tab
   * (switchGate.ts `holdSends`). */
  holdSends: (waitMs: number) => Promise<() => void>
  /** Holds this tab's sends alone until the function it returns is called
   * (switchGate.ts `holdSendsHere`). */
  holdHere: () => () => void
  /** Who is signed in, or null when this page doesn't know. */
  userId: () => string | null
  /** The business on screen, or null where there is none (the no-business,
   * set-up, two-step, join and start screens). */
  businessId: () => string | null
  /** The time, for whether one has waited too long to go by itself
   * (`switchQuestion`). `Date.now` where not given. */
  now?: () => number
}

/** What `ConfirmDialog` asks, in its words. */
export type LeaveQuestion = {
  title: string
  body: string
  /** The red button's: going. */
  confirm: string
  /** The way out: staying. */
  cancel: string
}

/** How often a wait looks again, besides whenever it is told. */
const LOOK_EVERY_MS = 100

/** How long a sign-out waits for a send that is out: as long as New Job
 * waits for an answer. */
export const LEAVE_SEND_WAIT_MS = ANSWER_WAIT_MS

/** How long it waits for the phone's bookings to be read. */
export const LEAVE_READ_WAIT_MS = PEEK_TIMEOUT_MS

/** Asked when the phone's bookings can't be read in time (S2, F4). */
export const UNREADABLE_QUESTION: LeaveQuestion = {
  title: 'Sign out? Jobs not sent yet may be on this phone.',
  body: 'PestM8 can’t read this phone’s storage just now. Signing out discards any jobs on it not sent yet.',
  confirm: 'Discard and sign out',
  cancel: 'Stay signed in',
}

/**
 * The bookings a sign-out discards, as the person would count them: theirs
 * (everyone's where the page doesn't know who is signed in, as the wipe
 * takes everything), not sent. Those a sign-out already discarded are not
 * on the phone as `OutboxModel.all` hands them out.
 */
export function notSentOnPhone(
  items: ReadonlyArray<OutboxItem>,
  userId: string | null,
): Array<OutboxItem> {
  return items.filter(
    (item) =>
      item.state !== 'sent' && (userId === null || item.userId === userId),
  )
}

/** A business's bookings not sent yet: those that go by themselves
 * (waiting, or being sent), and those that need a look first. */
export type UnsentHere = { count: number; needsLook: number }

/**
 * The person's bookings not sent yet (`notSentOnPhone`), by business id,
 * those that go by themselves apart from those that need a look first,
 * which go only once someone has looked (SwitchBanner, the business
 * switcher): one still waiting that has waited too long among them, as of
 * `now` (`goesOnlyAfterALook`).
 */
export function unsentByBusiness(
  items: ReadonlyArray<OutboxItem>,
  userId: string,
  now: number,
): ReadonlyMap<string, UnsentHere> {
  const by = new Map<string, UnsentHere>()
  for (const item of notSentOnPhone(items, userId)) {
    const was = by.get(item.businessId) ?? { count: 0, needsLook: 0 }
    by.set(
      item.businessId,
      goesOnlyAfterALook(item, now)
        ? { ...was, needsLook: was.needsLook + 1 }
        : { ...was, count: was.count + 1 },
    )
  }
  return by
}

/** Resolves true once `ready()` says so, or false once `ms` has passed. */
function waitUntil(
  ready: () => boolean,
  ms: number,
  subscribe: LeaveFacts['subscribe'],
): Promise<boolean> {
  if (ready()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    const finish = (answer: boolean) => {
      if (done) return
      done = true
      clearInterval(looking)
      clearTimeout(giveUp)
      stop()
      resolve(answer)
    }
    const look = () => {
      if (ready()) finish(true)
    }
    const stop = subscribe(look)
    const looking = setInterval(look, LOOK_EVERY_MS)
    const giveUp = setTimeout(() => finish(ready()), ms)
  })
}

/** `read`'s answer, or false once `ms` has passed without one. */
function readWithin(read: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    read.catch(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Whether this phone may hold bookings: keeping is on, or it has kept. */
function mayHold(facts: LeaveFacts): boolean {
  return facts.enabled || facts.keptBefore()
}

/** The sign-out's question from what is in memory now, with no waits. */
function signOutQuestionNow(facts: LeaveFacts): LeaveQuestion | null {
  return signOutQuestion(
    notSentOnPhone(facts.items(), facts.userId()),
    facts.businessId(),
  )
}

/**
 * The question to ask before leaving for `reason`, or null to go.
 * `sendWaitMs`: how long a sign-out may still wait for a send of this tab's
 * that is out (the guard has spent some of it holding sends already).
 */
export async function leaveQuestion(
  reason: LeaveReason,
  facts: LeaveFacts,
  { sendWaitMs = LEAVE_SEND_WAIT_MS }: { sendWaitMs?: number } = {},
): Promise<LeaveQuestion | null> {
  if (!facts.storage) return null
  if (reason === 'switchBusiness') {
    if (!facts.readable()) return null
    const here = facts.businessId()
    return switchQuestion(
      notSentOnPhone(facts.items(), facts.userId()).filter(
        (item) => item.businessId === here,
      ),
      facts.now ? facts.now() : Date.now(),
    )
  }
  if (mayHold(facts)) {
    if (!(await readWithin(facts.readFresh(), LEAVE_READ_WAIT_MS))) {
      return UNREADABLE_QUESTION
    }
  } else if (!facts.readable()) return null
  if (facts.inflight() > 0 && sendWaitMs > 0) {
    await waitUntil(() => facts.inflight() === 0, sendWaitMs, facts.subscribe)
  }
  return signOutQuestionNow(facts)
}

// The question the last leave answered yes to went with (`confirmedLeave`).
let confirmed: LeaveQuestion | null = null

/**
 * The question the person last answered yes to, before a leave that went,
 * or null where none was asked; forgotten once read. A sign-out says from
 * it what it discarded, should its request then fail (D27): after the
 * generic question, it can't say how many (`signOutFailedWords`).
 */
export function confirmedLeave(): LeaveQuestion | null {
  const question = confirmed
  confirmed = null
  return question
}

/**
 * The guard `OutboxLeaveGuard` registers: asks `show` the question, if there
 * is one, and goes with its answer (true to go); with none, goes. A second
 * ask while one is out is answered stay: nothing is thrown away on a
 * question nobody saw.
 *
 * A sign-out holds every tab's sends (`holdSends`) while it counts, only
 * this tab's (`holdHere`) while the question is up, and every tab's again
 * from a yes until a little past it, so the sign-out has discarded them
 * before any could start. Answered yes, it counts again from a fresh read
 * (what this tab has heard may be behind another tab's): a booking another
 * tab began sending while it was up, one sent meanwhile, or one booked
 * meanwhile, is asked about again in the new words, never discarded under
 * the old ones.
 */
export function leaveGuardFor(
  facts: LeaveFacts,
  show: (question: LeaveQuestion) => Promise<boolean>,
): LeaveGuard {
  let asking = false
  return async (reason) => {
    if (asking) return false
    asking = true
    confirmed = null
    const holds = reason === 'signOut' && facts.storage && mayHold(facts)
    // Every tab's sends held, and this tab's alone.
    let everyTab: (() => void) | null = null
    let here: (() => void) | null = null
    let went = false
    try {
      const started = Date.now()
      if (holds) everyTab = await facts.holdSends(LEAVE_SEND_WAIT_MS)
      let question = await leaveQuestion(reason, facts, {
        sendWaitMs: Math.max(0, LEAVE_SEND_WAIT_MS - (Date.now() - started)),
      })
      while (question !== null) {
        if (everyTab !== null) {
          here = facts.holdHere()
          everyTab()
          everyTab = null
        }
        if (!(await show(question))) return false
        if (holds) everyTab = await facts.holdSends(LEAVE_SEND_WAIT_MS)
        if (here !== null) {
          here()
          here = null
        }
        if (reason !== 'signOut' || question === UNREADABLE_QUESTION) break
        // Not read in time: counted from what this tab has.
        if (holds) await readWithin(facts.readFresh(), LEAVE_READ_WAIT_MS)
        const now = signOutQuestionNow(facts)
        if (
          now === null ||
          (now.title === question.title && now.body === question.body)
        ) {
          question = now === null ? null : question
          break
        }
        question = now
      }
      confirmed = question
      went = true
      return true
    } finally {
      asking = false
      here?.()
      // Past a yes, until the sign-out has discarded them, which it does
      // in the same turn as it hears it (lib/useSignOut.ts).
      const release = everyTab
      if (release !== null) {
        if (went) setTimeout(release, 0)
        else release()
      }
    }
  }
}

/** The business a booking is for, as it was called when it was booked. */
function nameOf(item: OutboxItem, otherwise: string): string {
  return typeof item.businessName === 'string' && item.businessName.trim()
    ? item.businessName.trim()
    : otherwise
}

/**
 * "Sign out and discard 2 jobs not sent yet?" / "They’re only on this
 * phone.", with whose business they are when any are another's than the one
 * on screen ("1 is for Pestfolio."), and how many may already have gone,
 * being sent with no answer yet. Null with none.
 */
export function signOutQuestion(
  items: ReadonlyArray<OutboxItem>,
  businessId: string | null,
): LeaveQuestion | null {
  const n = items.length
  if (n === 0) return null
  const one = n === 1
  const others = new Map<string, Array<OutboxItem>>()
  for (const item of items) {
    if (item.businessId === businessId) continue
    others.set(item.businessId, [...(others.get(item.businessId) ?? []), item])
  }
  let elsewhere = ''
  const k = [...others.values()].reduce((sum, list) => sum + list.length, 0)
  if (others.size === 1) {
    const [list] = [...others.values()]
    const name = nameOf(list[0], 'another business')
    elsewhere =
      k === n
        ? ` ${one ? 'It’s' : 'They’re'} for ${name}.`
        : ` ${k} ${k === 1 ? 'is' : 'are'} for ${name}.`
  } else if (others.size > 1) {
    elsewhere =
      k === n
        ? ` They’re for ${others.size} businesses.`
        : ` ${k} are for other businesses.`
  }
  const locked = items.filter((item) => item.state === 'sending').length
  const check = 'check the schedule when you’re back.'
  const gone =
    locked === 0
      ? ''
      : locked === n
        ? ` ${one ? 'It' : 'They'} may already have gone — ${check}`
        : ` ${locked} may already have gone — ${check}`
  return {
    title: `Sign out and discard ${jobsWord(n)} not sent yet?`,
    body: `${one ? 'It’s' : 'They’re'} only on this phone.${elsewhere}${gone}`,
    confirm: 'Discard and sign out',
    cancel: 'Stay signed in',
  }
}

/**
 * "Switch with 2 jobs not sent yet?" / "They stay on this phone and go when
 * you’re back in Pest M8 Pest Control with signal." (plan X7: kept, and held
 * until then). One that needs a look goes only once someone has looked, so
 * it is said apart: "They stay on this phone. 1 goes when you’re back in …
 * with signal, and 1 needs a look before it goes." So is one still waiting
 * that has waited too long, as of `now` (`goesOnlyAfterALook`): it needs a
 * look once back. Null with none.
 */
export function switchQuestion(
  items: ReadonlyArray<OutboxItem>,
  now: number,
): LeaveQuestion | null {
  const n = items.length
  if (n === 0) return null
  const name = nameOf(items[0], 'this business')
  const look = items.filter((item) => goesOnlyAfterALook(item, now)).length
  const goes = n - look
  const back = `when you’re back in ${name} with signal`
  const body =
    look === 0
      ? n === 1
        ? `It stays on this phone and goes ${back}.`
        : `They stay on this phone and go ${back}.`
      : goes === 0
        ? n === 1
          ? `It stays on this phone, and needs a look in ${name} before it goes.`
          : `They stay on this phone, and need a look in ${name} before they go.`
        : `They stay on this phone. ${goes} ${goes === 1 ? 'goes' : 'go'} ${back}, and ${look} ${look === 1 ? 'needs a look before it goes' : 'need a look before they go'}.`
  return {
    title: `Switch with ${jobsWord(n)} not sent yet?`,
    body,
    confirm: 'Switch',
    cancel: `Stay in ${name}`,
  }
}

/**
 * The sign-in screens' line (plan §11.4, S13, D26), from the phone's read
 * (`useOnPhoneLine`'s, which leaves out what a sign-out discarded), less
 * what was sent: whose bookings not sent yet are on this phone, by the
 * first name the owner row keeps, and that signing in as anyone else
 * discards them. Null with none.
 */
export function onPhoneLine(peek: OutboxPeek): string | null {
  const owner = peek.owner
  const theirs = peek.items.filter(
    (item) =>
      item.state !== 'sent' && (owner === null || item.userId === owner.userId),
  )
  if (theirs.length === 0) return null
  return onPhoneWords(owner?.firstName ?? '', theirs.length)
}

/**
 * A sign-out's "Could not sign out." when the request failed after the
 * confirm had discarded bookings (plan D27): the discard stands, and it
 * says so. `'unknown'`: the generic question was confirmed (the phone's
 * bookings couldn't be read), so it can't say how many.
 *
 * `sending`: those being sent as it went, which the question said may
 * already have gone. Never called discarded: the phone's copy went, but
 * their call is still out from a page that is still signed in, so they may
 * still be booked, and booked again they would be booked twice. "1 being
 * sent may still be booked — check the schedule before booking it again."
 */
export function signOutFailedWords(
  discarded: number | 'unknown',
  sending = 0,
): string {
  const failed = 'Could not sign out. Check your signal and try again.'
  const gone =
    discarded === 'unknown'
      ? ' Any jobs not sent yet on this phone were discarded.'
      : discarded <= 0
        ? ''
        : discarded === 1
          ? ' The job not sent yet was discarded.'
          : ` The ${discarded} jobs not sent yet were discarded.`
  if (sending <= 0) return `${failed}${gone}`
  const one = sending === 1
  const which =
    gone === ''
      ? one
        ? 'The job being sent'
        : `The ${sending} jobs being sent`
      : `${sending} being sent`
  return `${failed}${gone} ${which} may still be booked — check the schedule before booking ${one ? 'it' : 'them'} again.`
}
