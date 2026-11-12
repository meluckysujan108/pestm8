import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  LEAVE_READ_WAIT_MS,
  LEAVE_SEND_WAIT_MS,
  UNREADABLE_QUESTION,
  confirmedLeave,
  leaveGuardFor,
  leaveQuestion,
  onPhoneLine,
  signOutFailedWords,
  signOutQuestion,
  switchQuestion,
  unsentByBusiness,
} from './leaveAsk'
import { STALE_AFTER_MS } from './outboxSet'
import {
  peekOutbox,
  setOutboxBackendForTests,
  stillKept,
  writeSignOutTombstone,
} from './outboxStore'
import {
  B1,
  B2,
  itemFor,
  memoryStorage,
  outboxOf,
} from './outboxStore.fixtures'
import type { LeaveFacts, LeaveQuestion } from './leaveAsk'
import type { OutboxItem } from './outboxItem'

/**
 * What signing out or switching business asks of the bookings on this
 * phone, not sent yet (plan part 2c §11.1–§11.2): never a plain yes while
 * the phone can't be read (S2, F4), never counting one a send of this tab's
 * may have just delivered before its answer has had time to come (S22e),
 * nor one a sign-out already discarded; and what the sign-in screens say of
 * those left on the phone (§11.4).
 */

vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The phone's own, as the guard reads it (`OutboxLeaveGuard`): on B1, u1
 * signed in, keeping on, everything read (and read afresh at once), nothing
 * out. `items` as `OutboxModel.all`
 * hands them out, less what a sign-out discarded. */
function factsOf(
  items: () => ReadonlyArray<OutboxItem>,
  over: Partial<LeaveFacts> = {},
): LeaveFacts {
  return {
    storage: true,
    enabled: true,
    keptBefore: () => false,
    readable: () => true,
    readFresh: () => Promise.resolve(true),
    subscribe: () => () => {},
    items: () => items().filter(stillKept),
    inflight: () => 0,
    holdSends: () => Promise.resolve(() => {}),
    holdHere: () => () => {},
    userId: () => 'u1',
    businessId: () => B1,
    // A second after the fixtures' bookings were saved (`itemFor`'s).
    now: () => 2_000,
    ...over,
  }
}

const pestfolio = (extra: Partial<OutboxItem> = {}) =>
  itemFor('u1', { businessId: B2, businessName: 'Pestfolio', ...extra })

/** Whether `promise` has settled yet, and with what. */
function watch<T>(promise: Promise<T>) {
  const box: { done: boolean; value?: T } = { done: false }
  void promise.then((value) => {
    box.done = true
    box.value = value
  })
  return box
}

describe('what leaving asks (`leaveQuestion`)', () => {
  test('none of the person’s on the phone: goes', async () => {
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => []),
      ),
    ).toBeNull()
    // Another person's, and one sent, aren't the person's to lose.
    const others = [itemFor('u2'), itemFor('u1', { state: 'sent' })]
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => others),
      ),
    ).toBeNull()
    expect(
      await leaveQuestion(
        'switchBusiness',
        factsOf(() => others),
      ),
    ).toBeNull()
  })

  test('one a sign-out already discarded doesn’t count, here or in another tab', async () => {
    const items = [itemFor('u1', {}, 1_000)]
    writeSignOutTombstone('u1', 2_000)
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => items),
      ),
    ).toBeNull()
  })

  test('a sign-out counts them in every business, and says which are another’s', async () => {
    const here = itemFor('u1')
    const there = pestfolio()
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => [here, there]),
      ),
    ).toEqual({
      title: 'Sign out and discard 2 jobs not sent yet?',
      body: 'They’re only on this phone. 1 is for Pestfolio.',
      confirm: 'Discard and sign out',
      cancel: 'Stay signed in',
    })
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => [there]),
      ),
    ).toEqual(
      expect.objectContaining({
        title: 'Sign out and discard 1 job not sent yet?',
        body: 'It’s only on this phone. It’s for Pestfolio.',
      }),
    )
    // Outside a business (the no-business, set-up, two-step, join and start
    // screens), every one is another's.
    const three = itemFor('u1', {
      businessId: 'b3' as OutboxItem['businessId'],
      businessName: 'Bug Busters',
    })
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => [here, there, three], { businessId: () => null }),
      ),
    ).toEqual(
      expect.objectContaining({
        body: 'They’re only on this phone. They’re for 3 businesses.',
      }),
    )
    expect(signOutQuestion([here, there, three], B1)?.body).toBe(
      'They’re only on this phone. 2 are for other businesses.',
    )
  })

  test('one being sent, with no answer yet, may already have gone', async () => {
    const sending = itemFor('u1', { state: 'sending' })
    expect(
      (
        await leaveQuestion(
          'signOut',
          factsOf(() => [sending]),
        )
      )?.body,
    ).toBe(
      'It’s only on this phone. It may already have gone — check the schedule when you’re back.',
    )
    expect(
      (
        await leaveQuestion(
          'signOut',
          factsOf(() => [sending, itemFor('u1')]),
        )
      )?.body,
    ).toBe(
      'They’re only on this phone. 1 may already have gone — check the schedule when you’re back.',
    )
  })

  test('a switch counts the business left, and says they wait for it (X7)', async () => {
    const items = [itemFor('u1'), pestfolio(), pestfolio()]
    expect(
      await leaveQuestion(
        'switchBusiness',
        factsOf(() => items),
      ),
    ).toEqual({
      title: 'Switch with 1 job not sent yet?',
      body: 'It stays on this phone and goes when you’re back in Pest Co with signal.',
      confirm: 'Switch',
      cancel: 'Stay in Pest Co',
    })
    expect(
      await leaveQuestion(
        'switchBusiness',
        factsOf(() => items, { businessId: () => B2 }),
      ),
    ).toEqual(
      expect.objectContaining({
        title: 'Switch with 2 jobs not sent yet?',
        body: 'They stay on this phone and go when you’re back in Pestfolio with signal.',
        cancel: 'Stay in Pestfolio',
      }),
    )
    // None in the business left: nothing to ask.
    expect(
      await leaveQuestion(
        'switchBusiness',
        factsOf(() => [pestfolio()], { businessId: () => B1 }),
      ),
    ).toBeNull()
  })

  test('no IndexedDB or no Web Locks, where nothing was ever kept: goes, read or not', async () => {
    const readFresh = vi.fn(() => Promise.resolve(false))
    const facts = factsOf(() => [itemFor('u1')], {
      storage: false,
      readable: () => false,
      readFresh,
    })
    expect(await leaveQuestion('signOut', facts)).toBeNull()
    expect(readFresh).not.toHaveBeenCalled()
  })

  test('a phone slower than a second to read is read afresh and waited on, up to 3 s (S2)', async () => {
    vi.useFakeTimers()
    const readFresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), 1_500),
        ),
    )
    const facts = factsOf(() => [itemFor('u1')], { readFresh })
    const asked = watch(leaveQuestion('signOut', facts))
    expect(readFresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_400)
    expect(asked.done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(asked.done).toBe(true)
    expect(asked.value?.title).toBe('Sign out and discard 1 job not sent yet?')
  })

  test('still unreadable after 3 s: the generic question, never a plain yes (S2, F4)', async () => {
    vi.useFakeTimers()
    const facts = factsOf(() => [], {
      readable: () => false,
      readFresh: () => new Promise<boolean>(() => {}),
    })
    const asked = watch(leaveQuestion('signOut', facts))
    await vi.advanceTimersByTimeAsync(LEAVE_READ_WAIT_MS - 1)
    expect(asked.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(asked.done).toBe(true)
    expect(asked.value).toEqual(UNREADABLE_QUESTION)
    expect(UNREADABLE_QUESTION).toEqual({
      title: 'Sign out? Jobs not sent yet may be on this phone.',
      body: 'PestM8 can’t read this phone’s storage just now. Signing out discards any jobs on it not sent yet.',
      confirm: 'Discard and sign out',
      cancel: 'Stay signed in',
    })
  })

  test('unreadable, a switch goes at once: what it leaves behind is kept whatever it is; and so does a build that keeps nothing, on a phone that never kept', async () => {
    vi.useFakeTimers()
    const readFresh = vi.fn(() => Promise.resolve(false))
    const unread = { readable: () => false, readFresh }
    expect(
      await leaveQuestion(
        'switchBusiness',
        factsOf(() => [], unread),
      ),
    ).toBeNull()
    expect(
      await leaveQuestion(
        'signOut',
        factsOf(() => [], { ...unread, enabled: false }),
      ),
    ).toBeNull()
    expect(readFresh).not.toHaveBeenCalled()
  })

  test('a sign-out counts from a fresh read, never an earlier one: that failing, the generic question (F9)', async () => {
    // Read once, at page load; the store has since stopped answering.
    const facts = factsOf(() => [], {
      readable: () => true,
      readFresh: () => Promise.resolve(false),
    })
    expect(await leaveQuestion('signOut', facts)).toEqual(UNREADABLE_QUESTION)
  })

  test('a build with keeping off still asks on a phone that has kept (D14): unread, the generic question', async () => {
    vi.useFakeTimers()
    const kept = factsOf(() => [], {
      enabled: false,
      keptBefore: () => true,
      readable: () => false,
      readFresh: () => Promise.resolve(false),
    })
    expect(await leaveQuestion('signOut', kept)).toEqual(UNREADABLE_QUESTION)
    // Read, it counts them as with keeping on.
    expect(
      (
        await leaveQuestion(
          'signOut',
          factsOf(() => [itemFor('u1')], {
            enabled: false,
            keptBefore: () => true,
          }),
        )
      )?.title,
    ).toBe('Sign out and discard 1 job not sent yet?')
    // One that never kept counts what this tab has read, with no fresh read.
    const readFresh = vi.fn(() => Promise.resolve(false))
    expect(
      (
        await leaveQuestion(
          'signOut',
          factsOf(() => [itemFor('u1')], { enabled: false, readFresh }),
        )
      )?.title,
    ).toBe('Sign out and discard 1 job not sent yet?')
    expect(readFresh).not.toHaveBeenCalled()
  })

  test('a switch never waits on a send: the booking stays, whatever its answer (F13)', async () => {
    vi.useFakeTimers()
    const facts = factsOf(() => [itemFor('u1', { state: 'sending' })], {
      inflight: () => 1,
    })
    const asked = watch(leaveQuestion('switchBusiness', facts))
    await vi.advanceTimersByTimeAsync(0)
    expect(asked.done).toBe(true)
    expect(asked.value?.title).toBe('Switch with 1 job not sent yet?')
  })

  test('a switch says apart those needing a look: they don’t go by themselves (X7)', () => {
    const goes = itemFor('u1')
    const look = itemFor('u1', { state: 'needsLook' })
    expect(switchQuestion([look], 2_000)?.body).toBe(
      'It stays on this phone, and needs a look in Pest Co before it goes.',
    )
    expect(switchQuestion([look, look], 2_000)?.body).toBe(
      'They stay on this phone, and need a look in Pest Co before they go.',
    )
    expect(switchQuestion([goes, look], 2_000)?.body).toBe(
      'They stay on this phone. 1 goes when you’re back in Pest Co with signal, and 1 needs a look before it goes.',
    )
    expect(switchQuestion([goes, goes, look, look], 2_000)?.body).toBe(
      'They stay on this phone. 2 go when you’re back in Pest Co with signal, and 2 need a look before they go.',
    )
  })

  test('…and so one still waiting that was kept too long to go by itself: it needs a look once back (D23)', async () => {
    // Saved at 1 s; three days and a second on, with the line down all that
    // time, it is still waiting, and the sender won't send it.
    const later = 1_000 + STALE_AFTER_MS + 1_000
    const kept = itemFor('u1')
    expect(switchQuestion([kept], later)?.body).toBe(
      'It stays on this phone, and needs a look in Pest Co before it goes.',
    )
    expect(switchQuestion([kept, itemFor('u1', {}, later)], later)?.body).toBe(
      'They stay on this phone. 1 goes when you’re back in Pest Co with signal, and 1 needs a look before it goes.',
    )
    // The question a switch asks reads the time as it asks.
    expect(
      (
        await leaveQuestion(
          'switchBusiness',
          factsOf(() => [kept], { now: () => later }),
        )
      )?.body,
    ).toBe(
      'It stays on this phone, and needs a look in Pest Co before it goes.',
    )
  })

  test('a send of this tab’s that is out is waited on, up to 4 s, before counting (S22e)', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const item = itemFor('u1', { state: 'sending' })
    // Its answer comes at 2 s: sent.
    const facts = factsOf(
      () =>
        Date.now() - start >= 2_000 ? [{ ...item, state: 'sent' }] : [item],
      { inflight: () => (Date.now() - start >= 2_000 ? 0 : 1) },
    )
    const asked = watch(leaveQuestion('signOut', facts))
    await vi.advanceTimersByTimeAsync(1_900)
    expect(asked.done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(asked.done).toBe(true)
    expect(asked.value).toBeNull()
  })

  test('…and with no answer by then, it counts it, as maybe gone', async () => {
    vi.useFakeTimers()
    const item = itemFor('u1', { state: 'sending' })
    const facts = factsOf(() => [item], { inflight: () => 1 })
    const asked = watch(leaveQuestion('signOut', facts))
    await vi.advanceTimersByTimeAsync(LEAVE_SEND_WAIT_MS - 1)
    expect(asked.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(asked.value?.body).toBe(
      'It’s only on this phone. It may already have gone — check the schedule when you’re back.',
    )
  })
})

describe('the guard (`leaveGuardFor`)', () => {
  test('nothing to ask: goes, asking nobody', async () => {
    const show = vi.fn((_question: LeaveQuestion): Promise<boolean> =>
      Promise.reject(new Error('not asked')),
    )
    const guard = leaveGuardFor(
      factsOf(() => []),
      show,
    )
    expect(await guard('signOut')).toBe(true)
    expect(show).not.toHaveBeenCalled()
  })

  test('goes with the person’s answer: Discard and sign out → true, Stay signed in → false', async () => {
    const facts = factsOf(() => [itemFor('u1')])
    const asked: Array<string> = []
    const yes = leaveGuardFor(facts, async (q) => {
      asked.push(q.title)
      return true
    })
    const no = leaveGuardFor(facts, async () => false)
    expect(await yes('signOut')).toBe(true)
    expect(asked).toEqual(['Sign out and discard 1 job not sent yet?'])
    expect(await no('signOut')).toBe(false)
  })

  test('a second ask while one is out is answered stay', async () => {
    let answer: (go: boolean) => void = () => {}
    const guard = leaveGuardFor(
      factsOf(() => [itemFor('u1')]),
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    const first = guard('signOut')
    expect(await guard('switchBusiness')).toBe(false)
    // Let the first ask reach its question.
    await new Promise((resolve) => setTimeout(resolve, 0))
    answer(true)
    expect(await first).toBe(true)
    // Answered, it asks again.
    const third = guard('signOut')
    await new Promise((resolve) => setTimeout(resolve, 0))
    answer(false)
    expect(await third).toBe(false)
  })

  test('a sign-out holds every tab’s sends while it counts and from a yes, and only this tab’s while the question is up (F0)', async () => {
    const order: Array<string> = []
    let n = 0
    const holdSends = vi.fn(async (_waitMs: number) => {
      const which = ++n
      order.push(`every tab ${which}`)
      return () => order.push(`every tab ${which} let go`)
    })
    const holdHere = vi.fn(() => {
      order.push('here')
      return () => order.push('here let go')
    })
    const facts = factsOf(() => [itemFor('u1')], {
      holdSends,
      holdHere,
      readFresh: async () => {
        order.push('read')
        return true
      },
    })
    const yes = leaveGuardFor(facts, async () => {
      order.push('asked')
      return true
    })
    expect(await yes('signOut')).toBe(true)
    expect(holdSends).toHaveBeenCalledWith(LEAVE_SEND_WAIT_MS)
    expect(holdSends).toHaveBeenCalledTimes(2)
    // Every tab's held again from the yes, counted afresh under it, and
    // past it, until the sign-out has discarded them in the same turn.
    expect(order).toEqual([
      'every tab 1',
      'read',
      'here',
      'every tab 1 let go',
      'asked',
      'every tab 2',
      'here let go',
      'read',
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order.at(-1)).toBe('every tab 2 let go')

    // A no lets this tab's go at once, and holds no other tab's again.
    order.length = 0
    const no = leaveGuardFor(facts, async () => {
      order.push('asked')
      return false
    })
    expect(await no('signOut')).toBe(false)
    expect(order).toEqual([
      'every tab 3',
      'read',
      'here',
      'every tab 3 let go',
      'asked',
      'here let go',
    ])

    // A switch holds nothing: what it leaves is kept whatever it is.
    holdSends.mockClear()
    holdHere.mockClear()
    await leaveGuardFor(facts, async () => true)('switchBusiness')
    expect(holdSends).not.toHaveBeenCalled()
    expect(holdHere).not.toHaveBeenCalled()
  })

  test('answered yes, it counts from a fresh read: what another tab sent and began sending, unheard of here, is asked about again (F7)', async () => {
    // X going and Y waiting as the question comes up…
    const x = itemFor('u1', { state: 'sending' })
    const y = itemFor('u1')
    let onPhone: Array<OutboxItem> = [x, y]
    let heard = onPhone
    const asked: Array<string> = []
    const guard = leaveGuardFor(
      factsOf(() => heard, {
        readFresh: async () => {
          heard = onPhone
          return true
        },
      }),
      async (question) => {
        asked.push(`${question.title} / ${question.body}`)
        // …X answered in another tab, and Y begun there, before this tab
        // has heard of either.
        if (asked.length === 1) {
          onPhone = [
            { ...x, state: 'sent' },
            { ...y, state: 'sending' },
          ]
        }
        return true
      },
    )
    expect(await guard('signOut')).toBe(true)
    expect(asked).toEqual([
      'Sign out and discard 2 jobs not sent yet? / They’re only on this phone. 1 may already have gone — check the schedule when you’re back.',
      'Sign out and discard 1 job not sent yet? / It’s only on this phone. It may already have gone — check the schedule when you’re back.',
    ])
  })

  test('answered yes, it counts again, and asks again of what changed under the question (F7)', async () => {
    let items: Array<OutboxItem> = [itemFor('u1')]
    const asked: Array<LeaveQuestion> = []
    const guard = leaveGuardFor(
      factsOf(() => items),
      async (question) => {
        asked.push(question)
        // Another tab began sending it while the question was up.
        if (asked.length === 1) items = [{ ...items[0], state: 'sending' }]
        return true
      },
    )
    expect(await guard('signOut')).toBe(true)
    expect(asked.map((question) => question.body)).toEqual([
      'It’s only on this phone.',
      'It’s only on this phone. It may already have gone — check the schedule when you’re back.',
    ])
    expect(confirmedLeave()).toEqual(asked[1])
    // Read, it is forgotten.
    expect(confirmedLeave()).toBeNull()

    // Sent meanwhile: nothing is left to discard, so it goes without asking.
    items = [itemFor('u1')]
    let shown = 0
    const sent = leaveGuardFor(
      factsOf(() => items),
      async () => {
        shown++
        items = [{ ...items[0], state: 'sent' }]
        return true
      },
    )
    expect(await sent('signOut')).toBe(true)
    expect(shown).toBe(1)

    // Asked again, a no stays.
    items = [itemFor('u1')]
    const answers = [true, false]
    const again = leaveGuardFor(
      factsOf(() => items),
      async () => {
        items = [...items, itemFor('u1')]
        return answers.shift() ?? false
      },
    )
    expect(await again('signOut')).toBe(false)
  })

  test('what was confirmed is the generic question where the phone couldn’t be read (F22)', async () => {
    const guard = leaveGuardFor(
      factsOf(() => [], { readFresh: () => Promise.resolve(false) }),
      async () => true,
    )
    expect(await guard('signOut')).toBe(true)
    expect(confirmedLeave()).toBe(UNREADABLE_QUESTION)
    // A leave with nothing asked confirmed nothing.
    expect(
      await leaveGuardFor(
        factsOf(() => []),
        async () => true,
      )('signOut'),
    ).toBe(true)
    expect(confirmedLeave()).toBeNull()
  })
})

describe('the person’s bookings not sent yet by business (`unsentByBusiness`)', () => {
  test('those that go by themselves apart from those needing a look (F3)', () => {
    const by = unsentByBusiness(
      [
        itemFor('u1'),
        itemFor('u1', { state: 'sending' }),
        itemFor('u1', { state: 'needsLook' }),
        pestfolio({ state: 'needsLook' }),
        // Not the person's, and sent: not counted.
        itemFor('u2'),
        itemFor('u1', { state: 'sent' }),
      ],
      'u1',
      2_000,
    )
    expect(by.get(B1)).toEqual({ count: 2, needsLook: 1 })
    expect(by.get(B2)).toEqual({ count: 0, needsLook: 1 })
    expect(by.size).toBe(2)
  })

  test('one still waiting that was kept too long to go by itself counts as needing a look (D23)', () => {
    const later = 1_000 + STALE_AFTER_MS + 1_000
    const by = unsentByBusiness(
      [itemFor('u1'), itemFor('u1', {}, later), pestfolio()],
      'u1',
      later,
    )
    expect(by.get(B1)).toEqual({ count: 1, needsLook: 1 })
    expect(by.get(B2)).toEqual({ count: 0, needsLook: 1 })
  })
})

describe('what a sign-out that failed says (`signOutFailedWords`, D27)', () => {
  test('the discard stands, and it says so', () => {
    expect(signOutFailedWords(0)).toBe(
      'Could not sign out. Check your signal and try again.',
    )
    expect(signOutFailedWords(1)).toBe(
      'Could not sign out. Check your signal and try again. The job not sent yet was discarded.',
    )
    expect(signOutFailedWords(2)).toBe(
      'Could not sign out. Check your signal and try again. The 2 jobs not sent yet were discarded.',
    )
    // After the generic question it can't say how many (F22).
    expect(signOutFailedWords('unknown')).toBe(
      'Could not sign out. Check your signal and try again. Any jobs not sent yet on this phone were discarded.',
    )
  })

  test('one being sent as it went is never said to be discarded: its call is still out, so it may still be booked', () => {
    expect(signOutFailedWords(0, 1)).toBe(
      'Could not sign out. Check your signal and try again. The job being sent may still be booked — check the schedule before booking it again.',
    )
    expect(signOutFailedWords(0, 2)).toBe(
      'Could not sign out. Check your signal and try again. The 2 jobs being sent may still be booked — check the schedule before booking them again.',
    )
    expect(signOutFailedWords(1, 1)).toBe(
      'Could not sign out. Check your signal and try again. The job not sent yet was discarded. 1 being sent may still be booked — check the schedule before booking it again.',
    )
    expect(signOutFailedWords(2, 2)).toBe(
      'Could not sign out. Check your signal and try again. The 2 jobs not sent yet were discarded. 2 being sent may still be booked — check the schedule before booking them again.',
    )
    expect(signOutFailedWords('unknown', 1)).toBe(
      'Could not sign out. Check your signal and try again. Any jobs not sent yet on this phone were discarded. 1 being sent may still be booked — check the schedule before booking it again.',
    )
  })
})

describe('the sign-in screens’ line (`onPhoneLine`, over `peekOutbox`)', () => {
  test('whose they are, by the first name kept with them', async () => {
    setOutboxBackendForTests(
      await outboxOf('u1', [itemFor('u1'), itemFor('u2')], 'Kevin'),
    )
    const peek = await peekOutbox()
    expect(peek).not.toBe('error')
    if (peek === 'error') return
    expect(onPhoneLine(peek)).toBe(
      'Kevin has 1 job on this phone not sent yet. It’s kept until Kevin signs in again and sends it. Signing in as anyone else discards it.',
    )
  })

  test('with no first name kept: the person who booked them', async () => {
    setOutboxBackendForTests(
      await outboxOf('u1', [itemFor('u1'), itemFor('u1')], ''),
    )
    const peek = await peekOutbox()
    if (peek === 'error') throw new Error('unread')
    expect(onPhoneLine(peek)).toBe(
      'Jobs not sent yet are on this phone. They’re kept until the person who booked them signs in again and sends them. Signing in as anyone else discards them.',
    )
  })

  test('nothing once a sign-out has discarded them, nor for one sent', async () => {
    setOutboxBackendForTests(
      await outboxOf('u1', [itemFor('u1', {}, 1_000)], 'Kevin'),
    )
    writeSignOutTombstone('u1', 2_000)
    const discarded = await peekOutbox()
    if (discarded === 'error') throw new Error('unread')
    expect(onPhoneLine(discarded)).toBeNull()

    setOutboxBackendForTests(
      await outboxOf('u2', [itemFor('u2', { state: 'sent' })], 'Sam'),
    )
    const sent = await peekOutbox()
    if (sent === 'error') throw new Error('unread')
    expect(onPhoneLine(sent)).toBeNull()
  })
})
