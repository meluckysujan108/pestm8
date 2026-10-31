import { formatJobDate, formatTime } from '#/lib/format'
import { dayKeyOf } from '../../../convex/lib/dates'
import { LEFT_ON_PHONE } from './book'
import { PAUSED_HOLD_MS } from './outboxSet'
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
}

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
  switch (facts.held) {
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
  }
}
