import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { logConnection } from '#/lib/connectionLog'
import { FakeIndexedDb } from './fakeIndexedDb.fixtures'
import { OUTBOX_V } from './outboxItem'
import {
  EDIT_LEASE_MS,
  PEEK_RETRY_MS,
  PEEK_TIMEOUT_MS,
  STALE_AFTER_MS,
  STORE_OP_MS,
  isStale,
} from './outboxSet'
import {
  adoptChange,
  answeredChange,
  beginEditChange,
  beginSendChange,
  changeOutboxItem,
  checkOutboxOwner,
  claimDecision,
  confirmStaleChange,
  discardChange,
  endEditChange,
  forgetSentChange,
  idbOutboxBackend,
  keepOutboxItem,
  markSessionEnded,
  newRequestIdChange,
  onOutboxChanged,
  onOutboxWiped,
  outboxEpoch,
  outboxReadable,
  peekOutbox,
  preSendChange,
  readOutboxNow,
  renewEditChange,
  replaceChange,
  resultChange,
  retryOutbox,
  setOutboxBackendForTests,
  stillKept,
  tombstoned,
  unlockChange,
  wipeOutbox,
  wipeOutboxForBusiness,
  wipeOutboxWhere,
  writeSignOutTombstone,
} from './outboxStore'
import {
  B1,
  B2,
  DISPLAY,
  MemoryOutboxBackend,
  SESSION,
  bookingFor,
  itemFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import type { Id } from '../../../convex/_generated/dataModel'
import type { OutboxItem } from './outboxItem'
import type { OutboxBackend } from './outboxStore'

/**
 * The bookings kept on the phone. What matters: the database always opens,
 * whatever version a later build left it at, and is never deleted; every
 * change is guarded inside its own transaction, so nothing is sent twice,
 * edited while it may be booked, or brought back once it has gone; storage
 * that fails or hangs is an error, never a refusal; and a sign-out's
 * discard holds from the moment it is asked, whatever the wipe does.
 */

vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

/** Every operation queued so far has run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const DB = 'pestm8-outbox'
const NOW = 1_000_000

let storage: Storage

beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.mocked(logConnection).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A page load whose outbox is `backend`, claimed for `userId`. */
async function pageFor(backend: OutboxBackend, userId: string | null) {
  setOutboxBackendForTests(backend)
  checkOutboxOwner(userId === null ? null : personOf(userId))
  for (let i = 0; i < 5; i++) await settled()
}

function notes(event: string): Array<unknown> {
  return vi
    .mocked(logConnection)
    .mock.calls.filter(([what]) => what === event)
    .map(([, details]) => details)
}

describe('opening the database', () => {
  let fake: FakeIndexedDb

  beforeEach(() => {
    fake = new FakeIndexedDb()
    vi.stubGlobal('indexedDB', fake)
  })

  test('a new one is made at version 1 with both stores, by an open that gives no version', async () => {
    expect(await idbOutboxBackend.peek()).toEqual({ owner: null, items: [] })
    expect(fake.opens).toEqual([undefined])
    const db = fake.databases.get(DB)
    expect(db?.version).toBe(1)
    expect([...(db?.stores.keys() ?? [])].sort()).toEqual(['items', 'owner'])
    expect(db?.stores.get('items')?.keyPath).toBe('localId')
    expect([...(db?.stores.get('items')?.indexes ?? [])]).toEqual([
      'byBusiness',
    ])
    expect(fake.deletes).toEqual([])
  })

  test('an empty version 1, made by an open with no stores, is repaired at version 2, and the next open reads it', async () => {
    fake.seed(DB, 1, {})

    const claimed = await idbOutboxBackend.claim(personOf('u1'), NOW)
    expect(claimed).not.toBe('error')
    expect(fake.opens).toEqual([undefined, 2])
    expect(fake.databases.get(DB)?.version).toBe(2)

    const read = await idbOutboxBackend.peek()
    expect(read !== 'error' && read.owner?.userId).toBe('u1')
    // Opened as it is: no upgrade, and no fixed version.
    expect(fake.opens).toEqual([undefined, 2, undefined])
    expect(fake.databases.get(DB)?.version).toBe(2)
    expect(fake.deletes).toEqual([])
  })

  test('a database a later build left at version 3 opens, and its items show', async () => {
    const item = itemFor('u1')
    fake.seed(DB, 3, {
      owner: {
        keyPath: 'key',
        rows: [
          {
            key: 'owner',
            userId: 'u1',
            firstName: 'Kevin',
            epoch: 'e1',
            lastSeenAt: 1,
            sessionId: 's1',
          },
        ],
      },
      items: { keyPath: 'localId', rows: [item] },
      // A store this build knows nothing of.
      flags: { keyPath: 'localId' },
    })

    const read = await idbOutboxBackend.peek()
    expect(read).toEqual({
      owner: {
        key: 'owner',
        userId: 'u1',
        firstName: 'Kevin',
        epoch: 'e1',
        lastSeenAt: 1,
        sessionId: 's1',
      },
      items: [item],
    })
    expect(fake.opens).toEqual([undefined])
    expect(fake.databases.get(DB)?.version).toBe(3)
    expect(fake.deletes).toEqual([])
  })

  test('which an open at a fixed version could never have done', async () => {
    fake.seed(DB, 3, {})
    const refused = await new Promise<string>((resolve) => {
      const request = fake.open(DB, 1)
      request.onsuccess = () => resolve('opened')
      request.onerror = () => resolve(String((request.error as Error).name))
    })
    expect(refused).toBe('VersionError')
  })

  test('a later build’s layout missing one of this build’s stores gets it at the next version, and keeps what is there', async () => {
    const item = itemFor('u1')
    fake.seed(DB, 3, { items: { keyPath: 'localId', rows: [item] } })

    const read = await idbOutboxBackend.peek()
    expect(read !== 'error' && read.items).toEqual([item])
    expect(fake.opens).toEqual([undefined, 4])
    expect([...(fake.databases.get(DB)?.stores.keys() ?? [])].sort()).toEqual([
      'items',
      'owner',
    ])
    expect(fake.deletes).toEqual([])
  })

  test('a layout with the owner but no items store gets the items store, and keeps the owner', async () => {
    const owner = {
      key: 'owner',
      userId: 'u1',
      firstName: 'Kevin',
      epoch: 'e1',
      lastSeenAt: 1,
      sessionId: 's1',
    }
    fake.seed(DB, 3, { owner: { keyPath: 'key', rows: [owner] } })

    const read = await idbOutboxBackend.peek()
    expect(read).toEqual({ owner, items: [] })
    expect(fake.opens).toEqual([undefined, 4])
  })

  test('an upgrade another tab holds up is an error, and the connection that comes late is closed at once', async () => {
    fake.seed(DB, 1, {})
    fake.blockUpgrades = true
    expect(await idbOutboxBackend.peek()).toBe('error')
    expect(fake.opens).toEqual([undefined, 2])

    fake.unblock()
    await settled()
    expect(fake.openConnections).toBe(0)
    // And the next open finds it repaired.
    expect(await idbOutboxBackend.peek()).toEqual({ owner: null, items: [] })
  })

  test('a commit that fails after the decision (a full disk, say) is an error, and writes nothing', async () => {
    const claimed = await idbOutboxBackend.claim(personOf('u1'), NOW)
    if (claimed === 'error') throw new Error('claim failed')
    fake.failCommits = true
    expect(
      await idbOutboxBackend.keep(claimed.owner.epoch, itemFor('u1')),
    ).toBe('error')
    fake.failCommits = false
    const read = await idbOutboxBackend.peek()
    expect(read !== 'error' && read.items).toEqual([])
  })

  test('a claim for someone else clears rows no build can read, too', async () => {
    fake.seed(DB, 1, {
      owner: {
        keyPath: 'key',
        rows: [
          {
            key: 'owner',
            userId: 'u1',
            firstName: 'Kevin',
            epoch: 'e1',
            lastSeenAt: 1,
            sessionId: 's1',
          },
        ],
      },
      items: {
        keyPath: 'localId',
        rows: [itemFor('u1'), { localId: 'junk', note: 'no envelope' }],
      },
    })
    expect(
      await idbOutboxBackend.claim(personOf('u2', 'Sam'), NOW),
    ).toMatchObject({ dropped: 1 })
    expect(fake.databases.get(DB)?.stores.get('items')?.rows.size).toBe(0)
  })

  test('with no IndexedDB at all, nothing can have been kept', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await idbOutboxBackend.peek()).toEqual({ owner: null, items: [] })
    expect(await idbOutboxBackend.claim(personOf('u1', ''), NOW)).toBe('error')
  })

  test('IndexedDB makes the same decisions as the memory store: keep, a guarded change, a discard with what was booked after it, a wipe', async () => {
    const claimed = await idbOutboxBackend.claim(personOf('u1'), NOW)
    if (claimed === 'error') throw new Error('claim failed')
    const epoch = claimed.owner.epoch
    const parent = itemFor('u1')
    const child = itemFor('u1', { dependsOn: parent.localId })
    const other = itemFor('u1')
    for (const item of [parent, child, other]) {
      expect(await idbOutboxBackend.keep(epoch, item)).toBe('kept')
    }
    expect(await idbOutboxBackend.keep('stale', itemFor('u1'))).toBe('refused')

    const sending = await idbOutboxBackend.update(
      epoch,
      other.localId,
      beginSendChange(NOW),
    )
    expect(sending !== 'error' && sending !== 'gone' && sending).toMatchObject({
      state: 'sending',
      attempts: 1,
    })
    expect(await idbOutboxBackend.keep(epoch, other)).toBe('exists')
    expect(
      await idbOutboxBackend.update(
        epoch,
        other.localId,
        beginEditChange('t', NOW),
      ),
    ).toBe('refused')

    expect(
      await idbOutboxBackend.update(epoch, parent.localId, discardChange()),
    ).toBe('deleted')
    const read = await idbOutboxBackend.peek()
    expect(read !== 'error' && read.items.map((i) => i.localId)).toEqual([
      other.localId,
    ])
    expect(
      await idbOutboxBackend.update(epoch, parent.localId, unlockChange(NOW)),
    ).toBe('gone')

    expect(await idbOutboxBackend.wipe()).toBe(1)
    expect(await idbOutboxBackend.peek()).toEqual({ owner: null, items: [] })
  })

  test('a change that throws is an error, and writes nothing', async () => {
    const claimed = await idbOutboxBackend.claim(personOf('u1'), NOW)
    if (claimed === 'error') throw new Error('claim failed')
    const item = itemFor('u1')
    await idbOutboxBackend.keep(claimed.owner.epoch, item)

    const result = await idbOutboxBackend.update(
      claimed.owner.epoch,
      item.localId,
      () => {
        throw new Error('bug')
      },
    )
    expect(result).toBe('error')
    const read = await idbOutboxBackend.peek()
    expect(read !== 'error' && read.items).toEqual([item])
  })
})

describe('claims', () => {
  test('nobody’s yet: a new epoch, and anyone else’s items go', async () => {
    const backend = new MemoryOutboxBackend()
    const mine = itemFor('u1')
    const theirs = itemFor('u2')
    backend.items.set(mine.localId, mine)
    backend.items.set(theirs.localId, theirs)

    const claimed = await backend.claim(personOf('u1'), NOW)
    expect(claimed).toMatchObject({
      owner: { userId: 'u1', firstName: 'Kevin', lastSeenAt: NOW },
      dropped: 1,
    })
    expect([...backend.items.keys()]).toEqual([mine.localId])
  })

  test('theirs already: the same epoch and items, seen again now, with the first name the sign-in gave', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    const before = backend.owner?.epoch

    await backend.claim(personOf('u1', 'Kev'), NOW)
    expect(backend.owner).toEqual({
      key: 'owner',
      userId: 'u1',
      firstName: 'Kev',
      epoch: before,
      lastSeenAt: NOW,
      sessionId: SESSION,
    })
    expect(backend.items.size).toBe(1)

    // A sign-in that didn't say keeps the name the last one did.
    await backend.claim(personOf('u1', ''), NOW + 1)
    expect(backend.owner?.firstName).toBe('Kev')
  })

  test('someone else’s: a new epoch, and every item goes', async () => {
    const backend = await outboxOf('u1', [itemFor('u1'), itemFor('u1')])
    const before = backend.owner?.epoch

    const claimed = await backend.claim(personOf('u2', 'Sam'), NOW)
    expect(claimed).toMatchObject({ dropped: 2 })
    expect(backend.owner?.epoch).not.toBe(before)
    expect(backend.owner?.firstName).toBe('Sam')
    expect(backend.items.size).toBe(0)
  })

  test('theirs, in another session: that one ended with no sign-out here, so their bookings wait for their say-so', async () => {
    const waiting = itemFor('u1')
    const sending = itemFor('u1', { state: 'sending' })
    const sent = itemFor('u1', { state: 'sent' })
    const newer = itemFor('u1', { v: OUTBOX_V + 1 })
    const earlier = itemFor('u1', { sessionEndedAt: 5 })
    const answered = itemFor('u1', { sessionEndedAt: 5, confirmedAt: 6 })
    // Someone else's, left behind: never this person's to mark.
    const theirs = itemFor('u2')
    const backend = await outboxOf('u1', [
      waiting,
      sending,
      sent,
      newer,
      earlier,
      answered,
      theirs,
    ])
    const before = backend.owner?.epoch

    const claimed = await backend.claim(personOf('u1', 'Kevin', 's2'), NOW)
    expect(claimed).toMatchObject({ dropped: 0, marked: 3 })
    expect(backend.owner).toMatchObject({ epoch: before, sessionId: 's2' })
    const at = (item: OutboxItem) =>
      backend.items.get(item.localId)?.sessionEndedAt
    expect(
      [waiting, sending, sent, newer, earlier, answered, theirs].map(at),
    ).toEqual([NOW, NOW, null, null, 5, NOW, null])

    // The same session again marks nothing more.
    expect(
      await backend.claim(personOf('u1', 'Kevin', 's2'), NOW + 1),
    ).toMatchObject({ marked: 0 })
  })

  test('a session nobody said proves nothing, and the one known is kept', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    expect(await backend.claim(personOf('u1', '', ''), NOW)).toMatchObject({
      marked: 0,
    })
    expect(backend.owner?.sessionId).toBe(SESSION)
    expect(backend.items.get(item.localId)?.sessionEndedAt).toBeNull()
  })

  test('IndexedDB marks them as the memory store does', async () => {
    vi.stubGlobal('indexedDB', new FakeIndexedDb())
    const first = await idbOutboxBackend.claim(personOf('u1'), NOW)
    if (first === 'error') throw new Error('claim failed')
    const item = itemFor('u1')
    await idbOutboxBackend.keep(first.owner.epoch, item)
    expect(
      await idbOutboxBackend.claim(personOf('u1', 'Kevin', 's2'), NOW + 1),
    ).toMatchObject({ marked: 1 })
    const read = await idbOutboxBackend.peek()
    expect(read !== 'error' && read.items[0]?.sessionEndedAt).toBe(NOW + 1)
  })

  test('the decision is the same for both stores', () => {
    const owner = {
      key: 'owner' as const,
      userId: 'u1',
      firstName: 'Kevin',
      epoch: 'e1',
      lastSeenAt: 1,
      sessionId: SESSION,
    }
    const items = [itemFor('u1'), itemFor('u2')]
    expect(
      claimDecision(owner, items, personOf('u1', ''), 9, () => 'x').drop,
    ).toEqual([])
    expect(
      claimDecision(owner, items, personOf('u2', ''), 9, () => 'x'),
    ).toEqual({
      owner: {
        key: 'owner',
        userId: 'u2',
        firstName: '',
        epoch: 'x',
        lastSeenAt: 9,
        sessionId: SESSION,
      },
      drop: items.map((item) => item.localId),
      mark: [],
    })
  })
})

describe('keeping a booking', () => {
  test('only under this page load’s claim, for its person', async () => {
    const backend = await outboxOf('u1')
    const epoch = backend.owner?.epoch ?? ''
    expect(await backend.keep('stale', itemFor('u1'))).toBe('refused')
    expect(await backend.keep(epoch, itemFor('u2'))).toBe('refused')
    expect(await backend.keep(epoch, itemFor('u1'))).toBe('kept')
  })

  test('over the same draft’s own while it waits or needs a look, which a retry after a refusal does', async () => {
    const waiting = itemFor('u1')
    const needsLook = itemFor('u1', { state: 'needsLook' })
    const backend = await outboxOf('u1', [waiting, needsLook])
    const epoch = backend.owner?.epoch ?? ''

    const retried = { ...waiting, booking: { ...waiting.booking, price: 1 } }
    expect(await backend.keep(epoch, retried)).toBe('kept')
    expect(backend.items.get(waiting.localId)?.booking.price).toBe(1)
    expect(await backend.keep(epoch, needsLook)).toBe('kept')
  })

  test.each(['sending', 'sent'] as const)(
    'never over one %s: it may be booked',
    async (state) => {
      const item = itemFor('u1', { state })
      const backend = await outboxOf('u1', [item])
      const epoch = backend.owner?.epoch ?? ''
      expect(await backend.keep(epoch, { ...item, state: 'waiting' })).toBe(
        'exists',
      )
      expect(backend.items.get(item.localId)?.state).toBe(state)
    },
  )

  test('never over the same key of someone else’s', async () => {
    const theirs = itemFor('u2')
    const backend = await outboxOf('u1', [theirs])
    const mine = { ...itemFor('u1'), localId: theirs.localId }
    expect(await backend.keep(backend.owner?.epoch ?? '', mine)).toBe('exists')
    expect(backend.items.get(theirs.localId)?.userId).toBe('u2')
  })

  test('a page load with nobody signed in keeps nothing', async () => {
    const backend = await outboxOf('u1')
    await pageFor(backend, null)
    expect(outboxEpoch()).toBeNull()
    expect(await keepOutboxItem(itemFor('u1'))).toBe('refused')
    expect(backend.done).not.toContain('keep')
  })

  test('nor one whose person has signed out since', async () => {
    const backend = await outboxOf('u1')
    await pageFor(backend, 'u1')
    await wipeOutbox('sign-out')
    expect(await keepOutboxItem(itemFor('u1'))).toBe('refused')
  })

  test('a page load’s claim is what it keeps under', async () => {
    const backend = await outboxOf('u1')
    await pageFor(backend, 'u1')
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
    expect(await keepOutboxItem(itemFor('u1'))).toBe('kept')
  })
})

describe('a change to an item', () => {
  /** `item` on a phone claimed for u1, and the way to change it. */
  async function phoneWith(item: OutboxItem) {
    const backend = await outboxOf('u1', [item])
    const epoch = backend.owner?.epoch ?? ''
    return {
      backend,
      change: (
        fn: Parameters<typeof backend.update>[2],
        localId = item.localId,
      ) => backend.update(epoch, localId, fn),
      now: () => backend.items.get(item.localId),
    }
  }

  test('never brings back one that has gone: wiped, or discarded', async () => {
    const item = itemFor('u1')
    const phone = await phoneWith(item)
    await phone.backend.wipe()
    // The claim again, as the same person signing back in would.
    const claimed = await phone.backend.claim(personOf('u1', ''), NOW)
    if (claimed === 'error') throw new Error('claim failed')
    expect(
      await phone.backend.update(
        claimed.owner.epoch,
        item.localId,
        unlockChange(NOW),
      ),
    ).toBe('gone')
    expect(phone.backend.items.size).toBe(0)
  })

  test('under another claim is refused', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    expect(await backend.update('stale', item.localId, unlockChange(NOW))).toBe(
      'refused',
    )
  })

  test('under another claim is refused even when the change itself would go: a tab whose claim a sign-out ended sends nothing', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    expect(
      await backend.update('stale', item.localId, beginSendChange(NOW)),
    ).toBe('refused')
    expect(backend.items.get(item.localId)?.state).toBe('waiting')
  })

  test('to someone else’s item, left behind under this person’s claim, is as if it were gone', async () => {
    const theirs = itemFor('u2')
    const backend = await outboxOf('u1', [theirs])
    expect(
      await backend.update(
        backend.owner?.epoch ?? '',
        theirs.localId,
        beginSendChange(NOW),
      ),
    ).toBe('gone')
    expect(backend.items.get(theirs.localId)?.state).toBe('waiting')
  })

  test('never moves an item to another key, or makes it someone else’s', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    const written = await backend.update(
      backend.owner?.epoch ?? '',
      item.localId,
      (row) => ({ ...row, localId: 'elsewhere', userId: 'u2' }),
    )
    expect(written).toMatchObject({ localId: item.localId, userId: 'u1' })
    expect([...backend.items.keys()]).toEqual([item.localId])
    expect(backend.items.get(item.localId)?.userId).toBe('u1')
  })

  describe('beginSend', () => {
    test('a waiting item goes: locked, tried once more, as its kind', async () => {
      const phone = await phoneWith(itemFor('u1'))
      expect(await phone.change(beginSendChange(NOW))).toMatchObject({
        state: 'sending',
        attempts: 1,
        lastAttemptAt: NOW,
        sentKinds: ['job'],
      })
      // Once only.
      expect(await phone.change(beginSendChange(NOW))).toBe('refused')
    })

    test('a kind already tried is listed once', async () => {
      const phone = await phoneWith(
        itemFor('u1', { attempts: 1, sentKinds: ['job'] }),
      )
      expect(await phone.change(beginSendChange(NOW))).toMatchObject({
        attempts: 2,
        sentKinds: ['job'],
      })
    })

    test.each([
      [
        'being edited in another tab',
        { editing: { tab: 't2', until: NOW + 1 } },
      ],
      ['being edited in this one', { editing: { tab: 't1', until: NOW + 1 } }],
      ['already sending', { state: 'sending' as const }],
      ['needing a look', { state: 'needsLook' as const }],
      ['sent', { state: 'sent' as const }],
      ['backing off', { retryAt: NOW + 1 }],
      ['held', { holdUntil: NOW + 1 }],
      ['saved by a newer build', { v: OUTBOX_V + 1 }],
      ['of a kind this build doesn’t know', { kind: 'client' }],
    ])('refused while %s', async (_why, extra) => {
      const phone = await phoneWith(itemFor('u1', extra))
      expect(await phone.change(beginSendChange(NOW))).toBe('refused')
    })

    test('goes once a lease, a backoff and a hold have run out', async () => {
      const phone = await phoneWith(
        itemFor('u1', {
          editing: { tab: 't2', until: NOW },
          retryAt: NOW,
          holdUntil: NOW,
        }),
      )
      expect(await phone.change(beginSendChange(NOW))).toMatchObject({
        state: 'sending',
      })
    })

    test('refused once a sign-out has discarded it', async () => {
      const item = itemFor('u1', {}, 900)
      const phone = await phoneWith(item)
      writeSignOutTombstone('u1', 950)
      expect(await phone.change(beginSendChange(NOW))).toBe('refused')
    })

    test('refused on one that has outlived its session or waited three days, as this read finds it: its Send lets it go (D8)', async () => {
      // A claim's mark can land between the sender's look and this.
      const ended = await phoneWith(itemFor('u1', { sessionEndedAt: NOW - 1 }))
      expect(await ended.change(beginSendChange(NOW))).toBe('refused')
      const old = await phoneWith(itemFor('u1', {}, 900))
      expect(await old.change(beginSendChange(900 + STALE_AFTER_MS + 1))).toBe(
        'refused',
      )
      const sentOn = await phoneWith(
        itemFor('u1', { sessionEndedAt: NOW - 2, confirmedAt: NOW - 1 }),
      )
      expect(await sentOn.change(beginSendChange(NOW))).toMatchObject({
        state: 'sending',
      })
    })
  })

  test('adopt: only a waiting item never tried, which New Job’s own late call becomes', async () => {
    const phone = await phoneWith(itemFor('u1'))
    expect(await phone.change(adoptChange(NOW - 500, NOW))).toMatchObject({
      state: 'sending',
      attempts: 1,
      lastAttemptAt: NOW - 500,
      sentKinds: ['job'],
    })
    const tried = await phoneWith(itemFor('u1', { attempts: 1 }))
    expect(await tried.change(adoptChange(NOW, NOW))).toBe('refused')
    // Marked as needing a look before any try (its first visit gone by).
    const looked = await phoneWith(
      itemFor('u1', {
        state: 'needsLook',
        problem: { code: 'FIRST_VISIT_PAST' },
      }),
    )
    expect(await looked.change(adoptChange(NOW, NOW))).toBe('refused')
    const foreign = await phoneWith(itemFor('u1', { v: OUTBOX_V + 1 }))
    expect(await foreign.change(adoptChange(NOW, NOW))).toBe('refused')
  })

  test('answered, unlock and a new request id: only on a locked item', async () => {
    const waiting = await phoneWith(itemFor('u1'))
    const sent = (item: OutboxItem) => ({ ...item, state: 'sent' as const })
    expect(await waiting.change(answeredChange(sent))).toBe('refused')
    expect(await waiting.change(unlockChange(NOW))).toBe('refused')
    expect(await waiting.change(newRequestIdChange('x', NOW))).toBe('refused')

    const locked = await phoneWith(itemFor('u1', { state: 'sending' }))
    expect(await locked.change(answeredChange(sent))).toMatchObject({
      state: 'sent',
    })
    const again = await phoneWith(itemFor('u1', { state: 'sending' }))
    expect(await again.change(unlockChange(NOW))).toMatchObject({
      state: 'waiting',
    })
    // A newer build's, never changed, whatever the answer.
    const foreign = await phoneWith(
      itemFor('u1', { state: 'sending', v: OUTBOX_V + 1 }),
    )
    expect(await foreign.change(answeredChange(sent))).toBe('refused')
    expect(await foreign.change(unlockChange(NOW))).toBe('refused')
    const refusedId = await phoneWith(itemFor('u1', { state: 'sending' }))
    const before = refusedId.now()
    const renewed = await refusedId.change(newRequestIdChange('new-id', NOW))
    expect(renewed).toMatchObject({
      state: 'waiting',
      requestId: 'new-id',
      localId: before?.localId,
    })
    expect(refusedId.backend.items.size).toBe(1)
  })

  describe('an Edit', () => {
    test.each(['waiting', 'needsLook'] as const)(
      'opens on an item %s',
      async (state) => {
        const phone = await phoneWith(itemFor('u1', { state }))
        expect(await phone.change(beginEditChange('t1', NOW))).toMatchObject({
          editing: { tab: 't1', until: NOW + EDIT_LEASE_MS },
        })
      },
    )

    test.each(['sending', 'sent'] as const)(
      'never on one %s',
      async (state) => {
        const phone = await phoneWith(itemFor('u1', { state }))
        expect(await phone.change(beginEditChange('t1', NOW))).toBe('refused')
      },
    )

    test('not while another tab’s lease holds; once it has run out, or when it is this tab’s', async () => {
      const held = await phoneWith(
        itemFor('u1', { editing: { tab: 't2', until: NOW + 1 } }),
      )
      expect(await held.change(beginEditChange('t1', NOW))).toBe('refused')
      expect(await held.change(beginEditChange('t2', NOW))).toMatchObject({
        editing: { tab: 't2' },
      })
      const lapsed = await phoneWith(
        itemFor('u1', { editing: { tab: 't2', until: NOW } }),
      )
      expect(await lapsed.change(beginEditChange('t1', NOW))).toMatchObject({
        editing: { tab: 't1' },
      })
    })

    test('never on a newer build’s item', async () => {
      const phone = await phoneWith(itemFor('u1', { v: OUTBOX_V + 1 }))
      expect(await phone.change(beginEditChange('t1', NOW))).toBe('refused')
    })

    test('is renewed and ended only by its own tab', async () => {
      const phone = await phoneWith(
        itemFor('u1', { editing: { tab: 't1', until: NOW } }),
      )
      expect(await phone.change(renewEditChange('t2', NOW))).toBe('refused')
      expect(await phone.change(renewEditChange('t1', NOW))).toMatchObject({
        editing: { tab: 't1', until: NOW + EDIT_LEASE_MS },
      })
      expect(await phone.change(endEditChange('t2', NOW))).toBe('refused')
      expect(await phone.change(endEditChange('t1', NOW))).toMatchObject({
        editing: null,
      })
    })
  })

  describe('replace (Book, from an Edit)', () => {
    const next = {
      booking: bookingFor({ repeat: { count: 2, unit: 'week' } }),
      display: { ...DISPLAY, assigneeName: 'Sam' },
    }

    test('by the editing tab: the booking as it now is, to go again, under the same ids', async () => {
      const item = itemFor('u1', {
        state: 'needsLook',
        problem: { code: 'INVALID_ASSIGNEE' },
        serverFailures: 2,
        retryAt: NOW + 5,
        holdUntil: NOW + 5,
        editing: { tab: 't1', until: NOW + 5 },
      })
      const phone = await phoneWith(item)
      expect(await phone.change(replaceChange('t1', next, NOW))).toStrictEqual({
        ...item,
        booking: next.booking,
        kind: 'series',
        display: next.display,
        state: 'waiting',
        problem: null,
        serverFailures: 0,
        retryAt: null,
        holdUntil: null,
        editing: null,
        // Not a Send: it hadn't waited too long.
        confirmedAt: null,
        updatedAt: NOW,
      })
    })

    test.each([
      [
        'one that needs a look for waiting too long',
        { state: 'needsLook' as const, problem: { code: 'STALE' } },
        NOW,
      ],
      ['one waiting that has waited too long', {}, NOW + STALE_AFTER_MS + 1],
      ['one whose session ended', { sessionEndedAt: NOW }, NOW + 1],
    ])(
      'on %s, is the person’s Send, for that as it stands now',
      async (_what, extra, at) => {
        const phone = await phoneWith(
          itemFor(
            'u1',
            { ...extra, editing: { tab: 't1', until: at + 5 } },
            NOW,
          ),
        )
        const replaced = await phone.change(replaceChange('t1', next, at))
        expect(replaced).toMatchObject({ state: 'waiting', confirmedAt: at })
        expect(isStale(phone.now() as OutboxItem, at)).toBe(false)
      },
    )

    test('on any other, keeps the Send it had, if any', async () => {
      const phone = await phoneWith(
        itemFor('u1', {
          confirmedAt: NOW - 5,
          editing: { tab: 't1', until: NOW + 5 },
        }),
      )
      expect(await phone.change(replaceChange('t1', next, NOW))).toMatchObject({
        confirmedAt: NOW - 5,
      })
    })

    test('an edit, then the session ends: it waits for the person’s say-so', async () => {
      const item = itemFor(
        'u1',
        { editing: { tab: 't1', until: NOW + 5 } },
        NOW,
      )
      const backend = await outboxOf('u1', [item])
      await backend.update(
        backend.owner?.epoch ?? '',
        item.localId,
        replaceChange('t1', next, NOW + 1),
      )
      setOutboxBackendForTests(backend)
      await markSessionEnded('u1', NOW + 2)
      const after = backend.items.get(item.localId) as OutboxItem
      expect(after.sessionEndedAt).toBe(NOW + 2)
      expect(isStale(after, NOW + 3)).toBe(true)
    })

    test('an edit, then three days unsent: it waits for the person’s say-so', async () => {
      const phone = await phoneWith(
        itemFor('u1', { editing: { tab: 't1', until: NOW + 5 } }, NOW),
      )
      await phone.change(replaceChange('t1', next, NOW + 1))
      const after = phone.now() as OutboxItem
      expect(isStale(after, NOW + STALE_AFTER_MS - 1)).toBe(false)
      expect(isStale(after, NOW + STALE_AFTER_MS + 1)).toBe(true)
    })

    test('never on a newer build’s item', async () => {
      const phone = await phoneWith(
        itemFor('u1', {
          v: OUTBOX_V + 1,
          editing: { tab: 't1', until: NOW + 5 },
        }),
      )
      expect(await phone.change(replaceChange('t1', next, NOW))).toBe('refused')
    })

    test('by any other tab, or with no Edit open, is refused', async () => {
      const phone = await phoneWith(
        itemFor('u1', { editing: { tab: 't2', until: NOW + 5 } }),
      )
      expect(await phone.change(replaceChange('t1', next, NOW))).toBe('refused')
      const none = await phoneWith(itemFor('u1'))
      expect(await none.change(replaceChange('t1', next, NOW))).toBe('refused')
    })

    test.each(['sending', 'sent'] as const)(
      'refused once it is %s: sent while it was being changed',
      async (state) => {
        const phone = await phoneWith(
          itemFor('u1', { state, editing: { tab: 't1', until: NOW + 5 } }),
        )
        expect(await phone.change(replaceChange('t1', next, NOW))).toBe(
          'refused',
        )
      },
    )

    test('a client or site not sent yet is what it then waits on, and nothing else', async () => {
      const phone = await phoneWith(
        itemFor('u1', {
          dependsOn: 'local-0',
          editing: { tab: 't1', until: NOW + 5 },
        }),
      )
      const replaced = await phone.change(replaceChange('t1', next, NOW))
      expect(replaced).not.toHaveProperty('dependsOn')
      const onLocal = await phoneWith(
        itemFor('u1', { editing: { tab: 't1', until: NOW + 5 } }),
      )
      expect(
        await onLocal.change(
          replaceChange(
            't1',
            {
              ...next,
              booking: bookingFor({ property: { local: 'local-9' } }),
            },
            NOW,
          ),
        ),
      ).toMatchObject({ dependsOn: 'local-9' })
    })
  })

  test('Send, on one that waited too long: only one that needs a look for that', async () => {
    const stale = await phoneWith(
      itemFor('u1', { state: 'needsLook', problem: { code: 'STALE' } }),
    )
    expect(await stale.change(confirmStaleChange(NOW))).toMatchObject({
      state: 'waiting',
      problem: null,
      confirmedAt: NOW,
    })
    const other = await phoneWith(
      itemFor('u1', { state: 'needsLook', problem: { code: 'SERVER' } }),
    )
    expect(await other.change(confirmStaleChange(NOW))).toBe('refused')
    // Sent from another tab meanwhile, the old problem still on it.
    const going = await phoneWith(
      itemFor('u1', { state: 'sending', problem: { code: 'STALE' } }),
    )
    expect(await going.change(confirmStaleChange(NOW))).toBe('refused')
  })

  describe('discard', () => {
    test.each(['waiting', 'needsLook'] as const)(
      'goes while %s',
      async (state) => {
        const phone = await phoneWith(itemFor('u1', { state }))
        expect(await phone.change(discardChange())).toBe('deleted')
        expect(phone.backend.items.size).toBe(0)
      },
    )

    test.each(['sending', 'sent'] as const)(
      'refused while %s',
      async (state) => {
        const phone = await phoneWith(itemFor('u1', { state }))
        expect(await phone.change(discardChange())).toBe('refused')
      },
    )

    test('one sent with no answer goes only when the person says it may already be booked', async () => {
      const phone = await phoneWith(itemFor('u1', { state: 'sending' }))
      expect(await phone.change(discardChange({ mayHaveGone: true }))).toBe(
        'deleted',
      )
      const sent = await phoneWith(itemFor('u1', { state: 'sent' }))
      expect(await sent.change(discardChange({ mayHaveGone: true }))).toBe(
        'refused',
      )
    })

    test('a newer build’s item can be discarded, though never changed', async () => {
      const phone = await phoneWith(itemFor('u1', { v: OUTBOX_V + 1 }))
      expect(await phone.change(discardChange())).toBe('deleted')
    })

    test('takes the bookings made after it on it, and theirs, in one go; nothing else', async () => {
      const parent = itemFor('u1')
      const child = itemFor('u1', { dependsOn: parent.localId })
      const grandchild = itemFor('u1', { dependsOn: child.localId })
      const unrelated = itemFor('u1')
      const backend = await outboxOf('u1', [
        parent,
        child,
        grandchild,
        unrelated,
      ])
      const result = await backend.update(
        backend.owner?.epoch ?? '',
        parent.localId,
        discardChange(),
      )
      expect(result).toBe('deleted')
      expect([...backend.items.keys()]).toEqual([unrelated.localId])
      expect(backend.done).toEqual(['update'])
    })

    test('never takes one of those that is itself sending', async () => {
      const parent = itemFor('u1')
      const child = itemFor('u1', {
        dependsOn: parent.localId,
        state: 'sending',
      })
      const backend = await outboxOf('u1', [parent, child])
      await backend.update(
        backend.owner?.epoch ?? '',
        parent.localId,
        discardChange(),
      )
      expect([...backend.items.keys()]).toEqual([child.localId])
    })
  })
})

describe('storage that fails', () => {
  test('is an error, never a refusal', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    await pageFor(backend, 'u1')
    const [item] = [...backend.items.values()]
    backend.unavailable = true

    expect(
      await changeOutboxItem('beginSend', item.localId, beginSendChange(NOW)),
    ).toBe('error')
    expect(await keepOutboxItem(itemFor('u1'))).toBe('error')
    expect(notes('outbox-store-failed')).toEqual([
      { op: 'beginSend' },
      { op: 'keep' },
    ])
  })

  test('a keep that never answers is an error after STORE_OP_MS', async () => {
    const backend = await outboxOf('u1')
    await pageFor(backend, 'u1')
    backend.hung = true
    vi.useFakeTimers()

    let result: unknown = 'pending'
    void keepOutboxItem(itemFor('u1')).then((r) => {
      result = r
    })
    await vi.advanceTimersByTimeAsync(STORE_OP_MS - 1)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe('error')
  })

  test('or that never answers, is an error after STORE_OP_MS', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    await pageFor(backend, 'u1')
    const [item] = [...backend.items.values()]
    backend.hung = true
    vi.useFakeTimers()

    let result: unknown = 'pending'
    void changeOutboxItem('beginSend', item.localId, beginSendChange(NOW)).then(
      (r) => {
        result = r
      },
    )
    await vi.advanceTimersByTimeAsync(STORE_OP_MS - 1)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe('error')
  })
})

describe('the page load’s read', () => {
  test('is read once, and kept', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    setOutboxBackendForTests(backend)
    expect(outboxReadable()).toBe(false)
    const first = await peekOutbox()
    const second = await peekOutbox()
    expect(first).toEqual(second)
    expect(backend.done).toEqual(['peek'])
    expect(outboxReadable()).toBe(true)
    expect(notes('outbox-peek')).toEqual([
      { ms: expect.any(Number), n: 1, ok: true },
    ])
  })

  test('a failure is never kept: tried again after 1, 5 and 15 s, then when the page wakes', async () => {
    vi.useFakeTimers()
    const backend = await outboxOf('u1', [itemFor('u1')])
    backend.unavailable = true
    setOutboxBackendForTests(backend)

    expect(await peekOutbox()).toBe('error')
    const reads = () => notes('outbox-peek').length
    expect(reads()).toBe(1)
    for (const [i, wait] of PEEK_RETRY_MS.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(reads()).toBe(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(reads()).toBe(i + 2)
    }
    // No more by itself.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads()).toBe(4)
    expect(outboxReadable()).toBe(false)

    backend.unavailable = false
    retryOutbox()
    await vi.advanceTimersByTimeAsync(10)
    expect(outboxReadable()).toBe(true)
    expect(await peekOutbox()).toMatchObject({ items: [expect.anything()] })
  })

  test('a read asked for between the tries, failing too, takes none of their steps', async () => {
    vi.useFakeTimers()
    const backend = await outboxOf('u1', [itemFor('u1')])
    backend.unavailable = true
    setOutboxBackendForTests(backend)
    const reads = () => notes('outbox-peek').length

    expect(await peekOutbox()).toBe('error')
    await vi.advanceTimersByTimeAsync(500)
    // Someone asks in between: it fails too.
    expect(await peekOutbox()).toBe('error')
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(reads()).toBe(3)
    // The 5 s step is still to come, not skipped for the 15 s one.
    await vi.advanceTimersByTimeAsync(PEEK_RETRY_MS[1])
    expect(reads()).toBe(4)
    await vi.advanceTimersByTimeAsync(PEEK_RETRY_MS[2])
    expect(reads()).toBe(5)
  })

  test('once it has succeeded, a wake reads nothing more', async () => {
    const backend = await outboxOf('u1')
    setOutboxBackendForTests(backend)
    await peekOutbox()
    retryOutbox()
    await settled()
    expect(backend.done).toEqual(['peek'])
  })

  test('says whose the outbox is now, once a claim has made it someone else’s', async () => {
    const backend = await outboxOf('u1')
    setOutboxBackendForTests(backend)
    expect(await peekOutbox()).toMatchObject({ owner: { userId: 'u1' } })
    checkOutboxOwner(personOf('u2', 'Sam'))
    for (let i = 0; i < 5; i++) await settled()
    expect(await peekOutbox()).toMatchObject({
      owner: { userId: 'u2', firstName: 'Sam' },
      items: [],
    })
  })

  test('slower than PEEK_TIMEOUT_MS is a failure', async () => {
    vi.useFakeTimers()
    const backend = await outboxOf('u1')
    backend.hung = true
    setOutboxBackendForTests(backend)
    let read: unknown = 'pending'
    void peekOutbox().then((r) => {
      read = r
    })
    await vi.advanceTimersByTimeAsync(PEEK_TIMEOUT_MS)
    expect(read).toBe('error')
  })

  test('hands out nothing a sign-out discarded, or sent before it', async () => {
    const discarded = itemFor('u1', {}, 900)
    const sent = itemFor('u1', { state: 'sent' }, 2_000)
    const foreignSent = itemFor('u1', { state: 'sent', v: OUTBOX_V + 1 }, 2_000)
    const later = itemFor('u1', {}, 2_000)
    setOutboxBackendForTests(
      await outboxOf('u1', [discarded, sent, foreignSent, later]),
    )
    // Another tab's sign-out, after this page read them.
    const read = await peekOutbox()
    expect(read !== 'error' && read.items.length).toBe(3)
    writeSignOutTombstone('u1', 1_000)

    const after = await peekOutbox()
    expect(after !== 'error' && after.items.map((i) => i.localId)).toEqual([
      foreignSent.localId,
      later.localId,
    ])
  })

  test('a wipe while it reads has the last word', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    setOutboxBackendForTests(backend)
    const reading = peekOutbox()
    void wipeOutbox('sign-out')
    expect(await reading).toEqual({ owner: null, items: [] })
  })
})

describe('the sign-out tombstone', () => {
  test('is written at once, and covers what the person had kept until then', () => {
    writeSignOutTombstone('u1', 1_000)
    expect(tombstoned({ userId: 'u1', createdAt: 1_000 })).toBe(true)
    expect(tombstoned({ userId: 'u1', createdAt: 1_001 })).toBe(false)
    expect(tombstoned({ userId: 'u2', createdAt: 1 })).toBe(false)
  })

  test('keeps the last four people’s', () => {
    for (let i = 1; i <= 5; i++) writeSignOutTombstone(`u${i}`, 1_000)
    expect(tombstoned({ userId: 'u1', createdAt: 1 })).toBe(false)
    expect(tombstoned({ userId: 'u5', createdAt: 1 })).toBe(true)
  })

  test('one per person, the latest: one person signing out over and over never pushes out another’s', () => {
    writeSignOutTombstone('kevin', 1_000)
    for (let i = 1; i <= 4; i++) writeSignOutTombstone('sam', 1_000 + i)
    expect(tombstoned({ userId: 'kevin', createdAt: 900 })).toBe(true)
    expect(tombstoned({ userId: 'sam', createdAt: 1_004 })).toBe(true)
    expect(
      JSON.parse(storage.getItem('pestm8-outbox-discarded') ?? '[]'),
    ).toEqual([
      { userId: 'kevin', at: 1_000 },
      { userId: 'sam', at: 1_004 },
    ])
  })

  test('without localStorage, or with one that throws, is skipped', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => writeSignOutTombstone('u1')).not.toThrow()
    expect(tombstoned({ userId: 'u1', createdAt: 1 })).toBe(false)
  })

  test('the next page load deletes what it covers, then lets it go', async () => {
    const discarded = itemFor('u1', {}, 900)
    const later = itemFor('u1', {}, 2_000)
    const backend = await outboxOf('u1', [discarded, later])
    writeSignOutTombstone('u1', 1_000)

    await pageFor(backend, null)
    expect([...backend.items.keys()]).toEqual([later.localId])
    expect(storage.getItem('pestm8-outbox-discarded')).toBeNull()
    expect(notes('outbox-purge')).toEqual([{ why: 'page-load', n: 1 }])
  })

  test('and keeps it while that delete hasn’t landed', async () => {
    const backend = await outboxOf('u1', [itemFor('u1', {}, 900)])
    writeSignOutTombstone('u1', 1_000)
    backend.unavailable = true
    await pageFor(backend, null)
    expect(storage.getItem('pestm8-outbox-discarded')).not.toBeNull()
  })
})

describe('a page load', () => {
  test('with nobody signed in deletes only what a sign-out discarded and what was sent: never a claim', async () => {
    const mine = itemFor('u1', {}, 2_000)
    const sent = itemFor('u1', { state: 'sent' })
    // A newer build's: what its "sent" means is for it to say.
    const newerSent = itemFor('u1', { state: 'sent', v: OUTBOX_V + 1 })
    const backend = await outboxOf('u1', [mine, sent, newerSent])
    const owner = backend.owner

    await pageFor(backend, null)
    expect([...backend.items.keys()].sort()).toEqual(
      [mine.localId, newerSent.localId].sort(),
    )
    expect(backend.owner).toEqual(owner)
    expect(backend.done).not.toContain('claim')
  })

  test('keeps a person’s own, however long they have waited', async () => {
    const old = itemFor('u1', {}, 1)
    const backend = await outboxOf('u1', [old])
    await pageFor(backend, 'u1')
    expect([...backend.items.keys()]).toEqual([old.localId])
    expect(backend.owner?.lastSeenAt).toBeGreaterThan(1)
  })

  test('for someone else drops the last person’s, and hands none of them out meanwhile', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    setOutboxBackendForTests(backend)
    checkOutboxOwner(personOf('u2', 'Sam'))
    // At once: before the claim has landed.
    expect(await peekOutbox()).toMatchObject({ items: [] })
    for (let i = 0; i < 5; i++) await settled()
    expect(backend.items.size).toBe(0)
    expect(backend.owner?.userId).toBe('u2')
    expect(notes('outbox-purge')).toEqual([{ why: 'other-person', n: 1 }])
  })

  test('claims once per person, and again for the next one', async () => {
    const backend = await outboxOf('u1')
    await pageFor(backend, 'u1')
    checkOutboxOwner(personOf('u1'))
    await settled()
    expect(backend.done.filter((op) => op === 'claim')).toHaveLength(1)
    checkOutboxOwner(personOf('u2', 'Sam'))
    for (let i = 0; i < 5; i++) await settled()
    expect(backend.done.filter((op) => op === 'claim')).toHaveLength(2)
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
  })

  test('a claim that failed is tried again at the next check', async () => {
    const backend = await outboxOf('u1')
    backend.unavailable = true
    await pageFor(backend, 'u1')
    expect(outboxEpoch()).toBeNull()
    backend.unavailable = false
    checkOutboxOwner(personOf('u1'))
    for (let i = 0; i < 5; i++) await settled()
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
  })

  test('a claim that failed is tried again by itself, after 1, 5 and 15 s, with no new check', async () => {
    vi.useFakeTimers()
    const backend = await outboxOf('u1')
    backend.unavailable = true
    setOutboxBackendForTests(backend)
    checkOutboxOwner(personOf('u1'))
    await vi.advanceTimersByTimeAsync(10)
    const claims = () => notes('outbox-store-failed').length
    expect(claims()).toBe(2) // the sweep's, and the claim's
    await vi.advanceTimersByTimeAsync(PEEK_RETRY_MS[0])
    expect(claims()).toBe(3)
    expect(outboxEpoch()).toBeNull()

    backend.unavailable = false
    await vi.advanceTimersByTimeAsync(PEEK_RETRY_MS[1])
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
  })

  test('and by any write meanwhile, which is an error while it can’t be made, never a refusal', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    backend.unavailable = true
    await pageFor(backend, 'u1')
    const [item] = [...backend.items.values()]
    expect(await keepOutboxItem(itemFor('u1'))).toBe('error')
    expect(
      await changeOutboxItem('beginSend', item.localId, beginSendChange(NOW)),
    ).toBe('error')

    backend.unavailable = false
    expect(
      await changeOutboxItem('beginSend', item.localId, beginSendChange(NOW)),
    ).toMatchObject({ state: 'sending' })
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
  })

  test('or once a read succeeds, storage answering again', async () => {
    const backend = await outboxOf('u1')
    backend.unavailable = true
    await pageFor(backend, 'u1')
    backend.unavailable = false
    await peekOutbox()
    for (let i = 0; i < 5; i++) await settled()
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
  })

  test('nobody signed in after all: the claim no longer holds', async () => {
    const backend = await outboxOf('u1')
    await pageFor(backend, 'u1')
    expect(outboxEpoch()).not.toBeNull()
    checkOutboxOwner(null)
    expect(outboxEpoch()).toBeNull()
    expect(await keepOutboxItem(itemFor('u1'))).toBe('refused')
  })

  test('the same person in a new session, with no load between: claimed again, and their bookings marked', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    await pageFor(backend, 'u1')
    checkOutboxOwner(personOf('u1', 'Kevin', 's2'))
    for (let i = 0; i < 5; i++) await settled()
    expect(backend.done.filter((op) => op === 'claim')).toHaveLength(2)
    expect(backend.owner?.sessionId).toBe('s2')
    expect(backend.items.get(item.localId)?.sessionEndedAt).toEqual(
      expect.any(Number),
    )
    expect(notes('outbox-session-ended')).toEqual([
      { why: 'new-session', n: 1 },
    ])
  })

  test('or by a wake', async () => {
    const backend = await outboxOf('u1')
    backend.unavailable = true
    await pageFor(backend, 'u1')
    backend.unavailable = false
    retryOutbox()
    for (let i = 0; i < 5; i++) await settled()
    expect(outboxEpoch()).toBe(backend.owner?.epoch)
  })

  test('a claim overtaken by the next person’s never stands for theirs', async () => {
    const backend = await outboxOf('u1')
    const claim = backend.claim.bind(backend)
    backend.claim = (user, now) =>
      user.userId === 'u2' ? Promise.resolve('error') : claim(user, now)
    setOutboxBackendForTests(backend)
    checkOutboxOwner(personOf('u1'))
    checkOutboxOwner(personOf('u2', 'Sam'))
    for (let i = 0; i < 5; i++) await settled()
    // u1's landed first, but the page is u2's now, and theirs failed.
    expect(outboxEpoch()).toBeNull()
    expect(await keepOutboxItem(itemFor('u1'))).toBe('error')
  })
})

describe('wiping', () => {
  test('tells whoever holds the bookings first, then clears both stores, and lets the tombstone go once it has', async () => {
    const backend = await outboxOf('u1', [itemFor('u1'), itemFor('u1')])
    await pageFor(backend, 'u1')
    await peekOutbox()
    writeSignOutTombstone('u1')
    let told = false
    onOutboxWiped(() => {
      told = true
    })

    const wiped = wipeOutbox('sign-out')
    expect(told).toBe(true)
    expect(await peekOutbox()).toEqual({ owner: null, items: [] })
    expect(outboxEpoch()).toBeNull()
    expect(notes('outbox-wipe')).toEqual([
      { why: 'sign-out', n: 2, read: true },
    ])

    await wiped
    expect(backend.owner).toBeNull()
    expect(backend.items.size).toBe(0)
    expect(storage.getItem('pestm8-outbox-discarded')).toBeNull()
  })

  test('without localStorage, hands out nothing from the moment it is asked, the wipe still to land', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })
    const backend = await outboxOf('u1', [itemFor('u1', {}, 900)])
    await pageFor(backend, 'u1')
    expect(await peekOutbox()).toMatchObject({ items: [expect.anything()] })
    backend.hung = true
    void wipeOutbox('sign-out')
    expect(await peekOutbox()).toEqual({ owner: null, items: [] })
  })

  test('lets go only the tombstones it covered: a sign-out written while it was out stays', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    await pageFor(backend, 'u1')
    writeSignOutTombstone('u1', 1_000)
    const wiped = wipeOutbox('sign-out')
    writeSignOutTombstone('u2', 2_000)
    await wiped
    expect(tombstoned({ userId: 'u1', createdAt: 1 })).toBe(false)
    expect(tombstoned({ userId: 'u2', createdAt: 1 })).toBe(true)
  })

  test('a wipe that fails keeps the tombstone, so the next load still deletes them', async () => {
    const backend = await outboxOf('u1', [itemFor('u1', {}, 900)])
    await pageFor(backend, 'u1')
    writeSignOutTombstone('u1', 1_000)
    backend.unavailable = true
    await wipeOutbox('sign-out')
    expect(storage.getItem('pestm8-outbox-discarded')).not.toBeNull()
    expect(notes('outbox-store-failed')).toEqual([{ op: 'wipe' }])
  })

  test('one business’s, for one person, by its id or its slug, and nothing else', async () => {
    const inB1 = itemFor('u1')
    const inB2 = itemFor('u1', { businessId: B2, slug: 'other-co' })
    const anotherB2 = itemFor('u1', { businessId: B2, slug: 'other-co' })
    const theirsInB1 = itemFor('u2')
    const backend = await outboxOf('u1', [inB1, inB2, anotherB2, theirsInB1])
    setOutboxBackendForTests(backend)
    await peekOutbox()

    await wipeOutboxForBusiness({ businessId: B1 }, 'u1', 'no-access')
    expect([...backend.items.keys()].sort()).toEqual(
      [inB2.localId, anotherB2.localId, theirsInB1.localId].sort(),
    )
    await wipeOutboxForBusiness({ slug: 'other-co' }, 'u1', 'removed')
    expect([...backend.items.keys()]).toEqual([theirsInB1.localId])
    expect(notes('outbox-wipe')).toEqual([
      { why: 'no-access', n: 1, ok: true },
      { why: 'removed', n: 2, ok: true },
    ])
    const read = await peekOutbox()
    expect(read !== 'error' && read.items.map((i) => i.localId)).toEqual([
      theirsInB1.localId,
    ])
  })
})

describe('a session that ended elsewhere', () => {
  test('marks the person’s bookings, so none goes before they say so; keeps the first time it ended', async () => {
    const waiting = itemFor('u1')
    const sending = itemFor('u1', { state: 'sending' })
    const marked = itemFor('u1', { sessionEndedAt: 5 })
    const sent = itemFor('u1', { state: 'sent' })
    const foreign = itemFor('u1', { v: OUTBOX_V + 1 })
    const theirs = itemFor('u2')
    // Sent on by the person after an earlier end: their say-so was for that.
    const answered = itemFor('u1', { sessionEndedAt: 5, confirmedAt: 6 })
    const backend = await outboxOf('u1', [
      waiting,
      sending,
      marked,
      sent,
      foreign,
      theirs,
      answered,
    ])
    setOutboxBackendForTests(backend)

    await markSessionEnded('u1', 100)
    const at = (item: OutboxItem) =>
      backend.items.get(item.localId)?.sessionEndedAt
    expect(
      [waiting, sending, marked, sent, foreign, theirs, answered].map(at),
    ).toEqual([100, 100, 5, null, null, null, 100])
    expect(notes('outbox-session-ended')).toEqual([
      { why: 'session-watch', n: 3 },
    ])
  })

  test('a Send on one stuck, then the session ends again before it goes: asked again', async () => {
    const item = itemFor('u1', {
      state: 'needsLook',
      problem: { code: 'STALE' },
    })
    const backend = await outboxOf('u1', [item])
    await backend.update(
      backend.owner?.epoch ?? '',
      item.localId,
      confirmStaleChange(NOW),
    )
    setOutboxBackendForTests(backend)
    await markSessionEnded('u1', NOW + 1)
    const after = backend.items.get(item.localId) as OutboxItem
    expect(after.sessionEndedAt).toBe(NOW + 1)
    expect(isStale(after, NOW + 2)).toBe(true)
  })
})

describe('what the sender adds', () => {
  async function phoneWith(...items: Array<OutboxItem>) {
    const backend = await outboxOf('u1', items)
    const epoch = backend.owner?.epoch ?? ''
    return {
      backend,
      change: (localId: string, fn: Parameters<typeof backend.update>[2]) =>
        backend.update(epoch, localId, fn),
    }
  }

  test('the phone’s own word that one needs a look: only on one still waiting, with no problem said', async () => {
    const item = itemFor('u1')
    const sending = itemFor('u1', { state: 'sending' })
    const said = itemFor('u1', { problem: { code: 'SERVER' } })
    const foreign = itemFor('u1', { v: OUTBOX_V + 1 })
    const phone = await phoneWith(item, sending, said, foreign)
    expect(
      await phone.change(item.localId, preSendChange('STALE', NOW)),
    ).toMatchObject({ state: 'needsLook', problem: { code: 'STALE' } })
    for (const other of [sending, said, foreign]) {
      expect(
        await phone.change(
          other.localId,
          preSendChange('FIRST_VISIT_PAST', NOW),
        ),
      ).toBe('refused')
    }
  })

  test('what a sent one made, asked for after: only added to one sent, its id kept', async () => {
    const sent = itemFor('u1', {
      state: 'sent',
      result: { id: 'rec-1' },
    })
    const waiting = itemFor('u1')
    const phone = await phoneWith(sent, waiting)
    const found = {
      propertyId: 'p9' as Id<'properties'>,
      firstJobId: 'job-9' as Id<'jobs'>,
    }
    expect(
      await phone.change(sent.localId, resultChange(found, NOW)),
    ).toMatchObject({
      result: { id: 'rec-1', propertyId: 'p9', firstJobId: 'job-9' },
    })
    expect(await phone.change(waiting.localId, resultChange(found, NOW))).toBe(
      'refused',
    )
    // Nor to one that has an id from an earlier answer but is out again.
    const going = itemFor('u1', { state: 'sending', result: { id: 'rec-2' } })
    const again = await phoneWith(going)
    expect(await again.change(going.localId, resultChange(found, NOW))).toBe(
      'refused',
    )
  })

  test('one sent a while ago goes; nothing else does, and no newer build’s', async () => {
    const sent = itemFor('u1', { state: 'sent' })
    const waiting = itemFor('u1')
    const foreign = itemFor('u1', { state: 'sent', v: OUTBOX_V + 1 })
    const phone = await phoneWith(sent, waiting, foreign)
    expect(await phone.change(sent.localId, forgetSentChange())).toBe('deleted')
    expect(await phone.change(waiting.localId, forgetSentChange())).toBe(
      'refused',
    )
    expect(await phone.change(foreign.localId, forgetSentChange())).toBe(
      'refused',
    )
  })

  test('a fresh read has every change since in it, sent ones too, and becomes the page load’s', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    setOutboxBackendForTests(backend)
    await peekOutbox()
    backend.items.set(item.localId, { ...item, state: 'sent' })
    const fresh = await readOutboxNow()
    expect(fresh !== 'error' && fresh.items.map((i) => i.state)).toEqual([
      'sent',
    ])
    // The page load's read is the fresh one now, which hands out no sent.
    const peek = await peekOutbox()
    expect(peek !== 'error' && peek.items).toEqual([])
    expect(outboxReadable()).toBe(true)
  })

  test('a fresh read honours a sign-out, and a wipe in this tab while it reads has the last word', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    setOutboxBackendForTests(backend)
    await peekOutbox()
    const reading = readOutboxNow()
    void wipeOutbox('sign-out')
    const read = await reading
    expect(read !== 'error' && read.items).toEqual([])

    const later = itemFor('u1')
    backend.items.set(later.localId, structuredClone(later))
    writeSignOutTombstone('u1', later.createdAt)
    const again = await readOutboxNow()
    expect(again !== 'error' && again.items).toEqual([])
    expect(stillKept(later)).toBe(false)
  })

  test('a fresh read that fails is an error, and says so', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    setOutboxBackendForTests(backend)
    backend.unavailable = true
    expect(await readOutboxNow()).toBe('error')
    expect(notes('outbox-store-failed')).toContainEqual({ op: 'read' })
  })

  test('some of one person’s, as a match says, and nothing else: handed out by nothing from the moment it is asked', async () => {
    const old = itemFor('u1', {}, 100)
    const recent = itemFor('u1', {}, 5_000)
    const theirs = itemFor('u2', {}, 100)
    const backend = await outboxOf('u1', [old, recent, theirs])
    setOutboxBackendForTests(backend)
    await peekOutbox()
    const wiping = wipeOutboxWhere(
      'u1',
      (item) => item.createdAt < 1_000,
      'earlier-stint',
    )
    expect(stillKept(old)).toBe(false)
    expect(stillKept(recent)).toBe(true)
    await wiping
    expect([...backend.items.keys()].sort()).toEqual(
      [recent.localId, theirs.localId].sort(),
    )
    expect(notes('outbox-wipe')).toEqual([
      { why: 'earlier-stint', n: 1, ok: true },
    ])
  })

  test('whoever holds them in memory is told when someone else’s sign-in drops the last person’s', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    setOutboxBackendForTests(backend)
    const told = vi.fn()
    onOutboxChanged(told)
    checkOutboxOwner(personOf('u2'))
    for (let i = 0; i < 5; i++) await settled()
    expect(backend.items.size).toBe(0)
    expect(told).toHaveBeenCalledTimes(1)
  })

  test('whoever holds them in memory is told of each change in bulk: a removal, a session that ended', async () => {
    const mine = itemFor('u1')
    const backend = await outboxOf('u1', [mine])
    setOutboxBackendForTests(backend)
    const told = vi.fn()
    onOutboxChanged(told)
    checkOutboxOwner(personOf('u1'))
    for (let i = 0; i < 5; i++) await settled()
    // Theirs already: nothing dropped, nothing marked, nothing to read.
    expect(told).not.toHaveBeenCalled()
    await wipeOutboxForBusiness({ businessId: B2 }, 'u1', 'removed')
    // At once, and again only if anything went.
    expect(told).toHaveBeenCalledTimes(1)
    await wipeOutboxForBusiness({ businessId: B1 }, 'u1', 'removed')
    expect(told).toHaveBeenCalledTimes(3)
    told.mockClear()
    backend.items.set(mine.localId, structuredClone(mine))
    await markSessionEnded('u1', NOW)
    expect(told).toHaveBeenCalledTimes(1)
  })

  test('and when storage answers again after a read that failed, with nothing to show till then', async () => {
    vi.useFakeTimers()
    const backend = await outboxOf('u1', [itemFor('u1')])
    backend.unavailable = true
    setOutboxBackendForTests(backend)
    const told = vi.fn()
    onOutboxChanged(told)
    expect(await peekOutbox()).toBe('error')
    expect(told).not.toHaveBeenCalled()
    backend.unavailable = false
    await vi.advanceTimersByTimeAsync(PEEK_RETRY_MS[0])
    expect(told).toHaveBeenCalledTimes(1)
  })

  test('a business someone was removed from takes only what was kept by then: invited back and booking again in the same page load, that stays', async () => {
    vi.useFakeTimers({ now: NOW })
    const before = itemFor('u1', {}, NOW - 1)
    const backend = await outboxOf('u1', [before])
    setOutboxBackendForTests(backend)
    await peekOutbox()
    await wipeOutboxForBusiness({ businessId: B1 }, 'u1', 'no-access')
    vi.setSystemTime(NOW + 60_000)
    const after = itemFor('u1', {}, NOW + 60_000)
    backend.items.set(after.localId, structuredClone(after))
    expect(stillKept(before)).toBe(false)
    expect(stillKept(after)).toBe(true)
    const read = await readOutboxNow()
    expect(read !== 'error' && read.items.map((i) => i.localId)).toEqual([
      after.localId,
    ])
    // Nor does the delete take one kept after it was asked, by another tab
    // whose keep lands first.
    const late = itemFor('u1', {}, NOW + 60_000)
    const slow = await outboxOf('u1', [late])
    setOutboxBackendForTests(slow)
    vi.setSystemTime(NOW)
    await wipeOutboxWhere('u1', () => true, 'earlier-stint')
    expect([...slow.items.keys()]).toEqual([late.localId])
  })

  test('without localStorage, a wipe in this tab while a fresh read is out has the last word, for every read after too', async () => {
    vi.stubGlobal('localStorage', undefined)
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    setOutboxBackendForTests(backend)
    await peekOutbox()
    // The read answers with the item: the wipe lands after it.
    const reading = readOutboxNow()
    void wipeOutbox('sign-out')
    const read = await reading
    expect(read !== 'error' && read.items).toEqual([])
    const peek = await peekOutbox()
    expect(peek !== 'error' && peek.items).toEqual([])
  })
})
