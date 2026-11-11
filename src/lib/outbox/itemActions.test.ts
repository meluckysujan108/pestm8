import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeLockManager } from './fakeLocks.fixtures'
import {
  beginEdit,
  discardItem,
  endEdit,
  lapseLeftEdits,
  renewEdit,
  replaceItem,
  sendItem,
} from './itemActions'
import { OutboxModel } from './outbox'
import { itemLock, takeLock } from './outboxLocks'
import { EDIT_LEASE_MS, STORE_OP_MS } from './outboxSet'
import {
  beginSendChange,
  checkOutboxOwner,
  setOutboxBackendForTests,
} from './outboxStore'
import {
  DISPLAY,
  bookingFor,
  itemFor,
  memoryStorage,
  outboxOf,
  personOf,
} from './outboxStore.fixtures'
import type { ItemDeps } from './itemActions'
import type { OutboxChannel } from './outbox'
import type { OutboxItem } from './outboxItem'
import type { MemoryOutboxBackend } from './outboxStore.fixtures'

/**
 * What a booking's sheet does to the booking (plan part 2c §9.5, §9.7,
 * §10.3), across two tabs sharing one phone's storage: an Edit holds it
 * for this tab and, by its lease, for others; Book from it replaces it under
 * its own ids; Discard and Send only while nothing can have been made of
 * it; and each refusal says why, in the phone's own words.
 */

vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

const settled = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

const channel = (): OutboxChannel => ({
  postMessage: vi.fn(),
  close: vi.fn(),
  onmessage: null,
})

const stops: Array<() => void> = []
let clock = 10_000

async function tabOn(
  backend: MemoryOutboxBackend,
  locks: FakeLockManager,
  name: string,
  lineLive = false,
) {
  setOutboxBackendForTests(backend)
  checkOutboxOwner(personOf('u1'))
  const model = new OutboxModel()
  stops.push(model.start(channel))
  await settled()
  const sendHeld = vi.fn(async () => ({ outcome: 'kept' as const }))
  const deps: ItemDeps = {
    tab: model.tab,
    editingHere: model.editingHere,
    landingHere: model.landingHere,
    get: (localId) => model.get(localId),
    refresh: () => model.refresh(),
    change: (op, localId, change) => model.change(op, localId, change),
    changeLanded: (op, localId, change) =>
      model.changeLanded(op, localId, change),
    locks: locks.forTab(name),
    lineLive: () => lineLive,
    sender: { kick: vi.fn(), sendHeld, sendingHere: vi.fn(() => false) },
    now: () => clock,
  }
  return { model, deps, sendHeld }
}

async function twoTabs(items: Array<OutboxItem>, lineLive = false) {
  const backend = await outboxOf('u1', items)
  const locks = new FakeLockManager()
  const a = await tabOn(backend, locks, 'a', lineLive)
  const b = await tabOn(backend, locks, 'b', lineLive)
  return { backend, locks, a, b }
}

/** Every write to the phone's storage waits while it is shut, in order, as
 * a stalled IndexedDB does. */
function stall(backend: MemoryOutboxBackend) {
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const update = backend.update.bind(backend)
  backend.update = async (...args: Parameters<typeof update>) => {
    await gate
    return update(...args)
  }
  return {
    shut: () => {
      gate = new Promise((resolve) => (open = resolve))
    },
    open: () => open(),
  }
}

/** Every write is applied and then waits while shut: a transaction whose
 * commit is slow, the change function long since run. */
function stallCommit(backend: MemoryOutboxBackend) {
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const update = backend.update.bind(backend)
  backend.update = async (...args: Parameters<typeof update>) => {
    const written = await update(...args)
    await gate
    return written
  }
  return {
    shut: () => {
      gate = new Promise((resolve) => (open = resolve))
    },
    open: () => open(),
  }
}

beforeEach(() => {
  clock = 10_000
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
})

describe('Edit', () => {
  test('holds it in this tab at once, and for other tabs by its lease', async () => {
    const item = itemFor('u1')
    const { a, backend } = await twoTabs([item])
    const begun = beginEdit(item.localId, a.deps)
    // Synchronously, before the store answers: this tab never sends it.
    expect(a.model.editingHere.has(item.localId)).toBe(true)
    const result = await begun
    expect('item' in result && result.item.editing).toEqual({
      tab: a.model.tab,
      until: clock + EDIT_LEASE_MS,
    })
    expect(backend.items.get(item.localId)?.editing?.tab).toBe(a.model.tab)
    // Another tab's sender doesn't start it while the lease runs.
    expect(beginSendChange(clock + 1)(backend.items.get(item.localId)!)).toBe(
      'abort',
    )
  })

  test('refused once it began sending after the sheet was drawn: no form, and why', async () => {
    const item = itemFor('u1')
    const { a, b } = await twoTabs([item])
    await b.model.change('send', item.localId, beginSendChange(clock))
    const result = await beginEdit(item.localId, a.deps)
    expect(result).toEqual({ data: 'OUTBOX_EDIT_REFUSED' })
    expect(a.model.editingHere.has(item.localId)).toBe(false)
  })

  test('refused while another tab is changing it', async () => {
    const item = itemFor('u1')
    const { a, b } = await twoTabs([item])
    expect('item' in (await beginEdit(item.localId, b.deps))).toBe(true)
    await settled()
    expect(await beginEdit(item.localId, a.deps)).toEqual({
      data: 'OUTBOX_EDIT_ELSEWHERE',
    })
  })

  test('the lease is renewed while the form is open, and lapses if it isn’t', async () => {
    const item = itemFor('u1')
    const { a, b, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    clock += 5 * 60_000
    renewEdit(item.localId, a.deps)
    await settled()
    expect(backend.items.get(item.localId)?.editing?.until).toBe(
      clock + EDIT_LEASE_MS,
    )
    // Suspended past the lease (iOS): another tab may send it, while this
    // tab, which still has it in its set, never does.
    clock += EDIT_LEASE_MS + 1
    const sent = await b.model.change(
      'send',
      item.localId,
      beginSendChange(clock),
    )
    expect(typeof sent === 'object' && sent.state).toBe('sending')
    expect(a.model.editingHere.has(item.localId)).toBe(true)
  })

  test('one left open by a page that has gone holds it from nobody: another page’s Edit takes it at once, while one still open stands', async () => {
    const item = itemFor('u1')
    const { a, b, locks, backend } = await twoTabs([item])
    expect('item' in (await beginEdit(item.localId, a.deps))).toBe(true)
    await settled()
    expect(
      await lapseLeftEdits([backend.items.get(item.localId)!], b.deps),
    ).toBe(false)
    expect(await beginEdit(item.localId, b.deps)).toEqual({
      data: 'OUTBOX_EDIT_ELSEWHERE',
    })
    // Reloaded, closed, or killed by iOS, with New Job open.
    locks.closeTab('a')
    const begun = await beginEdit(item.localId, b.deps)
    expect('item' in begun && begun.item.editing?.tab).toBe(b.model.tab)
  })

  test('this tab’s own, with no Edit open here (a begin given up that landed late), is let go', async () => {
    const item = itemFor('u1')
    const { a, backend } = await twoTabs([item])
    backend.items.set(item.localId, {
      ...structuredClone(item),
      editing: { tab: a.model.tab, until: clock + EDIT_LEASE_MS },
    })
    await a.model.refresh()
    expect(await lapseLeftEdits([a.model.get(item.localId)!], a.deps)).toBe(
      true,
    )
    expect(backend.items.get(item.localId)?.editing).toBeNull()
  })

  test('closing it lets it go, so it goes again by itself', async () => {
    const item = itemFor('u1')
    const { a, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    endEdit(item.localId, a.deps)
    expect(a.model.editingHere.has(item.localId)).toBe(false)
    await settled()
    expect(backend.items.get(item.localId)?.editing).toBeNull()
    expect(a.deps.sender.kick).toHaveBeenCalled()
  })
})

describe('Book, from an Edit', () => {
  const next = (extra = {}) => ({
    booking: bookingFor({ scheduledAt: Date.UTC(2026, 9, 27, 3), ...extra }),
    display: DISPLAY,
  })

  test('replaces it under its own ids, with the line down kept to go', async () => {
    const item = itemFor('u1')
    const { a, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    const replaced = vi.fn()
    const outcome = await replaceItem(item.localId, next(), a.deps, replaced)
    expect(outcome).toEqual({ outcome: 'kept' })
    expect(replaced).toHaveBeenCalledOnce()
    const now = backend.items.get(item.localId)!
    expect(now.booking.scheduledAt).toBe(Date.UTC(2026, 9, 27, 3))
    expect(now.requestId).toBe(item.requestId)
    expect(now.state).toBe('waiting')
    expect(now.editing).toBeNull()
    expect(a.model.editingHere.has(item.localId)).toBe(false)
    expect(a.sendHeld).not.toHaveBeenCalled()
  })

  test('with the line live, sent as New Job sends one it kept, under its lock', async () => {
    const item = itemFor('u1')
    const { a } = await twoTabs([item], true)
    await beginEdit(item.localId, a.deps)
    a.sendHeld.mockResolvedValueOnce({ outcome: 'sent', id: 'j1' } as never)
    const outcome = await replaceItem(item.localId, next(), a.deps)
    expect(outcome).toEqual({ outcome: 'sent', id: 'j1' })
    expect(a.sendHeld).toHaveBeenCalledWith(
      item.localId,
      expect.objectContaining({ name: itemLock(item.localId) }),
    )
  })

  test('refused after another tab sent it, the lease having lapsed: the form says so and keeps what was typed', async () => {
    const item = itemFor('u1')
    const { a, b, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    clock += EDIT_LEASE_MS + 1
    await b.model.change('send', item.localId, beginSendChange(clock))
    await expect(replaceItem(item.localId, next(), a.deps)).rejects.toEqual({
      data: 'OUTBOX_EDIT_SENT',
    })
    expect(backend.items.get(item.localId)?.booking).toEqual(item.booking)
    // Still this tab's to close.
    expect(a.model.editingHere.has(item.localId)).toBe(true)
  })

  test.each([
    ['sending', { state: 'sending' as const }],
    ['sent', { state: 'sent' as const, result: { id: 'j1' }, sentAt: 1 }],
  ])(
    'refused, with its lease let go, once it really is %s: says it was sent',
    async (_, extra) => {
      const item = itemFor('u1')
      const { a, backend } = await twoTabs([item])
      await beginEdit(item.localId, a.deps)
      backend.items.set(item.localId, {
        ...structuredClone(backend.items.get(item.localId)!),
        ...extra,
        editing: null,
      })
      await expect(replaceItem(item.localId, next(), a.deps)).rejects.toEqual({
        data: 'OUTBOX_EDIT_SENT',
      })
    },
  )

  test.each([
    ['waiting', {}],
    [
      'needing a look',
      { state: 'needsLook' as const, problem: { code: 'SERVER' } },
    ],
  ])(
    '%s, its lease let go as the page went into the back/forward cache: never says it was sent, and the booking stays as it was',
    async (_, extra) => {
      const item = itemFor('u1', extra)
      const { a, b, locks, backend } = await twoTabs([item])
      await beginEdit(item.localId, a.deps)
      await settled()
      // Safari lets go of the page's locks; the other tab's tidy sees that.
      locks.closeTab('a')
      await b.model.refresh()
      await lapseLeftEdits([b.model.get(item.localId)!], b.deps)
      expect(backend.items.get(item.localId)?.editing).toBeNull()
      await expect(replaceItem(item.localId, next(), a.deps)).rejects.toEqual({
        data: 'OUTBOX_EDIT_LAPSED',
      })
      expect(backend.items.get(item.localId)?.booking).toEqual(item.booking)
      expect(backend.items.get(item.localId)?.state).toBe(item.state)
    },
  )

  test('its lease run out while suspended, and another tab’s Edit opened and closed on it: never says it was sent', async () => {
    const item = itemFor('u1')
    const { a, b, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    clock += EDIT_LEASE_MS + 1
    expect('item' in (await beginEdit(item.localId, b.deps))).toBe(true)
    endEdit(item.localId, b.deps)
    await settled()
    expect(backend.items.get(item.localId)?.editing).toBeNull()
    await expect(replaceItem(item.localId, next(), a.deps)).rejects.toEqual({
      data: 'OUTBOX_EDIT_LAPSED',
    })
  })

  test('waits for a lock another tab holds, and says so if it never comes', async () => {
    vi.useFakeTimers()
    try {
      const item = itemFor('u1')
      const { a, locks } = await (async () => {
        vi.useRealTimers()
        const made = await twoTabs([item])
        vi.useFakeTimers()
        return made
      })()
      await beginEdit(item.localId, a.deps)
      const held = await takeLock(locks.forTab('b'), itemLock(item.localId))
      const booking = replaceItem(item.localId, next(), a.deps)
      const refused = expect(booking).rejects.toEqual({
        data: 'OUTBOX_EDIT_BUSY',
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await refused
      held?.release()
    } finally {
      vi.useRealTimers()
    }
  })

  test('“Discard your changes?” confirmed while Book waits on the phone’s storage: the edits are never booked, nor sent', async () => {
    const item = itemFor('u1')
    const { a, backend } = await twoTabs([item], true)
    await beginEdit(item.localId, a.deps)
    const store = stall(backend)
    store.shut()
    let discarded = false
    const replaced = vi.fn()
    const booking = replaceItem(
      item.localId,
      next(),
      a.deps,
      replaced,
      () => discarded,
    )
    await settled()
    discarded = true
    endEdit(item.localId, a.deps)
    store.open()
    expect(await booking).toEqual({ outcome: 'kept' })
    await settled()
    expect(backend.items.get(item.localId)?.booking).toEqual(item.booking)
    expect(replaced).not.toHaveBeenCalled()
    expect(a.sendHeld).not.toHaveBeenCalled()
  })

  test.each([
    ['line live', true],
    ['line down', false],
  ])(
    '“Discard your changes?” confirmed as Book’s write is committing (%s): it goes back as the form opened on it, and is never sent',
    async (_, lineLive) => {
      const item = itemFor('u1', {
        state: 'needsLook',
        problem: { code: 'INVALID_ASSIGNEE' },
      })
      const { a, backend } = await twoTabs([item], lineLive)
      await beginEdit(item.localId, a.deps)
      const store = stallCommit(backend)
      store.shut()
      let discarded = false
      const replaced = vi.fn()
      const booking = replaceItem(
        item.localId,
        next(),
        a.deps,
        replaced,
        () => discarded,
      )
      await settled()
      // Written: only its commit is still out.
      expect(backend.items.get(item.localId)?.booking.scheduledAt).toBe(
        Date.UTC(2026, 9, 27, 3),
      )
      discarded = true
      endEdit(item.localId, a.deps)
      store.open()
      expect(await booking).toEqual({ outcome: 'kept' })
      await settled()
      const now = backend.items.get(item.localId)!
      expect(now.booking).toEqual(item.booking)
      expect(now.state).toBe('needsLook')
      expect(now.problem).toEqual({ code: 'INVALID_ASSIGNEE' })
      expect(now.editing).toBeNull()
      expect(replaced).not.toHaveBeenCalled()
      expect(a.sendHeld).not.toHaveBeenCalled()
    },
  )

  describe('the phone’s storage not answering', () => {
    /** Two tabs on fake timers, the line as given. */
    async function hung(lineLive = false) {
      const item = itemFor('u1')
      const made = await twoTabs([item], lineLive)
      await beginEdit(item.localId, made.a.deps)
      const store = stall(made.backend)
      store.shut()
      vi.useFakeTimers()
      return { item, store, ...made }
    }

    afterEach(() => vi.useRealTimers())

    /** A press of Book, its refusal caught as it comes, as fake timers run. */
    function press(
      made: Awaited<ReturnType<typeof hung>>,
      hooks: {
        replaced?: () => void
        discarded?: () => boolean
        landedLate?: () => void
      } = {},
    ) {
      return replaceItem(
        made.item.localId,
        next(),
        made.a.deps,
        hooks.replaced,
        hooks.discarded,
        hooks.landedLate,
      ).then(
        (value) => ({ resolved: value }),
        (error: unknown) => ({ rejected: error }),
      )
    }

    test('“Booking…” ends within the store’s limit, saying it can’t tell, with the booking’s lock still held', async () => {
      const made = await hung()
      const answer = press(made)
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      expect(await answer).toEqual({
        rejected: { data: 'OUTBOX_STORAGE_UNSURE' },
      })
      expect(made.locks.isHeld(itemLock(made.item.localId))).toBe(true)
      expect(made.a.model.landingHere.has(made.item.localId)).toBe(true)
    })

    test('a second press while the write is out is refused in the same words, never as another tab’s doing, and writes nothing more', async () => {
      const made = await hung()
      const update = vi.spyOn(made.backend, 'update')
      const first = press(made)
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      await first
      const writes = update.mock.calls.length
      const second = press(made)
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      expect(await second).toEqual({
        rejected: { data: 'OUTBOX_STORAGE_UNSURE' },
      })
      expect(update.mock.calls.length).toBe(writes)
    })

    test('landing late books it in its place, tells the form to close, and only then lets the lock go', async () => {
      const made = await hung()
      const replaced = vi.fn()
      const landedLate = vi.fn()
      const first = press(made, { replaced, landedLate })
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      await first
      expect(landedLate).not.toHaveBeenCalled()
      made.store.open()
      await vi.advanceTimersByTimeAsync(0)
      const now = made.backend.items.get(made.item.localId)!
      expect(now.booking.scheduledAt).toBe(Date.UTC(2026, 9, 27, 3))
      expect(replaced).toHaveBeenCalledOnce()
      expect(landedLate).toHaveBeenCalledOnce()
      expect(made.a.model.editingHere.has(made.item.localId)).toBe(false)
      expect(made.a.model.landingHere.has(made.item.localId)).toBe(false)
      expect(made.locks.isHeld(itemLock(made.item.localId))).toBe(false)
      expect(made.a.deps.sender.kick).toHaveBeenCalled()
    })

    test('landing late with the line live is sent, under the lock it held', async () => {
      const made = await hung(true)
      const first = press(made)
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      await first
      expect(made.a.sendHeld).not.toHaveBeenCalled()
      made.store.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(made.a.sendHeld).toHaveBeenCalledWith(
        made.item.localId,
        expect.objectContaining({ name: itemLock(made.item.localId) }),
      )
      // `sendHeld`'s to let go of now.
      expect(made.locks.isHeld(itemLock(made.item.localId))).toBe(true)
    })

    test('“Discard your changes?” confirmed after it gave up waiting: the edits are never booked, nor sent', async () => {
      const made = await hung(true)
      let discarded = false
      const landedLate = vi.fn()
      const first = press(made, {
        discarded: () => discarded,
        landedLate,
      })
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      await first
      discarded = true
      endEdit(made.item.localId, made.a.deps)
      made.store.open()
      await vi.advanceTimersByTimeAsync(0)
      const now = made.backend.items.get(made.item.localId)!
      expect(now.booking).toEqual(made.item.booking)
      expect(landedLate).not.toHaveBeenCalled()
      expect(made.a.sendHeld).not.toHaveBeenCalled()
      expect(made.locks.isHeld(itemLock(made.item.localId))).toBe(false)
    })

    test('never landing at all, the lock is held for the page, and nothing is unanswered on screen', async () => {
      const made = await hung()
      const first = press(made)
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(await first).toEqual({
        rejected: { data: 'OUTBOX_STORAGE_UNSURE' },
      })
      expect(made.locks.isHeld(itemLock(made.item.localId))).toBe(true)
    })
  })

  test('one-off to repeating adds to the kinds it went as only once it is sent', async () => {
    const item = itemFor('u1', { sentKinds: ['job'] })
    const { a, b, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    await replaceItem(
      item.localId,
      next({ repeat: { count: 3, unit: 'month' } }),
      a.deps,
    )
    let now = backend.items.get(item.localId)!
    expect(now.kind).toBe('series')
    expect(now.sentKinds).toEqual(['job'])
    await b.model.change('send', item.localId, beginSendChange(clock))
    now = backend.items.get(item.localId)!
    expect(now.sentKinds).toEqual(['job', 'series'])
  })
})

describe('Discard', () => {
  test('takes it off the phone while nothing can have been made of it', async () => {
    const item = itemFor('u1', {
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    const { a, backend } = await twoTabs([item])
    expect(await discardItem(item.localId, {}, a.deps)).toBe('discarded')
    expect(backend.items.has(item.localId)).toBe(false)
  })

  test('refused once another tab began sending it after the dialog opened', async () => {
    const item = itemFor('u1')
    const { a, b, backend } = await twoTabs([item])
    // The dialog is up; meanwhile another tab sends it.
    await b.model.change('send', item.localId, beginSendChange(clock))
    expect(await discardItem(item.localId, {}, a.deps)).toBe('refused')
    expect(backend.items.get(item.localId)?.state).toBe('sending')
  })

  test('refused while an Edit is open in another tab, whatever a sheet last read of its lease; let go once it runs out', async () => {
    const item = itemFor('u1')
    const { a, b, backend } = await twoTabs([item])
    await beginEdit(item.localId, a.deps)
    await settled()
    expect(await discardItem(item.localId, {}, b.deps)).toBe('elsewhere')
    expect(backend.items.has(item.localId)).toBe(true)
    clock += EDIT_LEASE_MS
    expect(await discardItem(item.localId, {}, b.deps)).toBe('discarded')
    expect(backend.items.has(item.localId)).toBe(false)
  })

  test('the phone’s storage not answering in time is `unsure`, as it may land yet', async () => {
    const item = itemFor('u1')
    const { a } = await twoTabs([item])
    vi.spyOn(a.deps, 'change').mockResolvedValueOnce('error')
    expect(await discardItem(item.localId, {}, a.deps)).toBe('unsure')
  })

  test('“This may already be booked”: only under its lock, free in every tab, with no call out here', async () => {
    const item = itemFor('u1', { state: 'sending', lastAttemptAt: 1 })
    const { a, locks, backend } = await twoTabs([item])
    // Held: another tab is asking whether it was booked, or sending it.
    const held = await takeLock(locks.forTab('b'), itemLock(item.localId))
    expect(await discardItem(item.localId, { mayHaveGone: true }, a.deps)).toBe(
      'busy',
    )
    held?.release()
    vi.mocked(a.deps.sender.sendingHere).mockReturnValueOnce(true)
    expect(await discardItem(item.localId, { mayHaveGone: true }, a.deps)).toBe(
      'refused',
    )
    // A plain Discard never takes one that is sending.
    expect(await discardItem(item.localId, {}, a.deps)).toBe('refused')
    expect(await discardItem(item.localId, { mayHaveGone: true }, a.deps)).toBe(
      'discarded',
    )
    expect(backend.items.has(item.localId)).toBe(false)
    expect(locks.isHeld(itemLock(item.localId))).toBe(false)
  })

  test('“This may already be booked”: held under its lock until the delete has really landed, however long the phone’s storage takes, while the sheet is told it can’t tell yet', async () => {
    vi.useFakeTimers()
    try {
      const item = itemFor('u1', { state: 'sending', lastAttemptAt: 1 })
      const { a, locks, backend } = await (async () => {
        vi.useRealTimers()
        const made = await twoTabs([item])
        vi.useFakeTimers()
        return made
      })()
      const store = stall(backend)
      store.shut()
      const discarding = discardItem(
        item.localId,
        { mayHaveGone: true },
        a.deps,
      )
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      // The sheet waits no longer than for any other tap.
      expect(await discarding).toBe('unsure')
      await vi.advanceTimersByTimeAsync(500)
      // No tab can settle or send it again meanwhile.
      expect(locks.isHeld(itemLock(item.localId))).toBe(true)
      expect(
        await takeLock(locks.forTab('b'), itemLock(item.localId), {
          ifAvailable: true,
        }),
      ).toBeNull()
      store.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(backend.items.has(item.localId)).toBe(false)
      expect(locks.isHeld(itemLock(item.localId))).toBe(false)
      expect(a.model.landingHere.has(item.localId)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('“This may already be booked”: a second Discard while the first is still out is told the same, not that PestM8 is checking', async () => {
    vi.useFakeTimers()
    try {
      const item = itemFor('u1', { state: 'sending', lastAttemptAt: 1 })
      const { a, backend } = await (async () => {
        vi.useRealTimers()
        const made = await twoTabs([item])
        vi.useFakeTimers()
        return made
      })()
      stall(backend).shut()
      const first = discardItem(item.localId, { mayHaveGone: true }, a.deps)
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      expect(await first).toBe('unsure')
      expect(
        await discardItem(item.localId, { mayHaveGone: true }, a.deps),
      ).toBe('unsure')
      expect(await discardItem(item.localId, {}, a.deps)).toBe('unsure')
    } finally {
      vi.useRealTimers()
    }
  })

  test('“This may already be booked”: never landing at all, the sheet is still answered, within the store’s limit', async () => {
    vi.useFakeTimers()
    try {
      const item = itemFor('u1', { state: 'sending', lastAttemptAt: 1 })
      const { a, backend } = await (async () => {
        vi.useRealTimers()
        const made = await twoTabs([item])
        vi.useFakeTimers()
        return made
      })()
      backend.update = () => new Promise(() => {})
      const discarding = discardItem(
        item.localId,
        { mayHaveGone: true },
        a.deps,
      )
      await vi.advanceTimersByTimeAsync(STORE_OP_MS)
      expect(await discarding).toBe('unsure')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Send and Try again', () => {
  test('Send, on one that waited too long: it goes, as the person’s say-so', async () => {
    const item = itemFor('u1', {
      state: 'needsLook',
      problem: { code: 'STALE' },
    })
    const { a, backend } = await twoTabs([item])
    expect(await sendItem(item.localId, a.deps)).toBe('going')
    const now = backend.items.get(item.localId)!
    expect(now.state).toBe('waiting')
    expect(now.confirmedAt).toBe(clock)
    expect(a.deps.sender.kick).toHaveBeenCalled()
  })

  test('Try again, on one the server wouldn’t take: it goes again, from no failures', async () => {
    const item = itemFor('u1', {
      state: 'needsLook',
      problem: { code: 'SERVER' },
      serverFailures: 3,
    })
    const { a, backend } = await twoTabs([item])
    expect(await sendItem(item.localId, a.deps)).toBe('going')
    const now = backend.items.get(item.localId)!
    expect(now.state).toBe('waiting')
    expect(now.serverFailures).toBe(0)
    expect(now.problem).toBeNull()
  })

  test('never on one that needs changing', async () => {
    const item = itemFor('u1', {
      state: 'needsLook',
      problem: { code: 'INVALID_ASSIGNEE' },
    })
    const { a, backend } = await twoTabs([item])
    expect(await sendItem(item.localId, a.deps)).toBe('refused')
    expect(backend.items.get(item.localId)?.state).toBe('needsLook')
  })
})
