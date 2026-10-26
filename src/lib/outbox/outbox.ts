import {
  changeOutboxItem,
  onOutboxChanged,
  onOutboxWiped,
  peekOutbox,
  readOutboxNow,
  stillKept,
} from './outboxStore'
import type { Change, StoreResult } from './outboxStore'
import type { OutboxItem } from './outboxItem'

/**
 * The bookings kept on this phone, as this tab knows them: what the sender
 * (sender.ts) and, later, the screens read, in memory.
 *
 * Read once at the page load (`peekOutbox`, started as the store loads),
 * then kept up to date by every change this tab makes through `change`, and
 * read again whenever anything else may have changed them:
 * - another tab, which says so on the `pestm8-outbox` BroadcastChannel after
 *   each of its changes;
 * - this tab's store, changing them in bulk (`onOutboxChanged`: a business
 *   someone was removed from, a page load's sweep, a claim, a session that
 *   ended), or wiping them, which empties this at once (`onOutboxWiped`).
 *
 * Every item handed out is asked again whether it is still on the phone
 * (`stillKept`): a sign-out in another tab discards a booking the moment it
 * is asked, by a note in localStorage, whatever this tab last read.
 *
 * Nothing here writes a booking: only the guarded changes do, in the store.
 */

const CHANNEL = 'pestm8-outbox'

/** Enough of a BroadcastChannel; none in a browser without one. */
export type OutboxChannel = {
  postMessage: (message: unknown) => void
  close: () => void
  onmessage: ((event: MessageEvent) => void) | null
}

function browserChannel(): OutboxChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(CHANNEL)
  } catch {
    return null
  }
}

/** A name for this tab: whose an Edit's lease is. */
function newTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`
  }
}

/** How many times one refresh reads again for changes made while it read. */
const REREADS = 3

export class OutboxModel {
  private items = new Map<string, OutboxItem>()
  private read = false
  // Bumped by every change this tab hands in, so a read that was out while
  // one landed is read again rather than taken over it.
  private version = 0
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private stops: Array<() => void> = []
  private channel: OutboxChannel | null = null
  private readonly listeners = new Set<() => void>()

  /** This tab, for whose an Edit's lease is (`editing.tab`). */
  readonly tab = newTabId()
  /**
   * The bookings an Edit is open on in this tab: never sent from here,
   * whatever the lease says, which can run out while iOS has the page
   * suspended.
   */
  readonly editingHere = new Set<string>()

  /**
   * Starts following the outbox, in the browser: once, however often it is
   * asked. Returns the way to stop, for tests.
   */
  start(makeChannel: () => OutboxChannel | null = browserChannel): () => void {
    if (this.stops.length > 0) return () => {}
    this.channel = makeChannel()
    if (this.channel) {
      this.channel.onmessage = () => {
        void this.refresh()
      }
    }
    this.stops.push(
      onOutboxWiped(() => {
        this.items.clear()
        this.read = true
        this.version++
        this.notify()
        this.post()
      }),
      onOutboxChanged(() => {
        void this.refresh()
        this.post()
      }),
      () => {
        this.channel?.close()
        this.channel = null
      },
    )
    void this.refresh()
    return () => this.stop()
  }

  private stop(): void {
    for (const stop of this.stops.splice(0)) stop()
  }

  /** Whether this tab has read the outbox yet. */
  readable(): boolean {
    return this.read
  }

  /** Every booking still on the phone, as this tab knows them. */
  all(): Array<OutboxItem> {
    return [...this.items.values()].filter(stillKept)
  }

  get(localId: string): OutboxItem | undefined {
    const item = this.items.get(localId)
    return item && stillKept(item) ? item : undefined
  }

  /** Called whenever what `all` hands out may have changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Reads the outbox again, and takes what it holds. One at a time: asked
   * while one is out, it reads once more after. A read that was out while
   * this tab changed something is read again, so it never puts back what
   * was there before.
   */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    const run = this.reread().finally(() => {
      this.refreshing = null
    })
    this.refreshing = run
    return run
  }

  private async reread(): Promise<void> {
    for (let round = 0; round < REREADS; round++) {
      this.refreshAgain = false
      const version = this.version
      const found = this.read ? await readOutboxNow() : await peekOutbox()
      // Storage not answering: what this tab has stands. The store tries
      // again by itself, and says so when it can (`onOutboxChanged`).
      if (found === 'error') return
      if (this.version !== version) this.refreshAgain = true
      else this.take(found.items)
      if (!this.refreshAgain) return
    }
  }

  private take(items: ReadonlyArray<OutboxItem>): void {
    const next = new Map(items.map((item) => [item.localId, item]))
    const changed =
      !this.read ||
      next.size !== this.items.size ||
      [...next].some(([localId, item]) => {
        const was = this.items.get(localId)
        return (
          was === undefined ||
          was.updatedAt !== item.updatedAt ||
          was.state !== item.state
        )
      })
    this.items = next
    this.read = true
    if (changed) this.notify()
  }

  /**
   * One guarded change to one booking (outboxStore.ts's changes), taken
   * into memory as it lands and told to every other tab. `op` names it in
   * the note a failure leaves.
   */
  async change(
    op: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ): Promise<StoreResult<OutboxItem | 'deleted'>> {
    const result = await changeOutboxItem(op, localId, change)
    if (typeof result === 'object') {
      this.items.set(localId, result)
      this.version++
      this.notify()
      this.post()
    } else if (result === 'deleted' || result === 'gone') {
      const dependants = this.all().some((item) => item.dependsOn === localId)
      if (this.items.delete(localId)) {
        this.version++
        this.notify()
      }
      if (result === 'deleted') this.post()
      // A discard takes the bookings made after it on it as well.
      if (dependants) void this.refresh()
    } else if (result === 'refused') {
      // A guard said no: what this tab holds is out of date.
      void this.refresh()
    }
    return result
  }

  private post(): void {
    try {
      this.channel?.postMessage({ changed: true })
    } catch {
      // A channel closed under it says nothing to anyone.
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One listener's trouble is not another's.
      }
    }
  }
}

/** This page load's. */
export const outbox = new OutboxModel()
