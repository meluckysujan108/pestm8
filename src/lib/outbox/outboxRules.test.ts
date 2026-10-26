import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { OUTBOX_V } from './outboxItem'
import { ACCESS_HOLD_MS, PAUSED_HOLD_MS, STALE_AFTER_MS } from './outboxSet'
import {
  CHIP_WORDS,
  chipFor,
  classify,
  countsOf,
  firstVisitMeant,
  firstVisitPast,
  holdUntil,
  isStale,
  jobsWord,
  nextSendable,
  onPhoneWords,
  outboxHeading,
  preSendProblem,
  retryAt,
  sendable,
  skipReason,
} from './outboxRules'
import { bookingFor, itemFor } from './outboxStore.fixtures'
import type { AnswerContext, Classified } from './outboxRules'
import type { OutboxItem } from './outboxItem'

/**
 * The outbox's rules: what each answer from the server means for a kept
 * booking, which goes next, when one needs a look before it goes, how long
 * it is held, and what it is called on screen.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 27, 2)

const live: AnswerContext = { sameConnection: true, access: 'live' }
const across: AnswerContext = { sameConnection: false, access: 'live' }

const refusal = (code: string) => new ConvexError(code)

describe('what an answer means', () => {
  test.each<[string, Classified['cls'], Classified['then']]>([
    ['Unauthenticated', 'SIGNED_OUT', 'hold'],
    ['MFA_ENROLMENT_REQUIRED', 'TWO_STEP', 'hold'],
    ['NOT_OWN_ACCOUNT', 'SWITCHED', 'hold'],
    ['SWITCH_ENDED', 'SWITCHED', 'hold'],
    ['SWITCH_EXPIRED', 'SWITCHED', 'hold'],
    ['SWITCH_REVOKED', 'SWITCHED', 'hold'],
    ['SWITCH_TARGET_INACTIVE', 'SWITCHED', 'hold'],
    ['OUTBOX_PAUSED', 'PAUSED', 'hold'],
    ['INVALID_REQUEST_ID', 'NEW_ID', 'newRequestId'],
    ['NO_ACCESS', 'ASSIGNEE', 'needsLook'],
    ['INVALID_ASSIGNEE', 'ASSIGNEE', 'needsLook'],
    ['TOO_MANY_PEOPLE', 'ASSIGNEE', 'needsLook'],
    ['NOT_FOUND', 'SITE_GONE', 'needsLook'],
    ['MISSING_PROPERTY', 'SITE_GONE', 'needsLook'],
    ['INVALID_PHONE', 'FIELD', 'needsLook'],
    ['INVALID_EMAIL', 'FIELD', 'needsLook'],
    ['INVALID_ABN', 'FIELD', 'needsLook'],
    ['INVALID_WORK_ORDER', 'FIELD', 'needsLook'],
    ['NOTES_TOO_LONG', 'FIELD', 'needsLook'],
    ['INVALID_INTERVAL', 'FIELD', 'needsLook'],
    ['TAG_TOO_LONG', 'FIELD', 'needsLook'],
    ['FIRST_VISIT_PAST', 'FIELD', 'needsLook'],
    ['SOMETHING_NEW', 'FIELD', 'needsLook'],
  ])('%s on the same connection: %s, %s', (code, cls, then) => {
    expect(classify(refusal(code), live)).toEqual({ cls, then, code })
  })

  test.each([
    'Unauthenticated',
    'NOT_OWN_ACCOUNT',
    'INVALID_REQUEST_ID',
    'NO_ACCESS',
    'INVALID_ASSIGNEE',
    'NOT_FOUND',
    'INVALID_PHONE',
    'FIRST_VISIT_PAST',
  ])(
    '%s across a reconnect may follow a commit nobody heard: settled by asking',
    (code) => {
      expect(classify(refusal(code), across)).toEqual({
        cls: 'UNSETTLED',
        then: 'settle',
        code,
      })
    },
  )

  test('a plain error across a reconnect is settled too', () => {
    expect(classify(new Error('Server Error'), across)).toMatchObject({
      cls: 'UNSETTLED',
      then: 'settle',
    })
  })

  test('NO_ACCESS for someone removed from the business wipes; while access:me is not live, it holds', () => {
    expect(
      classify(refusal('NO_ACCESS'), {
        sameConnection: true,
        access: 'removed',
      }),
    ).toEqual({ cls: 'REMOVED', then: 'wipe', code: 'NO_ACCESS' })
    expect(
      classify(refusal('NO_ACCESS'), {
        sameConnection: true,
        access: 'unknown',
      }),
    ).toEqual({ cls: 'ACCESS', then: 'hold', code: 'NO_ACCESS' })
  })

  test.each([
    [
      'prod’s bare “Server Error”',
      new Error(
        '[CONVEX M(jobs:create)] [Request ID: 8b1f0c2d3e4a5b6c] Server Error',
      ),
    ],
    [
      'an ArgumentValidationError, which prod shows the same way',
      Object.assign(
        new Error(
          'ArgumentValidationError: Object contains extra field `refuseBackfill` that is not in the validator.',
        ),
        { name: 'ArgumentValidationError' },
      ),
    ],
    ['a network failure', new TypeError('Failed to fetch')],
    ['something thrown that isn’t an error at all', 'oops'],
  ])('%s is not a refusal: backed off', (_what, error) => {
    expect(classify(error, live)).toMatchObject({
      cls: 'SERVER',
      then: 'backoff',
      code: null,
    })
  })

  test('a message that names a code is never read as one', () => {
    expect(
      classify(new Error('Uncaught ConvexError: NOT_OWN_ACCOUNT'), live),
    ).toMatchObject({ cls: 'SERVER', code: null })
  })

  test('keeps Convex’s request id for the note', () => {
    expect(
      classify(
        new Error(
          '[CONVEX M(jobs:create)] [Request ID: 8b1f0c2d3e4a5b6c] Server Error',
        ),
        live,
      ).requestId,
    ).toBe('8b1f0c2d3e4a5b6c')
  })

  test('a ConvexError whose data carries no code is still a refusal', () => {
    expect(classify(new ConvexError({ reason: 'x' }), live)).toMatchObject({
      cls: 'FIELD',
      code: 'CONVEX_ERROR',
    })
    expect(
      classify(new ConvexError({ code: 'INVALID_ASSIGNEE' }), live),
    ).toMatchObject({ cls: 'ASSIGNEE', code: 'INVALID_ASSIGNEE' })
  })
})

describe('holds and backoff', () => {
  test('signed out: 5 s, 30 s, 2 min, then 5 min each time', () => {
    expect(
      [1, 2, 3, 4, 5, 9].map((n) => holdUntil('SIGNED_OUT', n, 0)),
    ).toEqual([5_000, 30_000, 2 * MIN, 5 * MIN, 5 * MIN, 5 * MIN])
  })

  test('switched: at least 30 s, then 2 min, then 5 min each time', () => {
    expect([1, 2, 3, 4].map((n) => holdUntil('SWITCHED', n, 0))).toEqual([
      30_000,
      2 * MIN,
      5 * MIN,
      5 * MIN,
    ])
  })

  test('paused 15 min, and NO_ACCESS that can’t be told apart 30 s, every time', () => {
    expect(holdUntil('PAUSED', 7, NOW)).toBe(NOW + PAUSED_HOLD_MS)
    expect(PAUSED_HOLD_MS).toBe(15 * MIN)
    expect(holdUntil('ACCESS', 3, NOW)).toBe(NOW + ACCESS_HOLD_MS)
  })

  test('a server error: tried again 1, 5 and 15 min after the attempt, then it needs a look', () => {
    expect([1, 2, 3, 4].map((n) => retryAt(n, NOW))).toEqual([
      NOW + MIN,
      NOW + 5 * MIN,
      NOW + 15 * MIN,
      null,
    ])
  })
})

/** A series kept at `createdAt`, starting at `scheduledAt`. */
function series(scheduledAt: number, createdAt: number): OutboxItem {
  return itemFor(
    'u1',
    {
      kind: 'series',
      booking: bookingFor({ scheduledAt, repeat: { count: 1, unit: 'month' } }),
    },
    createdAt,
  )
}

describe('a first visit gone by', () => {
  // Saved an hour before its first visit, 8am.
  const start = NOW
  const saved = start - HOUR

  test('meant, when saved no more than a day after the series starts', () => {
    expect(firstVisitMeant(series(start, saved))).toBe(true)
    expect(firstVisitMeant(series(start, start + DAY))).toBe(true)
    expect(firstVisitMeant(series(start, start + DAY + 1))).toBe(false)
  })

  test('has gone once the start is 23 h back, to the minute', () => {
    const item = series(start, saved)
    expect(firstVisitPast(item, start + 23 * HOUR - MIN)).toBe(false)
    expect(firstVisitPast(item, start + 23 * HOUR + MIN)).toBe(true)
  })

  test('never for a series whose start was already three days back when it was saved: booked as online books it', () => {
    const item = series(start - 3 * DAY, start)
    expect(firstVisitMeant(item)).toBe(false)
    expect(firstVisitPast(item, start + 30 * DAY)).toBe(false)
  })

  test('never for a one-off, which is booked in the past as online books it', () => {
    const item = itemFor(
      'u1',
      { booking: bookingFor({ scheduledAt: start }) },
      saved,
    )
    expect(firstVisitPast(item, start + 30 * DAY)).toBe(false)
  })
})

describe('waited too long', () => {
  const saved = NOW

  test('three days unsent, to the minute', () => {
    const item = itemFor('u1', {}, saved)
    expect(STALE_AFTER_MS).toBe(3 * DAY)
    expect(isStale(item, saved + 3 * DAY - MIN)).toBe(false)
    expect(isStale(item, saved + 3 * DAY + MIN)).toBe(true)
  })

  test('or its session ended on the server, however recent', () => {
    expect(
      isStale(itemFor('u1', { sessionEndedAt: saved }, saved), saved),
    ).toBe(true)
  })

  test('the person’s Send answers for the wait, and for a session that had ended, as they stood then', () => {
    const sent = saved + 4 * DAY
    const item = itemFor(
      'u1',
      { sessionEndedAt: saved + DAY, confirmedAt: sent },
      saved,
    )
    expect(isStale(item, sent + MIN)).toBe(false)
    // Three more days still unsent: asked again.
    expect(isStale(item, sent + 3 * DAY - MIN)).toBe(false)
    expect(isStale(item, sent + 3 * DAY + MIN)).toBe(true)
  })

  test('a session that ends after the Send is asked about again, at once', () => {
    const sent = saved + HOUR
    const item = itemFor(
      'u1',
      { confirmedAt: sent, sessionEndedAt: sent + MIN },
      saved,
    )
    expect(isStale(item, sent + 2 * MIN)).toBe(true)
    // Ended and said Send in the same instant: asked, to be safe.
    expect(isStale({ ...item, sessionEndedAt: sent }, sent + MIN)).toBe(true)
  })

  test('an edit (a Book from Edit on one that hadn’t waited too long) leaves the clock where it was', () => {
    // replaceChange sets no confirmedAt then (outboxStore.test.ts), so the
    // three days still run from when it was saved, and a later session end
    // still needs a tap.
    const edited = itemFor('u1', { updatedAt: saved + DAY }, saved)
    expect(isStale(edited, saved + 3 * DAY + MIN)).toBe(true)
    expect(
      isStale({ ...edited, sessionEndedAt: saved + 2 * DAY }, saved + 2 * DAY),
    ).toBe(true)
  })

  test('is asked before a first visit gone by', () => {
    const item = { ...series(NOW, NOW - HOUR), sessionEndedAt: NOW }
    expect(preSendProblem(item, NOW + DAY)).toBe('STALE')
    expect(preSendProblem({ ...item, sessionEndedAt: null }, NOW + DAY)).toBe(
      'FIRST_VISIT_PAST',
    )
    expect(
      preSendProblem({ ...item, sessionEndedAt: null }, NOW + HOUR),
    ).toBeNull()
  })
})

describe('which goes next', () => {
  const ctx = { now: NOW, editingHere: new Set<string>() }

  test('oldest first, sending ones included (to be settled)', () => {
    const newer = itemFor('u1', {}, 3)
    const older = itemFor('u1', { state: 'sending' }, 1)
    const middle = itemFor('u1', {}, 2)
    expect(sendable([newer, older, middle], ctx)).toEqual([
      older,
      middle,
      newer,
    ])
    expect(nextSendable([newer, older, middle], ctx)).toBe(older)
  })

  test.each<[string, Partial<OutboxItem>, string]>([
    ['a newer build’s', { v: OUTBOX_V + 1 }, 'foreign'],
    ['one needing a look', { state: 'needsLook' }, 'state'],
    ['one sent', { state: 'sent' }, 'state'],
    [
      'one edited in another tab',
      { editing: { tab: 't2', until: NOW + 1 } },
      'editing',
    ],
    ['one backing off', { retryAt: NOW + 1 }, 'retry'],
    ['one held', { holdUntil: NOW + 1 }, 'hold'],
  ])('skips %s', (_what, extra, reason) => {
    const item = itemFor('u1', extra)
    expect(skipReason(item, [item], ctx)).toBe(reason)
    expect(nextSendable([item], ctx)).toBeNull()
  })

  test('never one being edited in this tab, even with its lease run out', () => {
    const item = itemFor('u1', { editing: { tab: 't1', until: NOW - 1 } })
    expect(
      skipReason(item, [item], {
        now: NOW,
        editingHere: new Set([item.localId]),
      }),
    ).toBe('editing')
    expect(skipReason(item, [item], ctx)).toBeNull()
  })

  test('one waiting on the item that makes its site waits behind it, and blocks nothing else', () => {
    const parent = itemFor('u1', { state: 'needsLook' }, 1)
    const child = itemFor('u1', { dependsOn: parent.localId }, 2)
    const other = itemFor('u1', {}, 3)
    expect(sendable([parent, child, other], ctx)).toEqual([other])
    expect(skipReason(child, [parent, child, other], ctx)).toBe('parent')

    const sent = { ...parent, state: 'sent' as const }
    expect(sendable([sent, child, other], ctx)).toEqual([child, other])
  })

  test('one whose parent has gone altogether is left to its send to say so', () => {
    const child = itemFor('u1', { dependsOn: 'gone' })
    expect(skipReason(child, [child], ctx)).toBeNull()
  })
})

describe('on screen', () => {
  test('every item sending is “Sending…”: one that may be booked never reads as not sent', () => {
    expect(
      (['waiting', 'sending', 'needsLook', 'sent'] as const).map(
        (state) => CHIP_WORDS[chipFor({ state })],
      ),
    ).toEqual(['Not sent yet', 'Sending…', 'Needs a look', 'Sent'])
  })

  test('jobs, one and more', () => {
    expect([jobsWord(1), jobsWord(2), jobsWord(0)]).toEqual([
      '1 job',
      '2 jobs',
      '0 jobs',
    ])
  })

  test('the heading counts what might be booked again, never one sending', () => {
    const items = (states: Array<OutboxItem['state']>) =>
      countsOf(states.map((state) => ({ state })))
    expect(outboxHeading(items(['waiting']))).toBe('1 job not sent yet')
    expect(outboxHeading(items(['waiting', 'needsLook']))).toBe(
      '2 jobs not sent yet',
    )
    expect(outboxHeading(items(['waiting', 'needsLook', 'sending']))).toBe(
      '2 jobs not sent yet, 1 sending',
    )
    expect(outboxHeading(items(['sending']))).toBe('1 job sending')
    expect(outboxHeading(items(['sending', 'sending']))).toBe('2 jobs sending')
    expect(outboxHeading(items(['sent', 'sent']))).toBe('Sent')
    expect(outboxHeading(items(['waiting', 'sent']))).toBe('1 job not sent yet')
    expect(outboxHeading(items([]))).toBeNull()
  })

  test('the sign-in screens say whose jobs are on the phone', () => {
    expect(onPhoneWords('Kevin', 2)).toBe(
      'Kevin has 2 jobs on this phone not sent yet. They go when Kevin signs in again. Signing in as anyone else discards them.',
    )
    expect(onPhoneWords('Kevin', 1)).toBe(
      'Kevin has 1 job on this phone not sent yet. It goes when Kevin signs in again. Signing in as anyone else discards it.',
    )
    expect(onPhoneWords('', 2)).toBe(
      'Jobs not sent yet are on this phone. They go when the person who booked them signs in again. Signing in as anyone else discards them.',
    )
    expect(onPhoneWords(' ', 1)).toBe(
      'A job not sent yet is on this phone. It goes when the person who booked it signs in again. Signing in as anyone else discards it.',
    )
  })
})
