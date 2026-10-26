import { describe, expect, test } from 'vitest'
import {
  NOT_KEPT_JOB,
  dayOfBusiness,
  keptClientNumber,
  keptJobInset,
  keptJobReadOnly,
  keptJobState,
} from './keptJob'

/**
 * The job sheet with no answer from PestM8: the job from its day once the
 * line is down, or the answer is late and the day isn't live, and "not on
 * this phone" only when the line is down and the phone's copy has been read.
 */

const UP = {
  down: null,
  waitedOut: false,
  shown: false,
  found: true,
  live: false,
  copyRead: true,
}

describe('what the sheet shows with no answer yet', () => {
  test('on a working line, its placeholder until the wait is over', () => {
    expect(keptJobState(UP)).toBe('waiting')
    expect(keptJobState({ ...UP, found: false })).toBe('waiting')
  })

  test('the job from its day once the wait is over, or at once with the line down', () => {
    expect(keptJobState({ ...UP, waitedOut: true })).toBe('kept')
    expect(keptJobState({ ...UP, down: 'no-signal' })).toBe('kept')
    expect(keptJobState({ ...UP, down: 'unreachable' })).toBe('kept')
  })

  test('a job no day lists is said to be not on this phone only with the line down', () => {
    const missing = { ...UP, found: false }
    expect(keptJobState({ ...missing, down: 'no-signal' })).toBe('not-kept')
    expect(keptJobState({ ...missing, down: 'unreachable' })).toBe('not-kept')
    // A late answer on a line that looks up: ConnectionNotice says so, and
    // the placeholder stays a placeholder.
    expect(keptJobState({ ...missing, waitedOut: true })).toBe('waiting')
  })

  test('nothing is said to be missing before the phone’s copy has been read', () => {
    expect(
      keptJobState({
        ...UP,
        down: 'no-signal',
        waitedOut: true,
        found: false,
        copyRead: false,
      }),
    ).toBe('waiting')
  })

  test('a late answer from a day that is live is on its way: the placeholder stays, and says nothing it can’t reach', () => {
    const live = { ...UP, waitedOut: true, live: true }
    expect(keptJobState(live)).toBe('waiting')
    // With the line down, the day is shown whatever it last was.
    expect(keptJobState({ ...live, down: 'no-signal' })).toBe('kept')
  })

  test('once shown, kept up with the line back or the day live again, until the answer comes', () => {
    const shown = { ...UP, shown: true }
    expect(keptJobState(shown)).toBe('kept')
    expect(keptJobState({ ...shown, live: true })).toBe('kept')
    // Gone from its day meanwhile: nothing left to show it from.
    expect(keptJobState({ ...shown, found: false })).toBe('waiting')
  })
})

describe('whose day it is', () => {
  const found = (businessId: string) => ({ row: { businessId }, asOf: 1 })

  test('only a day of the business the sheet is in', () => {
    expect(dayOfBusiness(found('b1'), 'b1')).toEqual(found('b1'))
    // The last business's days, still in memory after a switch.
    expect(dayOfBusiness(found('b2'), 'b1')).toBeNull()
    expect(dayOfBusiness(null, 'b1')).toBeNull()
  })
})

describe('what it says', () => {
  test('why, how old, and that editing needs signal', () => {
    expect(keptJobInset('no-signal', '9:42am')).toBe(
      'No signal — showing the copy kept on this phone, updated 9:42am. Editing needs signal.',
    )
    expect(keptJobInset('unreachable', 'Sun 25 Oct, 9:42am')).toBe(
      'Could not reach PestM8 — showing the kept copy, updated Sun 25 Oct, 9:42am. Editing needs signal.',
    )
  })

  test('an answer late on a line that looks up is PestM8 not answering', () => {
    expect(keptJobInset(null, '9:42am')).toBe(
      keptJobInset('unreachable', '9:42am'),
    )
  })

  test('a job not on the phone says when it opens', () => {
    expect(NOT_KEPT_JOB).toBe(
      'This job isn’t on this phone. It opens when you have signal.',
    )
  })
})

describe('whether the live sheet would say the job is someone else’s', () => {
  const MINE = { membershipId: 'm_kev', role: 'subcontractor', actingAs: null }
  const job = (lead: string, also: Array<string> = []) => ({
    assignedMembershipId: lead,
    alsoGoing: also.map((_id) => ({ _id })),
  })
  /** The roster as a contractor, Jo, sees it: whom she may book onto is
   * herself and her team, Kevin; not Sam, who is someone else's. */
  const ROSTER = [
    { _id: 'm_jo', role: 'contractor', bookable: true },
    { _id: 'm_kev', role: 'subcontractor', bookable: true },
    { _id: 'm_sam', role: 'subcontractor', bookable: false },
    { _id: 'm_owner', role: 'owner', bookable: false },
  ]
  const JO = { membershipId: 'm_jo', role: 'contractor', actingAs: null }

  test('a subcontractor’s look at a job they aren’t on', () => {
    expect(keptJobReadOnly(MINE, undefined, job('m_sam'))).toBe(true)
    expect(keptJobReadOnly(MINE, undefined, job('m_kev'))).toBe(false)
    expect(keptJobReadOnly(MINE, undefined, job('m_sam', ['m_kev']))).toBe(
      false,
    )
  })

  test('a contractor’s look at a job nobody of their team is on, as the roster says whom they may book', () => {
    expect(keptJobReadOnly(JO, ROSTER, job('m_sam'))).toBe(true)
    expect(keptJobReadOnly(JO, ROSTER, job('m_kev'))).toBe(false)
    expect(keptJobReadOnly(JO, ROSTER, job('m_jo'))).toBe(false)
    expect(keptJobReadOnly(JO, ROSTER, job('m_sam', ['m_kev']))).toBe(false)
  })

  test('the account being worked in decides, its role read from the roster', () => {
    const asKevin = {
      membershipId: 'm_owner',
      role: 'owner',
      actingAs: { membershipId: 'm_kev' },
    }
    expect(keptJobReadOnly(asKevin, ROSTER, job('m_sam'))).toBe(true)
    expect(keptJobReadOnly(asKevin, ROSTER, job('m_kev'))).toBe(false)
    const asJo = { ...asKevin, actingAs: { membershipId: 'm_jo' } }
    expect(keptJobReadOnly(asJo, ROSTER, job('m_sam'))).toBe(true)
    expect(keptJobReadOnly(asJo, ROSTER, job('m_kev'))).toBe(false)
  })

  test('never for an owner, nor where the phone can’t tell: no roster, a roster without who may be booked, no access in memory', () => {
    expect(
      keptJobReadOnly({ ...MINE, role: 'owner' }, ROSTER, job('m_sam')),
    ).toBe(false)
    expect(keptJobReadOnly(JO, undefined, job('m_sam'))).toBe(false)
    expect(
      keptJobReadOnly(
        JO,
        ROSTER.map(({ _id, role }) => ({ _id, role })),
        job('m_sam'),
      ),
    ).toBe(false)
    expect(
      keptJobReadOnly(
        { ...MINE, actingAs: { membershipId: 'm_sam' } },
        undefined,
        job('m_jo'),
      ),
    ).toBe(false)
    expect(keptJobReadOnly(undefined, ROSTER, job('m_sam'))).toBe(false)
  })
})

describe('the client’s number on the job’s Property card', () => {
  const DIRECTORY = {
    clients: [{ _id: 'c1', clientNumber: 1916 }, { _id: 'c2' }],
    sites: [
      { _id: 'p1', clientId: 'c1' },
      { _id: 'p2', clientId: 'c2' },
    ],
  }

  test('the site’s client’s, from the client list', () => {
    expect(keptClientNumber(DIRECTORY, 'p1')).toBe(1916)
  })

  test('none where the list doesn’t say: no number, no such site, no list', () => {
    expect(keptClientNumber(DIRECTORY, 'p2')).toBeUndefined()
    expect(keptClientNumber(DIRECTORY, 'p9')).toBeUndefined()
    expect(keptClientNumber(undefined, 'p1')).toBeUndefined()
  })
})
