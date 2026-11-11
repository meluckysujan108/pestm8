import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { FakeLockManager } from '#/lib/outbox/fakeLocks.fixtures'
import { STORE_OP_MS } from '#/lib/outbox/outboxSet'
import { itemFor } from '#/lib/outbox/outboxStore.fixtures'
import { OutboxItemBody } from './OutboxItemSheet'
import type * as React from 'react'
import type { ReactElement } from 'react'
import type { ItemDeps } from '#/lib/outbox/itemActions'
import type { OutboxFooter } from '#/lib/outbox/outboxInset'
import type { OutboxItem } from '#/lib/outbox/outboxItem'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * A booking's sheet over time (plan part 2c §9.5, §10.3), its body run as a
 * hook: what an Edit begun as the sheet closes leaves behind, whether a
 * lease run out still locks it, and when it hands over to its job.
 */

vi.mock('react', async (importOriginal) => {
  const { hookHarness: harness } = await import('#/lib/offline/hooks.fixtures')
  return {
    ...(await importOriginal<typeof React>()),
    ...harness.hooks,
    useContext: () => null,
    useId: () => 'x',
  }
})
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
vi.mock('#/lib/rootState', () => ({
  signedInUserId: () => 'u1',
  signedOutAfterAll: vi.fn(async () => false),
}))
vi.mock('#/lib/connectionLog', () => ({ logConnection: vi.fn() }))

/** What the sheet reads, set by each test. */
type Reads = {
  item: unknown
  deps: unknown
  refusedFinds: number
  locks: unknown
}

const at = vi.hoisted(() => {
  const reads: Reads & { prefetch: ReturnType<typeof vi.fn> } = {
    item: undefined,
    deps: null,
    prefetch: vi.fn(() => Promise.resolve()),
    refusedFinds: 0,
    locks: null,
  }
  return reads
})

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({
    getQueryData: () => undefined,
    prefetchQuery: at.prefetch,
  }),
}))
vi.mock('#/lib/access', () => ({
  useAccess: () => ({ caps: { 'prices.see': true } }),
}))
vi.mock('#/lib/offline/useLineDown', () => ({ useLineDown: () => null }))
vi.mock('#/lib/useHydrated', () => ({ useHydrated: () => true }))
vi.mock('#/lib/offline/keeper', () => ({
  keeper: { subscribe: () => () => {}, lineLive: () => false },
}))
vi.mock('#/lib/outbox/sender', () => ({
  sender: {
    heldReason: () => 'line',
    sendingHere: () => false,
    sendingElsewhere: () => false,
    storageNotAnswering: () => false,
    refusedFinds: () => at.refusedFinds,
  },
}))
vi.mock('#/lib/outbox/outbox', () => ({
  outbox: {
    tab: 'tab-here',
    editingHere: new Set<string>(),
    get: () => undefined,
    answeredWith: () => undefined,
  },
}))
vi.mock('#/lib/outbox/outboxLocks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  browserLocks: () => at.locks,
  lockHeld: async () => false,
}))
vi.mock('#/lib/outbox/useOutbox', () => ({
  useOutboxItem: () => at.item,
  pageItemDeps: () => at.deps,
}))

type Measured = { current: unknown }

type Body = ReactElement<{
  footer: OutboxFooter | null
  holdFooter: boolean
  alert: string | null
  busy: boolean
  onEdit: () => void
  onDiscard: () => void
  onFix: (fix: 'send') => void
  bodyRef: Measured
  footerRef: Measured
  children: [
    ReactElement<{
      open: boolean
      pending: boolean
      onConfirm: () => void
      onOpenChange: (open: boolean) => void
    }>,
    ReactElement<{ children: ReactElement<{ onClose: () => void }> }> | false,
  ]
}>

type Answer = Awaited<ReturnType<ItemDeps['change']>>

/** The sheet's own changes, answered by hand where `hold` says, and as
 * `answers` says for the rest. */
function fakeDeps(
  item: OutboxItem,
  hold: Array<string> = [],
  answers: Record<string, Answer> = {},
) {
  const ops: Array<string> = []
  const held = new Map<string, (value: Answer) => void>()
  const deps: ItemDeps = {
    tab: 'tab-here',
    editingHere: new Set<string>(),
    landingHere: new Set<string>(),
    get: () => at.item as OutboxItem | undefined,
    refresh: async () => {},
    change: (op) => {
      ops.push(op)
      if (hold.includes(op)) {
        return new Promise((resolve) => held.set(op, resolve))
      }
      return Promise.resolve(answers[op] ?? item)
    },
    changeLanded: async () => item,
    locks: null,
    lineLive: () => false,
    sender: {
      kick: vi.fn(),
      sendHeld: vi.fn(),
      sendingHere: () => false,
    },
    now: () => Date.now(),
  }
  at.deps = deps
  return {
    deps,
    ops,
    answer: (op: string, value: Answer) => held.get(op)?.(value),
  }
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function mount(item: OutboxItem, onSent = vi.fn(), onClose = vi.fn()) {
  at.item = item
  const sheet = hookHarness.mount(
    () =>
      OutboxItemBody({
        businessId: 'b1' as Id<'businesses'>,
        localId: item.localId,
        timezone: 'Australia/Perth',
        onSent,
        onClose,
      }) as Body,
  )
  return { sheet, onSent }
}

beforeEach(() => {
  at.prefetch.mockReset()
  at.prefetch.mockImplementation(() => Promise.resolve())
  at.refusedFinds = 0
  at.locks = null
})

afterEach(() => vi.useRealTimers())

describe('an Edit begun as the sheet closes', () => {
  test('lets the booking go once its begin lands, so it is sent again and nothing says it is being changed', async () => {
    const item = itemFor('u1', {}, Date.now())
    const fake = fakeDeps(item, ['begin-edit'])
    const { sheet } = mount(item)
    sheet.current().props.onEdit()
    await settle()
    expect(fake.ops).toContain('begin-edit')
    expect(fake.deps.editingHere.has(item.localId)).toBe(true)
    // ✕, a swipe or Back while the phone's storage is slow.
    sheet.unmount()
    fake.answer('begin-edit', {
      ...item,
      editing: { tab: 'tab-here', until: Date.now() + 600_000 },
    })
    await settle()
    expect(fake.deps.editingHere.has(item.localId)).toBe(false)
    expect(fake.ops).toContain('end-edit')
  })
})

describe('another tab’s Edit', () => {
  test.each([
    ['waiting', {}],
    ['needing a look', { state: 'needsLook', problem: { code: 'SERVER' } }],
  ] as const)(
    '%s: its lease running out with the sheet open unlocks it, with no signal',
    (_, extra) => {
      vi.useFakeTimers()
      const T0 = Date.UTC(2026, 10, 7, 1)
      vi.setSystemTime(T0)
      const item = itemFor(
        'u1',
        {
          ...(extra as Partial<OutboxItem>),
          editing: { tab: 'tab-there', until: T0 + 5 * 60_000 },
        },
        T0 - 60_000,
      )
      fakeDeps(item)
      const { sheet } = mount(item)
      expect(sheet.current().props.footer?.locked).toBe(true)
      vi.advanceTimersByTime(5 * 60_000 + 1)
      expect(sheet.current().props.footer?.locked).toBe(false)
      sheet.unmount()
    },
  )
})

describe('the hand-over to its job', () => {
  test('waits for the job to be read, so the sheet never opens on bones', async () => {
    let read: () => void = () => {}
    at.prefetch.mockImplementation(
      () => new Promise<void>((resolve) => (read = resolve)),
    )
    const item = itemFor(
      'u1',
      { state: 'sent', result: { id: 'j1' }, sentAt: Date.now() },
      Date.now(),
    )
    fakeDeps(item)
    const { sheet, onSent } = mount(item)
    expect(at.prefetch).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining([
          expect.objectContaining({ jobId: 'j1' }),
        ]),
      }),
    )
    await settle()
    expect(onSent).not.toHaveBeenCalled()
    read()
    await settle()
    expect(onSent).toHaveBeenCalledWith('j1', null)
    sheet.unmount()
  })

  test('tells the job how the body stood, its footer counted, so the job lands there and nothing moves', async () => {
    let read: () => void = () => {}
    at.prefetch.mockImplementation(
      () => new Promise<void>((resolve) => (read = resolve)),
    )
    const item = itemFor(
      'u1',
      { state: 'sent', result: { id: 'j1' }, sentAt: Date.now() },
      Date.now(),
    )
    fakeDeps(item)
    const { sheet, onSent } = mount(item)
    sheet.current().props.bodyRef.current = {
      getBoundingClientRect: () => ({ height: 340 }),
      scrollTop: 120,
    }
    sheet.current().props.footerRef.current = {
      getBoundingClientRect: () => ({ height: 69 }),
    }
    read()
    await settle()
    expect(onSent).toHaveBeenCalledWith('j1', { height: 409, scrollTop: 120 })
    sheet.unmount()
  })

  test('its footer’s space stays once it is sent, so the sheet’s top edge stays put; one opened already sent never had one', () => {
    const item = itemFor('u1', {}, Date.now())
    fakeDeps(item)
    const { sheet } = mount(item)
    expect(sheet.current().props.footer).not.toBeNull()
    expect(sheet.current().props.holdFooter).toBe(false)
    const sent = {
      ...item,
      state: 'sent' as const,
      result: { id: 'j1' },
      sentAt: 1,
    }
    at.item = sent
    sheet.rerender()
    expect(sheet.current().props.footer).toBeNull()
    expect(sheet.current().props.holdFooter).toBe(true)
    sheet.unmount()
    const again = mount(sent)
    expect(again.sheet.current().props.holdFooter).toBe(false)
    again.sheet.unmount()
  })

  test('never while its Edit is open: what was typed stays until the form is closed', async () => {
    const item = itemFor('u1', {}, Date.now())
    const fake = fakeDeps(item)
    const { sheet, onSent } = mount(item)
    sheet.current().props.onEdit()
    await settle()
    expect(fake.deps.editingHere.has(item.localId)).toBe(true)
    // Another tab sent it, the lease having run out while this one slept.
    at.item = { ...item, state: 'sent', result: { id: 'j1' }, sentAt: 1 }
    sheet.rerender()
    await settle()
    expect(onSent).not.toHaveBeenCalled()
    const form = sheet.current().props.children[1]
    if (!form) throw new Error('New Job isn’t open')
    form.props.children.props.onClose()
    await settle()
    expect(onSent).toHaveBeenCalledWith('j1', null)
    sheet.unmount()
  })
})

describe('Discard', () => {
  test('landing once the sheet has gone closes nothing: the page’s close would act on the page Back landed on', async () => {
    const item = itemFor('u1', {}, Date.now())
    const fake = fakeDeps(item, ['discard'])
    const onClose = vi.fn()
    const { sheet } = mount(item, vi.fn(), onClose)
    sheet.current().props.children[0].props.onConfirm()
    await settle()
    expect(fake.ops).toContain('discard')
    sheet.unmount()
    fake.answer('discard', 'deleted')
    await settle()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('landing with the sheet up closes it', async () => {
    const item = itemFor('u1', {}, Date.now())
    const onClose = vi.fn()
    fakeDeps(item, [], { discard: 'deleted' })
    const { sheet } = mount(item, vi.fn(), onClose)
    sheet.current().props.children[0].props.onConfirm()
    await settle()
    expect(onClose).toHaveBeenCalledOnce()
    sheet.unmount()
  })

  test('over an Edit open in another tab it is refused, and says so', async () => {
    const item = itemFor(
      'u1',
      { editing: { tab: 'tab-there', until: Date.now() + 60_000 } },
      Date.now(),
    )
    fakeDeps(item, [], { discard: 'refused' })
    const { sheet } = mount(item)
    sheet.current().props.children[0].props.onConfirm()
    await settle()
    expect(sheet.current().props.alert).toBe('OUTBOX_DISCARD_ELSEWHERE')
    sheet.unmount()
  })
})

describe('a tap the phone’s storage hasn’t answered in time', () => {
  test('Discard: it may land yet, so it never says nothing was changed', async () => {
    const item = itemFor('u1', {}, Date.now())
    fakeDeps(item, [], { discard: 'error' })
    const { sheet } = mount(item)
    sheet.current().props.children[0].props.onConfirm()
    await settle()
    expect(sheet.current().props.alert).toBe('OUTBOX_STORAGE_UNSURE')
    sheet.unmount()
  })

  test('Send: the same', async () => {
    const item = itemFor(
      'u1',
      { state: 'needsLook', problem: { code: 'STALE' } },
      Date.now(),
    )
    fakeDeps(item, [], { 'send-now': 'error' })
    const { sheet } = mount(item)
    sheet.current().props.onFix('send')
    await settle()
    expect(sheet.current().props.alert).toBe('OUTBOX_STORAGE_UNSURE')
    sheet.unmount()
  })
})

describe('“This may already be booked”', () => {
  test('the phone’s storage never answering: the dialog goes within its limit and says it can’t tell yet, as any other tap does', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 7, 1))
    at.locks = {}
    at.refusedFinds = 3
    const item = itemFor(
      'u1',
      { state: 'sending', lastAttemptAt: Date.now() - 60_000 },
      Date.now() - 120_000,
    )
    const fake = fakeDeps(item)
    fake.deps.locks = new FakeLockManager().forTab('a')
    fake.deps.changeLanded = () => new Promise(() => {})
    const { sheet } = mount(item)
    await settle()
    expect(sheet.current().props.footer?.discard).toBe('mayHaveGone')
    sheet.current().props.onDiscard()
    expect(sheet.current().props.children[0].props.open).toBe(true)
    sheet.current().props.children[0].props.onConfirm()
    await settle()
    expect(sheet.current().props.children[0].props.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(STORE_OP_MS)
    await settle()
    expect(sheet.current().props.busy).toBe(false)
    expect(sheet.current().props.children[0].props.open).toBe(false)
    expect(sheet.current().props.children[0].props.pending).toBe(false)
    expect(sheet.current().props.alert).toBe('OUTBOX_STORAGE_UNSURE')
    sheet.unmount()
  })

  test('a free lock seen for one send stands for no later one', async () => {
    at.locks = {}
    at.refusedFinds = 3
    const item = itemFor(
      'u1',
      { state: 'sending', lastAttemptAt: Date.now() - 60_000 },
      Date.now() - 120_000,
    )
    fakeDeps(item)
    const { sheet } = mount(item)
    await settle()
    expect(sheet.current().props.footer?.discard).toBe('mayHaveGone')
    // Settled, unlocked and sent again, as one change seen.
    at.item = { ...item, lastAttemptAt: Date.now() }
    sheet.rerender()
    expect(sheet.current().props.footer).toMatchObject({
      discard: 'item',
      locked: true,
    })
    sheet.unmount()
  })
})
