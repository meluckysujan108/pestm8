import { describe, expect, it } from 'vitest'
import {
  MAX_POSITIONS,
  POSITION_PREFIX,
  loadPosition,
  parsePosition,
  positionKey,
  positionsToDrop,
  savePosition,
  serialisePosition,
} from './readingPosition'
import type { StorageLike } from './readingPosition'

/**
 * Reopening a PDF where it was left. Everything here reads values a person or
 * an older build could have written, so the parser is the part that matters:
 * a bad value must come back as "no position", never as page NaN.
 */

function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>
} {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    },
  }
}

describe('serialise and parse', () => {
  it('round-trip a position', () => {
    const raw = serialisePosition({ page: 3, fraction: 0.25, zoom: 2.5 }, 1000)
    expect(parsePosition(raw)).toEqual({
      page: 3,
      fraction: 0.25,
      zoom: 2.5,
      savedAt: 1000,
    })
  })

  it('clamp a fraction or zoom out of range', () => {
    expect(parsePosition('{"p":2,"f":1.7,"z":40,"t":1}')).toMatchObject({
      fraction: 1,
      zoom: 5,
    })
    expect(parsePosition('{"p":2,"f":-1,"z":0.2,"t":1}')).toMatchObject({
      fraction: 0,
      zoom: 1,
    })
  })

  it('reject anything that is not a position', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '42',
      'null',
      '{"p":0,"f":0,"z":1}',
      '{"p":1.5,"f":0,"z":1}',
      '{"p":"3","f":0,"z":1}',
      '{"p":3,"f":null,"z":1}',
      '{"p":3,"f":0}',
    ]) {
      expect(parsePosition(raw)).toBeNull()
    }
  })

  it('treat a missing save time as the oldest', () => {
    expect(parsePosition('{"p":1,"f":0,"z":1}')?.savedAt).toBe(0)
  })
})

describe('positionsToDrop', () => {
  it('drops the least recently saved beyond the limit', () => {
    const entries = [
      { key: 'c', savedAt: 30 },
      { key: 'a', savedAt: 10 },
      { key: 'b', savedAt: 20 },
    ]
    expect(positionsToDrop(entries, 2)).toEqual(['a'])
    expect(positionsToDrop(entries, 3)).toEqual([])
  })
})

describe('save and load', () => {
  it('keeps one position per PDF', () => {
    const storage = fakeStorage()
    savePosition(
      storage,
      'https://x/a.pdf',
      { page: 4, fraction: 0.5, zoom: 1 },
      1,
    )
    savePosition(
      storage,
      'https://x/a.pdf',
      { page: 5, fraction: 0, zoom: 2 },
      2,
    )
    expect(loadPosition(storage, 'https://x/a.pdf')).toEqual({
      page: 5,
      fraction: 0,
      zoom: 2,
    })
    expect(loadPosition(storage, 'https://x/b.pdf')).toBeNull()
    expect(storage.data.size).toBe(1)
  })

  it(`never keeps more than ${MAX_POSITIONS}, dropping the oldest`, () => {
    const storage = fakeStorage({ unrelated: 'kept' })
    for (let i = 0; i < MAX_POSITIONS + 5; i++) {
      savePosition(storage, `pdf-${i}`, { page: 1, fraction: 0, zoom: 1 }, i)
    }
    const kept = [...storage.data.keys()].filter((k) =>
      k.startsWith(POSITION_PREFIX),
    )
    expect(kept).toHaveLength(MAX_POSITIONS)
    expect(kept).not.toContain(positionKey('pdf-0'))
    expect(kept).toContain(positionKey(`pdf-${MAX_POSITIONS + 4}`))
    expect(storage.data.get('unrelated')).toBe('kept')
  })

  it('shrugs off storage that throws, or none at all', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
      key: () => null,
      length: 0,
    }
    expect(() =>
      savePosition(throwing, 'k', { page: 1, fraction: 0, zoom: 1 }, 1),
    ).not.toThrow()
    expect(loadPosition(throwing, 'k')).toBeNull()
    expect(loadPosition(null, 'k')).toBeNull()
  })
})
