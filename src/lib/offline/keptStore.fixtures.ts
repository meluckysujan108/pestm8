import { claimOwner, mayWrite, stampOwner } from './keptStore'
import type {
  KeptBackend,
  KeptChange,
  KeptClaim,
  KeptOwner,
  KeptPeek,
  KeptRow,
} from './keptStore'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The kept copy held in memory, for tests (`setKeptBackendForTests`). It
 * makes the same decisions as the IndexedDB backend (`claimOwner`,
 * `mayWrite`, `stampOwner`), and its operations take effect one at a time,
 * in the order they were asked, a tick later: as transactions over the same
 * stores do.
 */
export class MemoryKeptBackend implements KeptBackend {
  owner: KeptOwner | null = null
  rows = new Map<string, KeptRow>()
  /** Each operation that ran, by name, in the order it ran. */
  done: Array<string> = []
  /** True: every operation fails, as a refused IndexedDB's does. */
  unavailable = false
  private queue: Promise<unknown> = Promise.resolve()
  private epochs = 0

  private run<T>(name: string, failed: T, work: () => T): Promise<T> {
    const next = this.queue.then(() => {
      if (this.unavailable) return failed
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

  peek(): Promise<KeptPeek | null> {
    return this.run('peek', null, () => ({
      owner: this.owner && { ...this.owner },
      rows: [...this.rows.values()],
    }))
  }

  whose(): Promise<{ owner: KeptOwner | null } | null> {
    return this.run('whose', null, () => ({
      owner: this.owner && { ...this.owner },
    }))
  }

  claim(
    next: KeptClaim,
  ): Promise<{ epoch: string; changed: KeptChange } | null> {
    return this.run('claim', null, () => {
      const claimed = claimOwner(
        this.owner,
        next,
        Date.now(),
        () => `epoch-${++this.epochs}`,
      )
      if (claimed.changed !== 'none') this.rows.clear()
      this.owner = claimed.owner
      return { epoch: claimed.owner.epoch, changed: claimed.changed }
    })
  }

  write(
    epoch: string,
    userId: string,
    put: Array<KeptRow>,
    drop: Array<string>,
  ): Promise<boolean> {
    return this.run('write', false, () => {
      if (!mayWrite(this.owner, epoch, userId)) return false
      for (const hash of drop) this.rows.delete(hash)
      for (const row of put) this.rows.set(row.hash, row)
      return true
    })
  }

  stamp(epoch: string, userId: string, liveAt: number): Promise<boolean> {
    return this.run('stamp', false, () => {
      if (!mayWrite(this.owner, epoch, userId)) return false
      this.owner = stampOwner(this.owner, liveAt)
      return true
    })
  }

  wipe(): Promise<void> {
    return this.run('wipe', undefined, () => {
      this.owner = null
      this.rows.clear()
    })
  }
}

/** A claim for `userId`, owning business b1 under their own view. */
export function claimFor(
  userId: string,
  extra: Partial<KeptClaim> = {},
): KeptClaim {
  return {
    userId,
    businessId: 'b1' as Id<'businesses'>,
    slug: 'pest-co',
    timezone: 'Australia/Perth',
    membershipId: `m-${userId}` as Id<'memberships'>,
    lens: `m-${userId}|-`,
    ...extra,
  }
}

/** A kept day of b1's, under `lens`. */
export function dayRow(dayKey: string, lens: string, data: unknown = []) {
  return {
    hash: `listDay:${dayKey}`,
    fn: 'jobs:listDay',
    queryKey: ['convexQuery', 'jobs:listDay', { businessId: 'b1', dayKey }],
    businessId: 'b1',
    lens,
    data,
    savedAt: 1_000,
    shape: 1,
    build: 'test',
  } satisfies KeptRow
}

/** A phone that already keeps `userId`'s copy, with one day in it. */
export async function keptFor(userId: string): Promise<MemoryKeptBackend> {
  const backend = new MemoryKeptBackend()
  const claimed = await backend.claim(claimFor(userId))
  if (!claimed) throw new Error('claim failed')
  await backend.write(
    claimed.epoch,
    userId,
    [dayRow('2026-10-26', `m-${userId}|-`)],
    [],
  )
  return backend
}
