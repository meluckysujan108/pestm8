import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OutboxModel } from './outbox'
import {
  beginSendChange,
  checkOutboxOwner,
  discardChange,
  markSessionEnded,
  setOutboxBackendForTests,
  wipeOutbox,
  wipeOutboxForBusiness,
  writeSignOutTombstone,
} from './outboxStore'
import {
  B2,
  bookingFor,
  itemFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import type { OutboxChannel } from './outbox'
import type { OutboxPeek } from './outboxStore'
import type { MemoryOutboxBackend } from './outboxStore.fixtures'

/**
 * The bookings as one tab holds them in memory. What matters: it never
 * hands out one a sign-out or a removal has discarded, whatever it last
 * read; every change this tab makes is in it at once and told to the other
 * tabs; and a read that was out while one landed never puts back what was
 * there before.
 */

vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

const settled = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

function channel() {
  const made: Array<OutboxChannel> = []
  return {
    make: (): OutboxChannel => {
      const one: OutboxChannel = {
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessage: null,
      }
      made.push(one)
      return one
    },
    get current() {
      return made[0]
    },
  }
}

const stops: Array<() => void> = []

async function tab(backend: MemoryOutboxBackend) {
  setOutboxBackendForTests(backend)
  checkOutboxOwner(personOf('u1'))
  const broadcast = channel()
  const model = new OutboxModel()
  const listener = vi.fn()
  model.subscribe(listener)
  stops.push(model.start(broadcast.make))
  await settled()
  return { model, broadcast, listener }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
})

describe('the bookings in memory', () => {
  test('are read once as it starts, and readable from then', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    const { model, listener } = await tab(backend)
    expect(model.readable()).toBe(true)
    expect(model.all().map((i) => i.localId)).toEqual([item.localId])
    expect(model.get(item.localId)?.requestId).toBe(item.requestId)
    expect(listener).toHaveBeenCalled()
    // Starting again reads nothing more.
    const reads = backend.done.filter((d) => d === 'peek').length
    model.start()
    await settled()
    expect(backend.done.filter((d) => d === 'peek').length).toBe(reads)
  })

  test('never hand out what a sign-out discarded, in this tab or another, whatever was read', async () => {
    const item = itemFor('u1')
    const { model } = await tab(await outboxOf('u1', [item]))
    writeSignOutTombstone('u1')
    expect(model.all()).toEqual([])
    expect(model.get(item.localId)).toBeUndefined()
  })

  test('a business someone was removed from goes at once, and is read again', async () => {
    const mine = itemFor('u1')
    const other = itemFor('u1', { businessId: B2, slug: 'other-co' })
    const backend = await outboxOf('u1', [mine, other])
    const { model, broadcast } = await tab(backend)
    const removal = wipeOutboxForBusiness({ businessId: B2 }, 'u1', 'removed')
    expect(model.all().map((i) => i.localId)).toEqual([mine.localId])
    await removal
    await settled()
    expect(model.all().map((i) => i.localId)).toEqual([mine.localId])
    // Other tabs are told.
    expect(broadcast.current.postMessage).toHaveBeenCalled()
  })

  test('a wipe empties it at once', async () => {
    const backend = await outboxOf('u1', [itemFor('u1')])
    const { model, listener } = await tab(backend)
    listener.mockClear()
    void wipeOutbox('sign-out')
    expect(model.all()).toEqual([])
    expect(listener).toHaveBeenCalled()
  })
})

describe('a change', () => {
  test('is in memory as it lands, and told to the other tabs', async () => {
    const item = itemFor('u1')
    const { model, broadcast, listener } = await tab(
      await outboxOf('u1', [item]),
    )
    listener.mockClear()
    const result = await model.change(
      'beginSend',
      item.localId,
      beginSendChange(5_000),
    )
    expect(typeof result === 'object' && result.state).toBe('sending')
    expect(model.get(item.localId)?.state).toBe('sending')
    expect(listener).toHaveBeenCalled()
    expect(broadcast.current.postMessage).toHaveBeenCalledWith({
      changed: true,
    })
  })

  test('a discard takes what was booked after it on it, in memory too', async () => {
    const parent = itemFor('u1')
    const child = itemFor('u1', {
      booking: bookingFor({ property: { local: parent.localId } }),
      dependsOn: parent.localId,
    })
    const { model } = await tab(await outboxOf('u1', [parent, child]))
    await model.change('discard', parent.localId, discardChange())
    await settled()
    expect(model.all()).toEqual([])
  })

  test('refused: what it held was out of date, so it reads again', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    const { model } = await tab(backend)
    // Another tab sent it meanwhile.
    backend.items.set(item.localId, { ...item, state: 'sending', updatedAt: 9 })
    await model.change('beginSend', item.localId, beginSendChange(5_000))
    await settled()
    expect(model.get(item.localId)?.state).toBe('sending')
  })
})

describe('reading again', () => {
  test('another tab’s word on the channel reads it again', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1')
    const { model, broadcast } = await tab(backend)
    expect(model.all()).toEqual([])
    backend.items.set(item.localId, structuredClone(item))
    broadcast.current.onmessage?.({ data: { changed: true } } as MessageEvent)
    await settled()
    expect(model.all().map((i) => i.localId)).toEqual([item.localId])
  })

  test('a read out while this tab changed something is read again, never taken over it', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    const { model } = await tab(backend)
    // The next read answers with what was there before, late.
    const before = structuredClone(item)
    let answer: (peek: OutboxPeek) => void = () => {}
    const realPeek = backend.peek.bind(backend)
    let late = true
    backend.peek = () => {
      if (!late) return realPeek()
      late = false
      return new Promise((resolve) => {
        answer = resolve
      })
    }
    const reading = model.refresh()
    await model.change('beginSend', item.localId, beginSendChange(5_000))
    answer({ owner: backend.owner, items: [before] })
    await reading
    await settled()
    expect(model.get(item.localId)?.state).toBe('sending')
  })

  test('a change in bulk this tab’s store makes (a session that ended) is read again', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    const { model, listener } = await tab(backend)
    listener.mockClear()
    await markSessionEnded('u1', 5_000)
    await settled()
    expect(model.get(item.localId)?.sessionEndedAt).toBe(5_000)
    expect(listener).toHaveBeenCalled()
  })

  test('storage not answering leaves what it holds', async () => {
    const item = itemFor('u1')
    const backend = await outboxOf('u1', [item])
    const { model } = await tab(backend)
    backend.unavailable = true
    await model.refresh()
    expect(model.all().map((i) => i.localId)).toEqual([item.localId])
  })
})

describe('a booking New Job keeps (`keep`)', () => {
  test('is in memory as it lands, told to the other tabs, noted as this tab’s own, and its revision moves', async () => {
    const backend = await outboxOf('u1', [])
    const { model, broadcast, listener } = await tab(backend)
    listener.mockClear()
    const before = model.revision()
    const item = itemFor('u1')
    expect(await model.keep(item)).toBe('kept')
    expect(model.get(item.localId)?.requestId).toBe(item.requestId)
    expect(backend.items.get(item.localId)?.state).toBe('waiting')
    expect(model.keptHere.has(item.localId)).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(model.revision()).toBeGreaterThan(before)
    expect(vi.mocked(broadcast.current.postMessage)).toHaveBeenCalled()
  })

  test('one the store refuses (another person’s) is neither in memory nor noted', async () => {
    const backend = await outboxOf('u1', [])
    const { model } = await tab(backend)
    const someoneElses = itemFor('u2')
    expect(await model.keep(someoneElses)).toBe('refused')
    expect(model.get(someoneElses.localId)).toBeUndefined()
    expect(model.keptHere.has(someoneElses.localId)).toBe(false)
  })
})
