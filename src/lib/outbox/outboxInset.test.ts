import { describe, expect, test } from 'vitest'
import { LEFT_ON_PHONE } from './book'
import { outboxInset, outboxProblemCopy, savedLine } from './outboxInset'
import { PAUSED_HOLD_MS } from './outboxSet'
import { bookingFor, itemFor } from './outboxStore.fixtures'
import type { InsetFacts } from './outboxInset'
import type { OutboxItem } from './outboxItem'

/**
 * What a booking's sheet says of it: where it is, and why it hasn't gone,
 * so the person knows never to book it again.
 */

const TZ = 'Australia/Perth'
const TODAY = '2026-10-27'
/** 9:42am on TODAY in Perth. */
const SAVED = Date.UTC(2026, 9, 27, 1, 42)

function facts(
  item: Partial<OutboxItem> = {},
  extra: Partial<InsetFacts> = {},
): InsetFacts {
  return {
    item: itemFor('u1', item, SAVED),
    lineLive: true,
    held: null,
    sendingHere: false,
    sendingElsewhere: false,
    storageTrouble: false,
    timezone: TZ,
    todayKey: TODAY,
    ...extra,
  }
}

const words = (f: InsetFacts) => {
  const said = outboxInset(f)
  return 'words' in said ? said.words : `problem:${said.problem}`
}

describe('a booking’s sheet says', () => {
  test('waiting, by why', () => {
    expect(words(facts({}, { lineLive: false, held: 'line' }))).toBe(
      'Not sent yet — it’s on this phone and goes when PestM8 is open with signal.',
    )
    expect(words(facts())).toBe('Not sent yet — it goes in a moment.')
    expect(words(facts({}, { held: 'switched' }))).toBe(
      'Not sent yet — it goes when you’re back in your own account.',
    )
    expect(words(facts({}, { held: 'two-step' }))).toBe(
      'Not sent yet — it goes once two-step sign-in is set up.',
    )
    expect(words(facts({}, { held: 'other-person' }))).toBe(
      'Not sent yet — someone else is signed in to PestM8 in another tab.',
    )
    expect(words(facts({}, { storageTrouble: true }))).toBe(
      'This phone’s storage isn’t answering. Reload PestM8 to send it.',
    )
    expect(
      words(facts({ retryAt: SAVED + 5 * 60_000 }, { held: 'retry' })),
    ).toBe(
      'Not sent yet — PestM8 couldn’t take it just now. It tries again at 9:47am.',
    )
  })

  test('the server’s pause, told from a shorter hold by its length', () => {
    const paused = facts(
      { lastAttemptAt: SAVED, holdUntil: SAVED + PAUSED_HOLD_MS },
      { held: 'hold' },
    )
    expect(words(paused)).toBe(
      'Not sent yet — PestM8 has paused sending from phones. It tries again at 9:57am.',
    )
    const signIn = facts(
      { lastAttemptAt: SAVED, holdUntil: SAVED + 30_000 },
      { held: 'hold' },
    )
    expect(words(signIn)).toBe(
      'Not sent yet — it goes once PestM8 has checked your sign-in.',
    )
  })

  test('sending: here, live or not; from another tab; or from an earlier page, which may already be booked', () => {
    const sending = { state: 'sending' as const }
    expect(words(facts(sending, { sendingHere: true }))).toBe('Sending now.')
    expect(words(facts(sending, { sendingHere: true, lineLive: false }))).toBe(
      'Sent as the signal went. It goes again when PestM8 is open with signal, and can be changed once PestM8 answers.',
    )
    expect(words(facts(sending, { sendingElsewhere: true }))).toBe(
      'It’s being sent from another PestM8 tab or window. It can be changed once PestM8 answers there.',
    )
    expect(words(facts(sending))).toBe(
      'It was sent and PestM8 hasn’t answered yet, so it may already be booked. Don’t book it again: it can be changed once PestM8 answers.',
    )
  })

  test('needing a look: its code, for FormAlert', () => {
    expect(
      words(
        facts({ state: 'needsLook', problem: { code: 'INVALID_ASSIGNEE' } }),
      ),
    ).toBe('problem:INVALID_ASSIGNEE')
  })

  test('when it was saved, today or another day', () => {
    expect(savedLine({ createdAt: SAVED }, TZ, TODAY)).toBe(
      'Saved on this phone at 9:42am.',
    )
    expect(savedLine({ createdAt: SAVED }, TZ, '2026-10-28')).toBe(
      'Saved on this phone on Tue 27 Oct at 9:42am.',
    )
  })

  test('the phone’s own reasons for a look, and a site gone', () => {
    const item = itemFor(
      'u1',
      {
        booking: bookingFor({
          scheduledAt: Date.UTC(2026, 9, 20, 0),
          repeat: { count: 1, unit: 'month' },
        }),
      },
      Date.UTC(2026, 9, 20, 0),
    )
    const copy = outboxProblemCopy(item, TZ, TODAY)
    expect(copy.STALE).toBe(
      'Saved on this phone on Tue 20 Oct and not sent. Send it now, or discard it.',
    )
    expect(copy.FIRST_VISIT_PAST).toBe(
      'Could not book this job: its first visit, Tue 20 Oct at 8:00am, went by before it was sent. Change the start date to book it.',
    )
    expect(copy.NOT_FOUND).toBe(copy.MISSING_PROPERTY)
    // Left on the phone by mistake (book.ts `leftOnPhoneChange`).
    expect(copy[LEFT_ON_PHONE]).toBe(
      'Could not take this booking off this phone, and it may already be booked. Check the schedule before you send it, or discard it.',
    )
  })
})
