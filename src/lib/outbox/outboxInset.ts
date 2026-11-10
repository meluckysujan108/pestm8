import { formatJobDate, formatTime } from '#/lib/format'
import { dayKeyOf } from '../../../convex/lib/dates'
import { LEFT_ON_PHONE } from './book'
import {
  MAY_HAVE_GONE_AFTER_MS,
  MAY_HAVE_GONE_FINDS,
  PAUSED_HOLD_MS,
  isReadable,
} from './outboxSet'
import type { OutboxItem } from './outboxItem'
import type { HeldReason } from './sender'

/**
 * What a booking's sheet says of it, under who to call, in the kept copy's
 * line's place (plan part 2c §9.5): where it is, and why it hasn't gone, in
 * the words the person needs to know whether to book it again (never). One
 * that needs a look says why in a `FormAlert` instead (`outboxProblemCopy`).
 */

export type InsetFacts = {
  item: OutboxItem
  /** The line is live (`keeper.lineLive`). */
  lineLive: boolean
  /** Why it can't go now, if it can't (`Sender.heldReason`). */
  held: HeldReason | null
  /** This tab has its call out (`Sender.sendingHere`). */
  sendingHere: boolean
  /** Another tab or window had its lock (`Sender.sendingElsewhere`). */
  sendingElsewhere: boolean
  /** The phone's storage didn't answer the last send's mark. */
  storageTrouble: boolean
  timezone: string
  todayKey: string
  /** An Edit of it is open in this tab (`OutboxModel.editingHere`). */
  editingHere?: boolean
  /** The client of the booking it waits on (2c-I): `held` is `parent`. */
  parentClient?: string | null
  /** When this looked, and this tab (`OutboxModel.tab`): for an Edit open
   * in another tab. */
  now?: number
  tab?: string
}

/** Saved by a build newer than this one, which can't read it (G7). */
export const NEWER_BUILD_WORDS =
  'Saved by a newer PestM8. It goes once this phone has the newer PestM8.'

/** The same, sent with no answer heard: why Discard can't be pressed. */
export const NEWER_BUILD_SENT_WORDS =
  'Saved by a newer PestM8 and sent, so it may already be booked. Don’t book it again: it can be changed once this phone has the newer PestM8.'

/** An Edit of it is open in another tab or window. */
export const EDITED_ELSEWHERE_WORDS =
  'Not sent yet — it’s being changed in another PestM8 tab or window.'

/** A hold this long can only be the server's pause (PAUSED_HOLD_MS): every
 * other hold is five minutes at most. */
const PAUSE_LIKE_MS = PAUSED_HOLD_MS - 5 * 60_000

/** "9:42am", or "Mon 20 Oct at 9:42am" on another day. */
function when(at: number, timezone: string, todayKey: string): string {
  const day = dayKeyOf(at, timezone)
  const time = formatTime(at, timezone)
  return day === todayKey ? time : `${formatJobDate(day, todayKey)} at ${time}`
}

/** "Saved on this phone at 9:42am.", under every line. */
export function savedLine(
  item: Pick<OutboxItem, 'createdAt'>,
  timezone: string,
  todayKey: string,
): string {
  const day = dayKeyOf(item.createdAt, timezone)
  const at = when(item.createdAt, timezone, todayKey)
  return day === todayKey
    ? `Saved on this phone at ${at}.`
    : `Saved on this phone on ${at}.`
}

/**
 * The inset's words, or `problem` with the code a `FormAlert` words for a
 * booking that needs a look.
 */
export function outboxInset(
  facts: InsetFacts,
): { words: string } | { problem: string } {
  const { item, timezone, todayKey } = facts
  const words = (text: string) => ({ words: text })
  // Nothing of it but its envelope can be read: whatever its state, save
  // that one sent says why its Discard is locked.
  if (!isReadable(item)) {
    return words(
      item.state === 'sending' ? NEWER_BUILD_SENT_WORDS : NEWER_BUILD_WORDS,
    )
  }
  switch (item.state) {
    case 'needsLook':
      return { problem: item.problem?.code ?? 'default' }
    case 'sent':
      return words('Sent — PestM8 has booked it.')
    case 'sending':
      if (facts.sendingHere) {
        return words(
          facts.lineLive
            ? 'Sending now.'
            : 'Sent as the signal went. It goes again when PestM8 is open with signal, and can be changed once PestM8 answers.',
        )
      }
      if (facts.sendingElsewhere) {
        return words(
          'It’s being sent from another PestM8 tab or window. It can be changed once PestM8 answers there.',
        )
      }
      return words(
        'It was sent and PestM8 hasn’t answered yet, so it may already be booked. Don’t book it again: it can be changed once PestM8 answers.',
      )
    case 'waiting':
      break
  }
  if (facts.storageTrouble) {
    return words(
      'This phone’s storage isn’t answering. Reload PestM8 to send it.',
    )
  }
  if (facts.editingHere) {
    return words('Not sent yet — it goes once the change is booked.')
  }
  if (editedElsewhere(item, facts.now ?? Date.now(), facts.tab)) {
    return words(EDITED_ELSEWHERE_WORDS)
  }
  switch (facts.held) {
    case 'newer-build':
      return words(NEWER_BUILD_WORDS)
    case 'parent':
      return words(
        `Not sent yet — it goes after the first booking for ${facts.parentClient ?? 'its client'}.`,
      )
    case 'switched':
    case 'switched-hold':
      return words(
        'Not sent yet — it goes when you’re back in your own account.',
      )
    case 'two-step':
      return words('Not sent yet — it goes once two-step sign-in is set up.')
    case 'other-person':
      return words(
        'Not sent yet — someone else is signed in to PestM8 in another tab.',
      )
    case 'retry':
      return words(
        `Not sent yet — PestM8 couldn’t take it just now. It tries again at ${when(item.retryAt ?? Date.now(), timezone, todayKey)}.`,
      )
    case 'hold': {
      const until = item.holdUntil ?? 0
      const from = item.lastAttemptAt ?? item.updatedAt
      return words(
        until - from >= PAUSE_LIKE_MS
          ? `Not sent yet — PestM8 has paused sending from phones. It tries again at ${when(until, timezone, todayKey)}.`
          : 'Not sent yet — it goes once PestM8 has checked your sign-in.',
      )
    }
    case 'access':
      return words(
        'Not sent yet — it goes once PestM8 has checked your sign-in.',
      )
    case 'line':
      return words(
        'Not sent yet — it’s on this phone and goes when PestM8 is open with signal.',
      )
    default:
      return words(
        facts.lineLive
          ? 'Not sent yet — it goes in a moment.'
          : 'Not sent yet — it’s on this phone and goes when PestM8 is open with signal.',
      )
  }
}

/**
 * The words for why a booking needs a look, by its code, beside the
 * server's own refusals (New Job's `BOOKING_ERROR_COPY`), which a sheet
 * adds them to: the ones only the phone says (it waited too long, its
 * first visit went by, it couldn't be taken off the phone after it went
 * straight or was discarded), its site gone, and a server that wouldn't
 * take it.
 */
export function outboxProblemCopy(
  item: OutboxItem,
  timezone: string,
  todayKey: string,
): Record<string, string> {
  const saved = formatJobDate(dayKeyOf(item.createdAt, timezone), todayKey)
  const first = item.booking.scheduledAt
  const siteGone =
    'Could not book this job: its client or site has been deleted. Edit it to choose another.'
  return {
    STALE: `Saved on this phone on ${saved} and not sent. Send it now, or discard it.`,
    FIRST_VISIT_PAST: `Could not book this job: its first visit, ${formatJobDate(dayKeyOf(first, timezone), todayKey)} at ${formatTime(first, timezone)}, went by before it was sent. Change the start date to book it.`,
    NOT_FOUND: siteGone,
    MISSING_PROPERTY: siteGone,
    SERVER: 'PestM8 couldn’t book this job. Try again, or edit it.',
    [LEFT_ON_PHONE]:
      'Could not take this booking off this phone, and it may already be booked. Check the schedule before you send it, or discard it.',
    // The server's backstop (the matching plan's M6) refuses these only for a
    // booking sent with what New Job's checks found, which a booking kept on
    // the phone never carries: should one reach it all the same, it needs a
    // look like any other refusal, and New Job's "book it again" would be
    // wrong here, where Edit is how it goes again.
    MATCHED_CLIENT:
      'Could not book this job: the caller may already be a client. Nothing was booked — check the client, then edit it to book it, or discard it.',
    SITE_BOOKED:
      'Could not book this job: work is already booked at that site near that date. Nothing was booked — check the schedule, then edit it to book it, or discard it.',
    SITE_REPEATS:
      'Could not book this job: a Recurring Job already runs at that site. Nothing was booked — check the schedule, then edit it to book it, or discard it.',
    // Anything else the server refused: New Job's "Check your signal and try
    // again" offers what this sheet doesn't (Try again is for SERVER alone).
    default:
      'Could not book this job. Nothing was booked — edit it to book it, or discard it.',
  }
}

/** An Edit open in another tab than `tab`, its lease not yet run out. */
export function editedElsewhere(
  item: OutboxItem,
  now: number,
  tab: string | undefined,
): boolean {
  return (
    item.editing !== null &&
    item.editing.until > now &&
    item.editing.tab !== tab
  )
}

// ── The footer ─────────────────────────────────────────────────────────────

/** The fix a booking's sheet offers as its primary button (plan §9.5). */
export type OutboxFix = 'edit' | 'changeDate' | 'tryAgain' | 'send'

export const FIX_LABELS: Record<OutboxFix, string> = {
  edit: 'Edit',
  changeDate: 'Change the date',
  tryAgain: 'Try again',
  send: 'Send',
}

export type OutboxFooter = {
  /** The primary button: null with nothing to fix here. */
  fix: OutboxFix | null
  /** Edit beside the fix, as a quieter button: "Try again, or edit it". */
  alsoEdit: boolean
  /** Discard, and which dialog it asks with: null when it can't be. */
  discard: 'item' | 'mayHaveGone' | null
  /** Shown, but neither can be pressed: it is locked, and the inset says
   * why. */
  locked: boolean
}

/**
 * Whether a booking sent with no answer can be discarded knowing it may be
 * booked (plan §6.3): only once it has waited a day since it went, or the
 * server has refused three times to say, and only while no tab holds its
 * lock and this page has no call out for it (S22f).
 */
export function mayAlreadyBeBooked(
  item: OutboxItem,
  at: {
    now: number
    refusedFinds: number
    sendingHere: boolean
    /** No tab, this one included, holds the item's lock. */
    lockFree: boolean
  },
): boolean {
  if (!isReadable(item) || item.state !== 'sending') return false
  if (at.sendingHere || !at.lockFree) return false
  const went = item.lastAttemptAt ?? item.updatedAt
  return (
    at.now - went >= MAY_HAVE_GONE_AFTER_MS ||
    at.refusedFinds >= MAY_HAVE_GONE_FINDS
  )
}

/**
 * The sheet's footer for a booking (plan §9.5 item 5): its fix as the
 * primary button, and Discard as the destructive text button. Both are
 * shown but locked while it is sending, or being changed in another tab.
 * One saved by a newer build has Discard alone; one sent has no footer.
 * `mayHaveGone`: `mayAlreadyBeBooked`.
 */
export function outboxFooter(
  item: OutboxItem,
  at: { now: number; mayHaveGone: boolean; tab?: string },
): OutboxFooter | null {
  if (item.state === 'sent') return null
  if (!isReadable(item)) {
    return {
      fix: null,
      alsoEdit: false,
      discard: 'item',
      locked: item.state === 'sending',
    }
  }
  if (item.state === 'sending') {
    return at.mayHaveGone
      ? { fix: null, alsoEdit: false, discard: 'mayHaveGone', locked: false }
      : { fix: 'edit', alsoEdit: false, discard: 'item', locked: true }
  }
  // Made on a site another booking on the phone makes (2c-I): changed only
  // once that one is booked, so nothing here but Discard.
  const changeable = !('local' in item.booking.property)
  const editOr = (fix: OutboxFix | null): OutboxFix | null =>
    changeable ? fix : null
  let fix: OutboxFix | null = editOr('edit')
  let alsoEdit = false
  if (item.state === 'needsLook') {
    switch (item.problem?.code) {
      case 'STALE':
      case LEFT_ON_PHONE:
        fix = 'send'
        break
      case 'FIRST_VISIT_PAST':
        fix = editOr('changeDate')
        break
      case 'SERVER':
        fix = 'tryAgain'
        alsoEdit = changeable
        break
    }
  }
  return {
    fix,
    alsoEdit,
    discard: 'item',
    locked: editedElsewhere(item, at.now, at.tab),
  }
}

// ── The dialogs, and what a refused tap says ──────────────────────────────

/** Discard (plan §9.7): the booking, never edits. */
export const DISCARD_ITEM = {
  title: 'Discard this job?',
  body: 'It hasn’t been sent, so it’s only on this phone. This can’t be undone.',
  confirm: 'Discard',
  cancel: 'Keep job',
} as const

/** Discard of one sent with no answer that can't be settled (§6.3). */
export const DISCARD_MAY_HAVE_GONE = {
  title: 'This may already be booked. Discard it from this phone?',
  body: 'It was sent and PestM8 never said whether it was booked. Check the schedule with signal before booking it again.',
  confirm: 'Discard',
  cancel: 'Keep job',
} as const

/** Discard of one New Job sent straight and couldn't take off the phone
 * (`LEFT_ON_PHONE`): its call may have gone, or still go with signal. */
export const DISCARD_LEFT_ON_PHONE = {
  title: 'This may already be booked. Discard it from this phone?',
  body: 'New Job sent it to PestM8, so it may already be booked, or be booked once this phone has signal. Check the schedule with signal before booking it again.',
  confirm: 'Discard',
  cancel: 'Keep job',
} as const

/** Which dialog Discard asks with (`OutboxFooter.discard`'s, by the
 * booking): only one that can't have gone says it is only on this phone. */
export function discardDialog(
  item: OutboxItem,
  discard: 'item' | 'mayHaveGone',
):
  | typeof DISCARD_ITEM
  | typeof DISCARD_MAY_HAVE_GONE
  | typeof DISCARD_LEFT_ON_PHONE {
  if (discard === 'mayHaveGone') return DISCARD_MAY_HAVE_GONE
  return item.problem?.code === LEFT_ON_PHONE
    ? DISCARD_LEFT_ON_PHONE
    : DISCARD_ITEM
}

/**
 * The phone's own refusals of a tap on a booking's sheet or its Edit, by
 * code, for `FormAlert` (S22b, §9.7, §10.3).
 */
export const OUTBOX_ACTION_COPY: Record<string, string> = {
  OUTBOX_DISCARD_REFUSED:
    'It started sending before it could be discarded. It can be discarded once PestM8 answers, if it still needs to be.',
  OUTBOX_DISCARD_ELSEWHERE:
    'It’s being changed in another PestM8 tab or window, so it wasn’t discarded. Close New Job there, then discard it here.',
  OUTBOX_DISCARD_BUSY:
    'PestM8 is checking whether it was booked, so it wasn’t discarded. Try Discard again in a moment.',
  OUTBOX_EDIT_REFUSED:
    'It started sending, so it can’t be changed now. Open it again once PestM8 answers.',
  OUTBOX_EDIT_ELSEWHERE:
    'It’s being changed in another PestM8 tab or window, so it can’t be changed here now. Close New Job there, then edit it here.',
  OUTBOX_EDIT_TAKEN:
    'It’s being changed in another PestM8 tab or window, so this change wasn’t booked. Close this, then edit it again once New Job is closed there.',
  OUTBOX_EDIT_SENT:
    'This was sent while you were changing it. Open the job to change it with signal.',
  // Not sent, and this form's hold on it let go while the page was away.
  OUTBOX_EDIT_LAPSED:
    'This job is still on this phone, not sent yet, and the change wasn’t booked — close this and edit it again.',
  OUTBOX_EDIT_BUSY:
    'It’s being sent from another PestM8 tab or window, so the change wasn’t booked. Try again once PestM8 answers there.',
  OUTBOX_EDIT_GONE:
    'This job isn’t on this phone any more: it was sent, or discarded. The change wasn’t booked — close this and check the schedule.',
  OUTBOX_STORAGE:
    'This phone’s storage isn’t answering, so nothing was changed. Reload PestM8 and try again.',
  // A Send, Discard or Book the storage didn't answer in time may land yet.
  OUTBOX_STORAGE_UNSURE:
    'This phone’s storage isn’t answering, so PestM8 can’t tell yet whether that was done. Reload PestM8 to see where it is.',
  default:
    'This phone’s storage isn’t answering, so nothing was changed. Reload PestM8 and try again.',
}
