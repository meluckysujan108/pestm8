import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KEPT_NOTES,
  adoptConnectionLog,
  deviceId,
  forgetConnectionLogForTests,
  logConnection,
  logConnectionSlower,
  markConnectionLogSent,
  msBand,
  unsentConnectionLog,
} from './connectionLog'

/** Just enough of `localStorage`, with what it holds open to the test. */
function memoryStorage() {
  const held = new Map<string, string>()
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  }
}

describe('connectionLog', () => {
  let storage: ReturnType<typeof memoryStorage>
  let doc: EventTarget & { visibilityState: string }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    storage = memoryStorage()
    doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    })
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('document', doc)
    vi.stubGlobal('localStorage', storage)
    forgetConnectionLogForTests()
  })

  afterEach(() => {
    forgetConnectionLogForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('hands over the oldest notes the server does not have, and moves on once it has them', () => {
    vi.setSystemTime(1_000)
    logConnection('shown', { away: 30_000 })
    logConnection('ws-dead', { why: 'silent' })
    logConnection('ws-open')

    const first = unsentConnectionLog(2)!
    expect(first.entries).toEqual([
      { t: 1_000, e: 'shown', d: { away: 30_000 } },
      { t: 1_000, e: 'ws-dead', d: { why: 'silent' } },
    ])
    markConnectionLogSent(first.through)

    expect(unsentConnectionLog(100)!.entries).toEqual([
      { t: 1_000, e: 'ws-open' },
    ])
    markConnectionLogSent(unsentConnectionLog(100)!.through)
    expect(unsentConnectionLog(100)).toBeNull()
  })

  it(`keeps the last ${KEPT_NOTES} notes`, () => {
    for (let n = 0; n < KEPT_NOTES + 20; n++) logConnection('tick', { n })
    const kept = unsentConnectionLog(1_000)!.entries
    expect(kept).toHaveLength(KEPT_NOTES)
    expect(kept[0]?.d).toEqual({ n: 20 })
  })

  it('keeps the notes across a reload, so the ones from before it can still go', () => {
    logConnection('notice', { why: 'socket' })
    logConnection('reload')
    vi.advanceTimersByTime(1_000)

    forgetConnectionLogForTests()
    expect(unsentConnectionLog(100)!.entries.map((entry) => entry.e)).toEqual([
      'notice',
      'reload',
    ])
  })

  it('writes them at once when the page goes off screen', () => {
    logConnection('hidden')
    expect(storage.held.size).toBe(0)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(storage.held.size).toBe(1)
  })

  it('carries on in memory when storage refuses', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    logConnection('shown')
    vi.advanceTimersByTime(1_000)
    expect(unsentConnectionLog(100)!.entries).toHaveLength(1)
    expect(deviceId()).toMatch(/.+/)
  })

  it('notes nothing outside a browser', () => {
    vi.unstubAllGlobals()
    logConnection('shown')
    expect(unsentConnectionLog(100)).toBeNull()
  })

  it("drops another person's unsent notes rather than sending them as this person's", () => {
    logConnection('before-anyone')
    adoptConnectionLog('user-terence')
    expect(unsentConnectionLog(100)!.entries.map((entry) => entry.e)).toEqual([
      'before-anyone',
    ])

    logConnection('terence-1')
    // Terence signs out, and Kevin signs in on the same browser.
    adoptConnectionLog('user-kevin')
    expect(unsentConnectionLog(100)).toBeNull()
    logConnection('kevin-1')
    expect(unsentConnectionLog(100)!.entries.map((entry) => entry.e)).toEqual([
      'kevin-1',
    ])
  })

  it('names the browser once, and keeps the name', () => {
    const name = deviceId()
    forgetConnectionLogForTests()
    expect(deviceId()).toBe(name)
  })
  it('says how long something took in bands: the power of two at or under it', () => {
    expect(
      [0.4, 1, 15.9, 16, 31.9, 32, 40, 63, 64, 1_000, 9_000].map(msBand),
    ).toEqual([0, 1, 8, 16, 16, 32, 32, 32, 64, 512, 4_096])
    expect(msBand(Number.NaN)).toBe(0)
  })

  it('notes a time only when it is slower than any of that kind noted on this page', () => {
    vi.setSystemTime(1_000)
    logConnection('ws-open')
    // A big book on a slow phone with no signal, typed into all morning:
    // each key a little slower or faster than the last.
    for (let key = 0; key < 270; key++) {
      logConnectionSlower('picker-filter', { rows: 8_000, ms: 40 + (key % 9) })
    }
    logConnectionSlower('picker-filter', { rows: 8_000, ms: 70 })
    logConnectionSlower('picker-filter', { rows: 8_000, ms: 50 })
    logConnectionSlower('match-index', { rows: 8_000, ms: 90.4 })
    logConnectionSlower('match-index', { rows: 8_010, ms: 96 })
    expect(unsentConnectionLog(KEPT_NOTES)!.entries).toEqual([
      { t: 1_000, e: 'ws-open' },
      { t: 1_000, e: 'picker-filter', d: { rows: 8_000, ms: 32 } },
      { t: 1_000, e: 'picker-filter', d: { rows: 8_000, ms: 64 } },
      { t: 1_000, e: 'match-index', d: { rows: 8_000, ms: 64 } },
    ])
    // A new page load says it afresh.
    forgetConnectionLogForTests()
    logConnectionSlower('picker-filter', { rows: 8_000, ms: 41 })
    expect(unsentConnectionLog(KEPT_NOTES)!.entries.at(-1)).toEqual({
      t: 1_000,
      e: 'picker-filter',
      d: { rows: 8_000, ms: 32 },
    })
  })
})
