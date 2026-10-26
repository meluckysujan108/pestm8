import { describe, expect, it, vi } from 'vitest'
import {
  GAP_MS,
  QUERY_WAIT_MS,
  REACH_START,
  REQUEST_WAIT_MS,
  SOCKET_DOWN_MS,
  drawNotice,
  noticeDrawn,
  noticeOverKept,
  oldestPending,
  reloadClockSince,
  sampleReach,
  savesWaiting,
  savesWaitingSince,
  subscribeNoticeDrawn,
  waitingOnScreen,
} from './reach'
import type { ReachNoticeModel, ReachSample, ReachState } from './reach'

const healthy: Omit<ReachSample, 'now'> = {
  visible: true,
  socketConnected: true,
  oldestRequestAt: null,
  oldestPendingQueryAt: null,
}

/** Samples once a second from `from` to `to` (ms), as ConnectionNotice does. */
function run(
  samples: (now: number) => Partial<ReachSample>,
  to: number,
  from = 0,
  start: ReachState = REACH_START,
) {
  let state = start
  let stuck = false
  for (let now = from; now <= to; now += 1_000) {
    ;({ state, stuck } = sampleReach(state, {
      ...healthy,
      now,
      ...samples(now),
    }))
  }
  return { state, stuck }
}

describe('sampleReach', () => {
  it('is not stuck while everything answers', () => {
    expect(run(() => ({}), 60_000).stuck).toBe(false)
  })

  it(`is stuck once the socket has been down ${SOCKET_DOWN_MS / 1000} s`, () => {
    const down = () => ({ socketConnected: false })
    expect(run(down, SOCKET_DOWN_MS - 1_000).stuck).toBe(false)
    expect(run(down, SOCKET_DOWN_MS).stuck).toBe(true)
  })

  it('starts the clock again when the socket comes back in between', () => {
    const flapping = (now: number) => ({
      socketConnected: now === 5_000,
    })
    // Down again from 6 s, so 8 s after that.
    expect(run(flapping, 13_000).stuck).toBe(false)
    expect(run(flapping, 14_000).stuck).toBe(true)
  })

  it('says which wait it is stuck on: the socket first, then a save, then a query', () => {
    const at = (overrides: Partial<ReachSample>) =>
      sampleReach(
        { visibleSince: 0, socketDownSince: 0, lastAt: 59_000 },
        { ...healthy, now: 60_000, ...overrides },
      ).why
    expect(at({})).toBeNull()
    expect(at({ oldestPendingQueryAt: 0 })).toBe('query')
    expect(at({ oldestPendingQueryAt: 0, oldestRequestAt: 0 })).toBe('save')
    expect(
      at({
        oldestPendingQueryAt: 0,
        oldestRequestAt: 0,
        socketConnected: false,
      }),
    ).toBe('socket')
  })

  it('is not stuck as soon as the socket is back', () => {
    const { state } = run(() => ({ socketConnected: false }), 20_000)
    expect(sampleReach(state, { ...healthy, now: 21_000 }).stuck).toBe(false)
  })

  it(`is stuck when a save has waited ${REQUEST_WAIT_MS / 1000} s for its answer`, () => {
    const saving = () => ({ oldestRequestAt: 2_000 })
    expect(run(saving, 2_000 + REQUEST_WAIT_MS - 1_000).stuck).toBe(false)
    expect(run(saving, 2_000 + REQUEST_WAIT_MS).stuck).toBe(true)
  })

  it(`is stuck when something on screen has had no data for ${QUERY_WAIT_MS / 1000} s`, () => {
    // A socket that says it is open, held for its token or dropped by a VPN
    // without either end hearing: only the waiting gives it away.
    const waiting = () => ({ oldestPendingQueryAt: 0 })
    expect(run(waiting, QUERY_WAIT_MS - 1_000).stuck).toBe(false)
    expect(run(waiting, QUERY_WAIT_MS).stuck).toBe(true)
  })

  it('never counts time the page was off screen', () => {
    const asleep = (now: number) => ({
      visible: now >= 60_000,
      socketConnected: false,
      oldestRequestAt: 0,
      oldestPendingQueryAt: 0,
    })
    expect(run(asleep, 59_000).stuck).toBe(false)
    // The phone wakes with a dead socket and a save from before it slept:
    // the clocks start from the wake.
    expect(run(asleep, 60_000 + SOCKET_DOWN_MS - 1_000).stuck).toBe(false)
    expect(run(asleep, 60_000 + SOCKET_DOWN_MS).stuck).toBe(true)
  })

  it('starts again after a gap in the samples, as after a wake it never heard about', () => {
    // A phone can freeze the page without telling it it was hidden: the
    // samples just stop, and the next comes minutes later with a dead socket.
    const { state } = run(() => ({ socketConnected: false }), 3_000)
    const woken = 3_000 + GAP_MS + 60_000
    const after = (now: number) =>
      sampleReach(state, {
        ...healthy,
        now,
        socketConnected: false,
        oldestRequestAt: 0,
      })
    expect(after(woken).stuck).toBe(false)
    expect(
      run(
        () => ({ socketConnected: false, oldestRequestAt: 0 }),
        woken + SOCKET_DOWN_MS,
        woken,
        after(woken).state,
      ).stuck,
    ).toBe(true)
  })

  it('a slow sample now and then is not a gap', () => {
    const lagging = (now: number) => ({ socketConnected: now > 0 })
    let state = run(lagging, 4_000).state
    state = sampleReach(state, { ...healthy, now: 4_000 + GAP_MS }).state
    expect(state.visibleSince).toBe(0)
  })

  it('forgets everything when the page goes off screen', () => {
    const { state } = run(() => ({ socketConnected: false }), 20_000)
    expect(
      sampleReach(state, { ...healthy, now: 21_000, visible: false }),
    ).toEqual({ state: REACH_START, stuck: false, why: null })
  })
})

describe('oldestPending', () => {
  it('remembers when each was first seen, and forgets those that answered', () => {
    const seen = new Map<string, number>()
    expect(oldestPending(seen, [], 0)).toBeNull()
    expect(oldestPending(seen, ['a'], 1_000)).toBe(1_000)
    expect(oldestPending(seen, ['a', 'b'], 2_000)).toBe(1_000)
    expect(oldestPending(seen, ['b'], 3_000)).toBe(2_000)
    expect([...seen.keys()]).toEqual(['b'])
    // Asked for again after it answered: a new wait.
    expect(oldestPending(seen, ['a', 'b'], 4_000)).toBe(2_000)
    expect(oldestPending(seen, ['a'], 5_000)).toBe(4_000)
  })
})

describe('waitingOnScreen', () => {
  it('counts answers from the phone’s copy the server hasn’t confirmed', () => {
    expect(waitingOnScreen(['a'], ['k1', 'k2'])).toEqual(['a', 'k1', 'k2'])
    expect(waitingOnScreen([], [])).toEqual([])
  })

  it('a query the copy answered while it waited keeps its wait', () => {
    const seen = new Map<string, number>()
    // Asked for with no answer, then answered from the phone, unconfirmed.
    expect(oldestPending(seen, waitingOnScreen(['d'], []), 1_000)).toBe(1_000)
    expect(oldestPending(seen, waitingOnScreen([], ['d']), 5_000)).toBe(1_000)
    expect(oldestPending(seen, waitingOnScreen(['d'], ['d']), 6_000)).toBe(
      1_000,
    )
    // Confirmed by the server: no longer waiting.
    expect(oldestPending(seen, waitingOnScreen([], []), 7_000)).toBeNull()
  })

  it('an unconfirmed copy over a socket that never answers raises the notice', () => {
    const seen = new Map<string, number>()
    const { stuck } = run(
      (now) => ({
        oldestPendingQueryAt: oldestPending(
          seen,
          waitingOnScreen([], ['k']),
          now,
        ),
      }),
      QUERY_WAIT_MS,
    )
    expect(stuck).toBe(true)
  })
})

describe('a change waiting to save', () => {
  it('is never only the outbox’s own sends, which a reload loses none of', () => {
    // The Convex client counts the outbox's call among its own…
    expect(savesWaiting(1, 1)).toBe(false)
    expect(savesWaiting(2, 2)).toBe(false)
    // …and a save of anything else beside it still counts.
    expect(savesWaiting(2, 1)).toBe(true)
    expect(savesWaiting(1, 0)).toBe(true)
    expect(savesWaiting(0, 0)).toBe(false)
  })

  it('is timed from when one was first seen, and not at all while only the outbox’s wait', () => {
    let since: number | null = null
    since = savesWaitingSince(since, savesWaiting(1, 1), 1_000)
    expect(since).toBeNull()
    since = savesWaitingSince(since, savesWaiting(2, 1), 2_000)
    expect(since).toBe(2_000)
    since = savesWaitingSince(since, savesWaiting(2, 1), 3_000)
    expect(since).toBe(2_000)
    since = savesWaitingSince(since, savesWaiting(1, 1), 4_000)
    expect(since).toBeNull()
  })
})

describe('noticeOverKept', () => {
  const notice = (
    overrides: Partial<ReachNoticeModel> = {},
  ): ReachNoticeModel => ({
    online: false,
    waitingToSave: false,
    updated: '9:42am',
    action: 'try',
    onTry: () => {},
    onReload: () => {},
    onDismiss: () => {},
    ...overrides,
  })

  it('gives way to a line saying the screen is the kept copy, while only reads wait', () => {
    expect(noticeOverKept(notice(), true)).toBeNull()
    expect(noticeOverKept(notice({ online: true }), true)).toBeNull()
    expect(
      noticeOverKept(notice({ online: true, action: 'reload' }), true),
    ).toBeNull()
  })

  it('never while a change is waiting to save: only it says a reload loses that', () => {
    const saving = notice({ waitingToSave: true })
    expect(noticeOverKept(saving, true)).toBe(saving)
    const confirm = notice({
      online: true,
      waitingToSave: true,
      action: 'reload-confirm',
    })
    expect(noticeOverKept(confirm, true)).toBe(confirm)
  })

  it('is the notice as decided where no such line shows', () => {
    const up = notice()
    expect(noticeOverKept(up, false)).toBe(up)
    expect(noticeOverKept(null, false)).toBeNull()
    expect(noticeOverKept(null, true)).toBeNull()
  })
})

describe('the wait before Reload is offered (`reloadClockSince`)', () => {
  it('starts as the notice is first up with signal and drawn, and is kept while it is', () => {
    expect(reloadClockSince(null, true, 1_000)).toBe(1_000)
    expect(reloadClockSince(1_000, true, 40_000)).toBe(1_000)
  })

  it('starts again from Try again once it stops: no signal, or held back by a kept line everywhere', () => {
    expect(reloadClockSince(1_000, false, 40_000)).toBeNull()
    expect(reloadClockSince(null, false, 40_000)).toBeNull()
    // Shown again after a hold: timed from then, not from when it went up.
    expect(reloadClockSince(null, true, 70_000)).toBe(70_000)
  })
})

describe('where the notice is drawn (`drawNotice`)', () => {
  it('counts while any place draws it, and once each however often it is let go', () => {
    expect(noticeDrawn()).toBe(false)
    const banner = drawNotice()
    const sheet = drawNotice()
    banner()
    banner()
    expect(noticeDrawn()).toBe(true)
    sheet()
    expect(noticeDrawn()).toBe(false)
  })

  it('tells its listeners only as it starts and stops being drawn anywhere', () => {
    const heard = vi.fn()
    const stop = subscribeNoticeDrawn(heard)
    const banner = drawNotice()
    const sheet = drawNotice()
    expect(heard).toHaveBeenCalledTimes(1)
    banner()
    expect(heard).toHaveBeenCalledTimes(1)
    sheet()
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    drawNotice()()
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
