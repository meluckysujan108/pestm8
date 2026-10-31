import { itemFromBooking } from './outboxItem'
import { claimDecision, keepDecision, updateDecision } from './outboxStore'
import type { Id } from '../../../convex/_generated/dataModel'
import type { BookingArgs, OutboxDisplay, OutboxItem } from './outboxItem'
import type {
  Change,
  OutboxBackend,
  OutboxOwner,
  OutboxPeek,
  OutboxUser,
  StoreResult,
} from './outboxStore'

/**
 * The outbox held in memory, for tests (`setOutboxBackendForTests`). It
 * makes the same decisions as the IndexedDB backend (`claimDecision`,
 * `keepDecision`, `updateDecision`), copies what it is given and hands out
 * copies, as IndexedDB does, and its operations take effect one at a time,
 * in the order they were asked, a tick later: as transactions over the same
 * stores do.
 */
export class MemoryOutboxBackend implements OutboxBackend {
  owner: OutboxOwner | null = null
  items = new Map<string, OutboxItem>()
  /** Each operation that ran, by name, in the order it ran. */
  done: Array<string> = []
  /** True: every operation fails, as a refused IndexedDB's does. */
  unavailable = false
  /** True: every operation from now on never answers, as WebKit's can. */
  hung = false
  private queue: Promise<unknown> = Promise.resolve()
  private epochs = 0

  private run<T>(name: string, work: () => T): Promise<T | 'error'> {
    if (this.hung) return new Promise(() => {})
    const next = this.queue.then(() => {
      if (this.unavailable) return 'error' as const
      this.done.push(name)
      return work()
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  /** How many wipes have taken effect. */
  get wipes(): number {
    return this.done.filter((name) => name === 'wipe').length
  }

  private all(): Array<OutboxItem> {
    return [...this.items.values()].map((item) => structuredClone(item))
  }

  peek(): Promise<OutboxPeek | 'error'> {
    return this.run('peek', () => ({
      owner: this.owner && { ...this.owner },
      items: this.all(),
    }))
  }

  claim(
    user: OutboxUser,
    now: number,
  ): Promise<
    { owner: OutboxOwner; dropped: number; marked: number } | 'error'
  > {
    return this.run('claim', () => {
      const { owner, drop, mark } = claimDecision(
        this.owner,
        this.all(),
        user,
        now,
        () => `epoch-${++this.epochs}`,
      )
      for (const localId of drop) this.items.delete(localId)
      for (const item of mark)
        this.items.set(item.localId, structuredClone(item))
      this.owner = owner
      return {
        owner: { ...owner },
        dropped: drop.length,
        marked: mark.length,
      }
    })
  }

  keep(
    epoch: string,
    item: OutboxItem,
    wanted: () => boolean = () => true,
  ): Promise<'kept' | 'exists' | 'refused' | 'error'> {
    return this.run('keep', () => {
      const decided = !wanted()
        ? 'refused'
        : keepDecision(this.owner, epoch, item, this.items.get(item.localId))
      if (decided === 'kept')
        this.items.set(item.localId, structuredClone(item))
      return decided
    })
  }

  update(
    epoch: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ): Promise<StoreResult<OutboxItem | 'deleted'>> {
    return this.run('update', () => {
      const decided = updateDecision(
        this.owner,
        epoch,
        this.all(),
        localId,
        change,
      )
      for (const gone of decided.drop) this.items.delete(gone)
      if (decided.put) this.items.set(localId, structuredClone(decided.put))
      return decided.result
    })
  }

  updateWhere(
    change: (item: OutboxItem) => OutboxItem | null,
  ): Promise<number | 'error'> {
    return this.run('updateWhere', () => {
      let changed = 0
      for (const item of this.all()) {
        const next = change(item)
        if (next === null) continue
        this.items.set(item.localId, structuredClone(next))
        changed++
      }
      return changed
    })
  }

  removeWhere(
    match: (item: OutboxItem, owner: OutboxOwner | null) => boolean,
  ): Promise<number | 'error'> {
    return this.run('removeWhere', () => {
      let removed = 0
      for (const item of this.all()) {
        if (!match(item, this.owner)) continue
        this.items.delete(item.localId)
        removed++
      }
      return removed
    })
  }

  wipe(): Promise<number | 'error'> {
    return this.run('wipe', () => {
      const count = this.items.size
      this.owner = null
      this.items.clear()
      return count
    })
  }
}

export const B1 = 'b1' as Id<'businesses'>
export const B2 = 'b2' as Id<'businesses'>

/** A one-off on an existing site of b1's, nothing typed but what must be. */
export function bookingFor(extra: Partial<BookingArgs> = {}): BookingArgs {
  return {
    businessId: B1,
    property: { propertyId: 'p1' as Id<'properties'> },
    assignedMembershipId: 'm-u1' as Id<'memberships'>,
    jobType: 'General Pest Control',
    price: 18_000,
    scheduledAt: Date.UTC(2026, 9, 27, 1),
    durationMinutes: 60,
    workOrder: undefined,
    notes: undefined,
    alsoGoing: undefined,
    repeat: null,
    ...extra,
  }
}

export const DISPLAY: OutboxDisplay = {
  clientName: 'Jane Nguyen',
  clientKind: 'person',
  clientPhone: '0400 000 000',
  clientEmail: '',
  contactPersonName: '',
  contactPersonPhone: '',
  siteContactName: '',
  siteContactPhone: '',
  addressLine: '1 Hay St',
  suburb: 'Perth',
  postcode: '6000',
  propertyState: 'WA',
  assigneeName: 'Kevin',
  assigneeColour: '#2563eb',
  alsoGoing: [],
}

let made = 0

/** An item of `userId`'s, waiting, made at `now`. */
export function itemFor(
  userId: string,
  extra: Partial<OutboxItem> = {},
  now = 1_000,
): OutboxItem {
  made++
  return {
    ...itemFromBooking(bookingFor(), {
      localId: `local-${made}`,
      requestId: `00000000-0000-4000-8000-${String(made).padStart(12, '0')}`,
      userId,
      business: { slug: 'pest-co', name: 'Pest Co' },
      membershipId: `m-${userId}` as Id<'memberships'>,
      display: DISPLAY,
      now,
    }),
    ...extra,
  }
}

/** The session every fixture claim is made in, unless a test says. */
export const SESSION = 'session-1'

/** Who a claim is for: in SESSION, unless a test says. */
export function personOf(
  userId: string,
  firstName = 'Kevin',
  sessionId = SESSION,
): OutboxUser {
  return { userId, firstName, sessionId }
}

/**
 * A phone whose outbox is `userId`'s, claimed in SESSION, with `items` in it
 * as they are: put there directly, so a test can hold what no keep would
 * let in (another person's, a newer build's, one already sending).
 */
export async function outboxOf(
  userId: string,
  items: Array<OutboxItem> = [],
  firstName = 'Kevin',
): Promise<MemoryOutboxBackend> {
  const backend = new MemoryOutboxBackend()
  const claimed = await backend.claim(personOf(userId, firstName), 500)
  if (claimed === 'error') throw new Error('claim failed')
  for (const item of items)
    backend.items.set(item.localId, structuredClone(item))
  backend.done = []
  return backend
}

/** localStorage, in memory: the edge runtime the tests run in has none. */
export function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}
