import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KEPT_NOTES,
  deviceId,
  forgetConnectionLogForTests,
  logConnection,
  markConnectionLogSent,
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

  it('names the browser once, and keeps the name', () => {
    const name = deviceId()
    forgetConnectionLogForTests()
    expect(deviceId()).toBe(name)
  })
})
