import { describe, expect, it } from 'vitest'
import { importable, indexExisting, statusOf } from '#/lib/clientImport/convert'
import { newlySent, recheckReview, undoneIds, undoneSince } from './recheck'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { ReviewClient } from '#/lib/clientImport/types'

/**
 * A review built while an import's clients were still in PestM8, read
 * again once that import has been undone from another screen: what it
 * called already here goes in after all, and nothing the person changed
 * in the review is lost on the way.
 */

const WA = 'WA'

function client(key: string, over: Partial<ReviewClient> = {}): ReviewClient {
  return {
    key,
    rowNumbers: [Number(key.slice(1))],
    kind: 'person',
    name: `Client ${key}`,
    phone: '0412 345 678',
    sites: [
      {
        addressLine: `${key.slice(1)} Wattle Street`,
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
      },
    ],
    issues: [],
    included: true,
    ...over,
  }
}

/** PestM8 with the undone import's clients in it: Client c1 and its site. */
const BEFORE = {
  businessState: WA,
  existing: indexExisting(
    [{ _id: 'k1' as Id<'clients'>, name: 'Client c1' }],
    [
      {
        addressLine: '1 Wattle Street',
        suburb: 'Bayswater',
        postcode: '6053',
        clientId: 'k1' as Id<'clients'>,
      },
    ],
  ),
}
/** And once the undo is done: nothing. */
const AFTER = { businessState: WA, existing: indexExisting([], []) }

describe('noticing an undo since the review was read', () => {
  const standing = { _id: 'i1' }
  const undoneLongAgo = { _id: 'i2', undoneAt: 1_000 }

  it('goes by which imports have been asked to be undone', () => {
    const read = undoneIds([standing, undoneLongAgo])
    expect([...read]).toEqual(['i2'])
    expect(undoneSince([standing, undoneLongAgo], read)).toBe(false)
    // Undone since, running or already done: the page may never have seen
    // it running.
    expect(undoneSince([{ ...standing, undoneAt: 9_000 }], read)).toBe(true)
    // An import made since, standing, changes nothing here.
    expect(undoneSince([{ _id: 'i3' }, undoneLongAgo], read)).toBe(false)
    expect(undoneSince(undefined, read)).toBe(false)
  })

  it('counts every undo as since when the list wasn’t to hand at the read', () => {
    expect(undoneSince([undoneLongAgo], undoneIds(undefined))).toBe(true)
  })
})

describe('reading PestM8 again once the undo is done', () => {
  // Built while the undone import's clients were here.
  const built = recheckReview(
    [
      client('c1'),
      client('c2'),
      client('c3', { included: false }),
      client('c4', {
        sites: [
          {
            addressLine: '1 Wattle Street',
            suburb: 'Bayswater',
            state: 'WA',
            postcode: '6053',
          },
          {
            addressLine: '4 Wattle Street',
            suburb: 'Bayswater',
            state: 'WA',
            postcode: '6053',
          },
        ],
      }),
    ],
    BEFORE,
  )

  it('was built calling the undone import’s client and site already here', () => {
    const [c1, c2, , c4] = built
    expect(statusOf(c1)).toBe('duplicate')
    expect(c1.existingClientId).toBe('k1')
    expect(importable(c1)).toBe(false)
    expect(importable(c2)).toBe(true)
    expect(c4.sites.map((s) => s.duplicate === true)).toEqual([true, false])
    expect(c4.sites[0].heldBy).toBe('Client c1')
  })

  it('judges every client afresh, keeping what the person changed', () => {
    // Edited in the review before the undo finished: a new phone for c1,
    // and c3 still left out.
    const edited = built.map((c) =>
      c.key === 'c1' ? { ...c, phone: '0400 000 000' } : c,
    )
    const [c1, c2, c3, c4] = recheckReview(edited, AFTER)
    expect(c1.phone).toBe('0400 000 000')
    expect(c1.existingClientId).toBeUndefined()
    expect(c1.sites[0].duplicate).toBeUndefined()
    expect(importable(c1)).toBe(true)
    expect(c2).toEqual(built[1])
    expect(c3.included).toBe(false)
    expect(c4.sites.map((s) => s.duplicate === true)).toEqual([false, false])
    expect(c4.sites[0].heldBy).toBeUndefined()
  })

  it('names the clients now sending a site that was already here, for its address check', () => {
    const freed = newlySent(built, AFTER)
    expect(freed.map((c) => c.key)).toEqual(['c1', 'c4'])
    // Judged again already, ready to be checked.
    expect(freed[0].sites[0].duplicate).toBeUndefined()
    // Nothing is, while the undone import's sites are still here.
    expect(newlySent(built, BEFORE)).toEqual([])
  })
})
