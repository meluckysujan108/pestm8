import { beforeEach, describe, expect, test, vi } from 'vitest'
import { logConnection } from '#/lib/connectionLog'
import {
  checkKeptOwner,
  claimOwner,
  keptForSomeoneElse,
  mayWrite,
  notAMemberOf,
  notAMemberSlug,
  onKeptWiped,
  ownerChange,
  peekKept,
  setKeptBackendForTests,
  stampOwner,
  wipeKept,
  wipeKeptForBusiness,
} from './keptStore'
import {
  MemoryKeptBackend,
  claimFor,
  dayRow,
  keptFor,
} from './keptStore.fixtures'
import type { KeptOwner } from './keptStore'
import type * as KeptSet from './keptSet'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The copy of the schedule kept on the phone. What matters is that it is
 * only ever one person's, one business's and one view's, and that nothing
 * written for someone lands once they have gone: a write or stamp is
 * checked against the owner row inside its own transaction, so a wipe or a
 * new claim that gets there first refuses it.
 */

vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

/** Every operation queued so far has run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

function owner(extra: Partial<KeptOwner> = {}): KeptOwner {
  return {
    key: 'owner',
    ...claimFor('u1'),
    epoch: 'e1',
    claimedAt: 100,
    liveAt: 0,
    ...extra,
  }
}

beforeEach(() => {
  vi.mocked(logConnection).mockClear()
})

describe('what a claim changes', () => {
  test('the person first, then the business, then the view', () => {
    const current = owner()
    expect(ownerChange(null, claimFor('u1'))).toBe('user')
    expect(ownerChange(current, claimFor('u1'))).toBe('none')
    expect(
      ownerChange(
        current,
        claimFor('u2', { businessId: 'b2' as Id<'businesses'> }),
      ),
    ).toBe('user')
    expect(
      ownerChange(
        current,
        claimFor('u1', {
          businessId: 'b2' as Id<'businesses'>,
          lens: 'm-u1|everyone',
        }),
      ),
    ).toBe('business')
    expect(ownerChange(current, claimFor('u1', { lens: 'm-u1|mine' }))).toBe(
      'lens',
    )
    // Removed and invited back: a new membership is a new view.
    expect(
      ownerChange(
        current,
        claimFor('u1', { membershipId: 'm-new' as Id<'memberships'> }),
      ),
    ).toBe('lens')
  })

  test('nothing changed keeps the epoch, and takes the slug and time zone as they are now', () => {
    const { owner: next, changed } = claimOwner(
      owner({ liveAt: 500 }),
      claimFor('u1', { slug: 'renamed-co', timezone: 'Australia/Darwin' }),
      900,
      () => 'never',
    )
    expect(changed).toBe('none')
    expect(next).toEqual(
      owner({
        liveAt: 500,
        slug: 'renamed-co',
        timezone: 'Australia/Darwin',
      }),
    )
  })

  test('anything changed is a new epoch, never yet live, and keeps nothing else the caller sent', () => {
    const sent = { ...claimFor('u2'), extra: 'not kept' }
    const { owner: next, changed } = claimOwner(owner(), sent, 900, () => 'e2')
    expect(changed).toBe('user')
    expect(next).toEqual({
      key: 'owner',
      ...claimFor('u2'),
      epoch: 'e2',
      claimedAt: 900,
      liveAt: 0,
    })
  })

  test.each([
    ['lens', claimFor('u1', { lens: 'm-u1|mine' })],
    ['business', claimFor('u1', { businessId: 'b2' as Id<'businesses'> })],
    ['user', claimFor('u2')],
  ] as const)(
    'a change of %s clears the rows and starts a new epoch',
    async (changed, next) => {
      const backend = await keptFor('u1')
      const before = backend.owner?.epoch
      expect(backend.rows.size).toBe(1)

      const claimed = await backend.claim(next)
      expect(claimed?.changed).toBe(changed)
      expect(claimed?.epoch).not.toBe(before)
      expect(backend.rows.size).toBe(0)
      expect(backend.owner?.liveAt).toBe(0)
    },
  )

  test('the same claim again keeps the rows and the epoch', async () => {
    const backend = await keptFor('u1')
    const before = backend.owner?.epoch
    const claimed = await backend.claim(claimFor('u1'))
    expect(claimed).toEqual({ epoch: before, changed: 'none' })
    expect(backend.rows.size).toBe(1)
  })
})

describe('writes', () => {
  test('land for the epoch and person they were claimed for', async () => {
    const backend = new MemoryKeptBackend()
    const claimed = await backend.claim(claimFor('u1'))
    const epoch = claimed?.epoch ?? ''
    const row = dayRow('2026-10-26', 'm-u1|-')

    expect(await backend.write(epoch, 'u1', [row], [])).toBe(true)
    expect(backend.rows.get(row.hash)).toEqual(row)

    // Dropped and put together: the new one stays.
    const newer = { ...row, savedAt: 2_000 }
    const other = dayRow('2026-10-27', 'm-u1|-')
    await backend.write(epoch, 'u1', [other], [])
    expect(
      await backend.write(epoch, 'u1', [newer], [row.hash, other.hash]),
    ).toBe(true)
    expect([...backend.rows.values()]).toEqual([newer])
  })

  test('are refused for an epoch another claim has replaced', async () => {
    const backend = await keptFor('u1')
    const stale = backend.owner?.epoch ?? ''
    await backend.claim(claimFor('u1', { lens: 'm-u1|mine' }))

    expect(
      await backend.write(stale, 'u1', [dayRow('2026-10-26', 'm-u1|-')], []),
    ).toBe(false)
    expect(backend.rows.size).toBe(0)
  })

  test('are refused for anyone but the person the copy is', async () => {
    const backend = await keptFor('u1')
    const epoch = backend.owner?.epoch ?? ''
    expect(
      await backend.write(epoch, 'u2', [dayRow('2026-10-27', 'm-u2|-')], []),
    ).toBe(false)
    expect([...backend.rows.keys()]).toEqual(['listDay:2026-10-26'])
    expect(mayWrite(null, epoch, 'u1')).toBe(false)
  })

  test('a wipe between the check and the put loses the put', async () => {
    const backend = new MemoryKeptBackend()
    setKeptBackendForTests(backend)
    const claimed = await backend.claim(claimFor('u1'))
    const epoch = claimed?.epoch ?? ''

    // The writer has checked who is signed in and is about to write; the
    // person signs out in that moment.
    void wipeKept('sign-out')
    const wrote = await backend.write(
      epoch,
      'u1',
      [dayRow('2026-10-26', 'm-u1|-')],
      [],
    )

    expect(wrote).toBe(false)
    expect(backend.owner).toBeNull()
    expect(backend.rows.size).toBe(0)
  })

  test('a write already on its way when the wipe is asked for is wiped with the rest', async () => {
    const backend = new MemoryKeptBackend()
    setKeptBackendForTests(backend)
    const claimed = await backend.claim(claimFor('u1'))
    const writing = backend.write(
      claimed?.epoch ?? '',
      'u1',
      [dayRow('2026-10-26', 'm-u1|-')],
      [],
    )
    const wiping = wipeKept('sign-out')
    await Promise.all([writing, wiping])

    expect(backend.done).toEqual(['claim', 'write', 'wipe'])
    expect(backend.rows.size).toBe(0)
  })
})

describe('stamps', () => {
  test('say when everything was last live, and never move back', async () => {
    const backend = await keptFor('u1')
    const epoch = backend.owner?.epoch ?? ''

    expect(await backend.stamp(epoch, 'u1', 5_000)).toBe(true)
    expect(backend.owner?.liveAt).toBe(5_000)
    // Another tab, a moment behind.
    expect(await backend.stamp(epoch, 'u1', 4_000)).toBe(true)
    expect(backend.owner?.liveAt).toBe(5_000)
    expect(stampOwner(owner({ liveAt: 1 }), 2)).toEqual(owner({ liveAt: 2 }))
  })

  test('are refused for a replaced epoch, another person, or a wiped copy', async () => {
    const backend = await keptFor('u1')
    const epoch = backend.owner?.epoch ?? ''

    expect(await backend.stamp(epoch, 'u2', 5_000)).toBe(false)
    await backend.claim(claimFor('u1', { lens: 'm-u1|mine' }))
    expect(await backend.stamp(epoch, 'u1', 5_000)).toBe(false)
    expect(backend.owner?.liveAt).toBe(0)

    await backend.wipe()
    expect(await backend.stamp(backend.owner?.epoch ?? '', 'u1', 6_000)).toBe(
      false,
    )
    expect(backend.owner).toBeNull()
  })
})

describe('the page load’s read', () => {
  test('is made once, and noted', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    backend.done.length = 0

    const [first, second] = await Promise.all([peekKept(), peekKept()])
    expect(first).toBe(second)
    expect(first?.owner?.userId).toBe('u1')
    expect(first?.rows).toHaveLength(1)
    expect(backend.done).toEqual(['peek'])
    expect(logConnection).toHaveBeenCalledWith(
      'kept-peek',
      expect.objectContaining({ rows: 1, ok: true }),
    )
  })

  test('is null when the phone keeps nothing it can read', async () => {
    const backend = new MemoryKeptBackend()
    backend.unavailable = true
    setKeptBackendForTests(backend)
    expect(await peekKept()).toBeNull()
    expect(logConnection).toHaveBeenCalledWith(
      'kept-peek',
      expect.objectContaining({ rows: 0, ok: false }),
    )
  })

  test('hands out nothing once wiped, even a read that was under way', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    const reading = peekKept()
    void wipeKept('sign-out')

    expect(await reading).toEqual({ owner: null, rows: [] })
    expect(await peekKept()).toEqual({ owner: null, rows: [] })
  })
})

describe('wiping', () => {
  test('tells whoever holds a copy before anything is cleared, and notes why', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    const seen: Array<string | undefined> = []
    onKeptWiped(() => seen.push(backend.owner?.userId))

    const wiping = wipeKept('session-ended')
    // Told already, while the store still held the copy.
    expect(seen).toEqual(['u1'])
    expect(logConnection).toHaveBeenCalledWith('kept-wipe', {
      why: 'session-ended',
    })

    await wiping
    expect(backend.owner).toBeNull()
    expect(backend.rows.size).toBe(0)
  })

  test('tells every listener, whatever one of them does, until it stops listening', async () => {
    setKeptBackendForTests(new MemoryKeptBackend())
    const told: Array<string> = []
    onKeptWiped(() => {
      throw new Error('a page’s trouble')
    })
    const stop = onKeptWiped(() => told.push('second'))

    await wipeKept('sign-out')
    stop()
    await wipeKept('sign-out')
    expect(told).toEqual(['second'])
  })

  test('never rejects, though the phone refuses', async () => {
    const backend = new MemoryKeptBackend()
    backend.wipe = () => Promise.reject(new Error('quota'))
    setKeptBackendForTests(backend)
    await expect(wipeKept('sign-out')).resolves.toBeUndefined()
  })
})

describe('whose copy it is, once the page knows who is signed in', () => {
  test.each([
    ['the person who kept it', 'u1', 0],
    ['someone else', 'u2', 1],
    ['nobody', null, 1],
  ] as const)('%s (%s) signed in: %i wipes', async (_who, userId, wipes) => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)

    checkKeptOwner(userId)
    await peekKept()
    await settled()

    expect(backend.wipes).toBe(wipes)
    if (wipes > 0) {
      expect(logConnection).toHaveBeenCalledWith('kept-wipe', {
        why: userId === null ? 'signed-out' : 'other-person',
      })
    }
  })

  test('a phone that keeps nothing is left alone', async () => {
    const backend = new MemoryKeptBackend()
    setKeptBackendForTests(backend)
    checkKeptOwner(null)
    await peekKept()
    await settled()
    expect(backend.wipes).toBe(0)
  })

  test('once per person per page load', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    checkKeptOwner('u1')
    checkKeptOwner('u1')
    // Signed in on the join page, without a page load between them.
    checkKeptOwner('u2')
    checkKeptOwner('u2')
    await peekKept()
    await settled()
    expect(backend.done.filter((name) => name === 'peek')).toHaveLength(1)
    expect(backend.wipes).toBe(1)
  })

  test('rows with no owner row are nobody’s, and go', () => {
    const rows = [dayRow('2026-10-26', 'm-u1|-')]
    expect(keptForSomeoneElse({ owner: null, rows }, 'u1')).toBe(true)
    expect(keptForSomeoneElse({ owner: null, rows: [] }, 'u1')).toBe(false)
  })

  test('a copy it could not read goes only when nobody is signed in', () => {
    expect(keptForSomeoneElse(null, null)).toBe(true)
    expect(keptForSomeoneElse(null, 'u1')).toBe(false)
  })
})

describe('once the server says the person is not a member of a business', () => {
  test('wipes the copy if it is that business’s, reading only whose it is', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    backend.done.length = 0

    await wipeKeptForBusiness('pest-co', 'removed')

    expect(backend.done).toEqual(['whose', 'wipe'])
    expect(logConnection).toHaveBeenCalledWith('kept-wipe', { why: 'removed' })
  })

  test('leaves another business’s copy, and a phone that keeps nothing', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    await wipeKeptForBusiness('other-co', 'removed')
    setKeptBackendForTests(new MemoryKeptBackend())
    await wipeKeptForBusiness('pest-co', 'removed')
    expect(backend.wipes).toBe(0)
    expect(logConnection).not.toHaveBeenCalledWith('kept-wipe', {
      why: 'removed',
    })
  })

  test('wipes anyway when whose it is can’t be read', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    backend.whose = () => Promise.reject(new Error('blocked'))
    await wipeKeptForBusiness('other-co', 'removed')
    expect(backend.wipes).toBe(1)
  })

  test('or not in time: a stuck IndexedDB still loses the copy in memory', async () => {
    const backend = await keptFor('u1')
    setKeptBackendForTests(backend)
    backend.whose = () => new Promise(() => {})
    let told = false
    onKeptWiped(() => {
      told = true
    })
    vi.useFakeTimers()
    try {
      const wiping = wipeKeptForBusiness('other-co', 'removed')
      await vi.advanceTimersByTimeAsync(2_999)
      expect(told).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await wiping
      expect(told).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('the not-found says which business, and nothing else reads as one', () => {
    expect(notAMemberSlug(notAMemberOf('pest-co'))).toBe('pest-co')
    expect(notAMemberSlug(undefined)).toBeNull()
    expect(notAMemberSlug({ notAMemberOf: '' })).toBeNull()
    expect(notAMemberSlug({ notAMemberOf: 7 })).toBeNull()
    expect(notAMemberSlug('pest-co')).toBeNull()
  })
})

describe('with the kill switch off', () => {
  test('nothing is read, and whatever an earlier build kept is wiped on load', async () => {
    vi.resetModules()
    vi.doMock('./keptSet', async (original) => ({
      ...(await original<typeof KeptSet>()),
      KEPT_ENABLED: false,
    }))
    try {
      const store = await import('./keptStore')
      const backend = await keptFor('u1')
      store.setKeptBackendForTests(backend)
      backend.done.length = 0

      expect(await store.peekKept()).toBeNull()
      // Even for the person who kept it.
      store.checkKeptOwner('u1')
      store.checkKeptOwner('u1')
      await settled()

      expect(backend.done).toEqual(['wipe'])
      expect(backend.owner).toBeNull()
    } finally {
      vi.doUnmock('./keptSet')
      vi.resetModules()
    }
  })
})
