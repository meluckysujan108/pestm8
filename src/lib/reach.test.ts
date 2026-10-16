import { describe, expect, it } from 'vitest'
import {
  GAP_MS,
  QUERY_WAIT_MS,
  REACH_START,
  REQUEST_WAIT_MS,
  SOCKET_DOWN_MS,
  oldestPending,
  sampleReach,
} from './reach'
import type { ReachSample, ReachState } from './reach'

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
    ).toEqual({ state: REACH_START, stuck: false })
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
