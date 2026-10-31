import { logConnection } from '#/lib/connectionLog'
import {
  changeOutboxItem,
  keepOutboxItem,
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
 * A booking is written only by New Job's keep (`keep`) and the guarded
 * changes, in the store.
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

/** Whether this page load has asked the browser to keep its storage. */
let persistAsked = false

/**
 * After the first booking this page load keeps (plan §2.4): the browser
 * asked not to clear this site's storage under pressure. It matters most
 * for a Safari tab, whose storage is otherwise cleared after seven days
 * unused; a Home Screen app is spared that already. Asked once, and noted.
 */
function askToPersist(): void {
  if (persistAsked) return
  persistAsked = true
  try {
    const storage = (
      globalThis.navigator as
        { storage?: { persist?: () => Promise<boolean> } } | undefined
    )?.storage
    const asked = storage?.persist?.()
    if (!asked) return
    void asked.then(
      (granted) => logConnection('outbox-persist', { granted }),
      () => logConnection('outbox-persist', { granted: false }),
    )
  } catch {
    // A browser without it keeps what it keeps.
  }
}

export class OutboxModel {
  private items = new Map<string, OutboxItem>()
  private read = false
  // Bumped by every change this tab hands in, so a read that was out while
  // one landed is read again rather than taken over it.
  private version = 0
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  // Bumped whenever what `all` hands out may have changed (`revision`).
  private seen = 0
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
   * The bookings New Job kept in this tab this page load: the person's own
   * doing, just now, so a day's list may put them on screen where it would
   * put nothing else in after it has drawn (lib/outbox/latchSlots.ts).
   */
  readonly keptHere = new Set<string>()
  // Bookings whose New Job sheet in this tab is still deciding what became
  // of them (`deciding`), and those it closed on their job
  // (`answeredOnScreen`).
  private readonly decidingHere = new Set<string>()
  private readonly answeredOnScreenHere = new Set<string>()
  // The jobs the server has answered with, by booking, as soon as it does
  // (`noteAnswered`): before the phone's storage has it as sent.
  private readonly answers = new Map<string, { id: string; at: number }>()

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

  /**
   * A number that changes whenever what `all` hands out may have, for a
   * screen to read it again (`useSyncExternalStore`).
   */
  revision(): number {
    return this.seen
  }

  /** Called whenever what `all` hands out may have changed. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * A booking whose New Job sheet in this tab is still waiting to say what
   * became of it: kept, sent, or refused. A day's list draws none of these
   * (lib/outbox/latchSlots.ts `mayAdd`): booked with signal, a booking is
   * answered while its sheet is still up, and lands in the list as it always
   * did, never in a group under it; one the sheet closes on still kept is
   * drawn from then.
   */
  deciding(localId: string, on: boolean): void {
    const was = this.decidingHere.has(localId)
    if (on === was) return
    if (on) this.decidingHere.add(localId)
    else this.decidingHere.delete(localId)
    this.notify()
  }

  isDeciding(localId: string): boolean {
    return this.decidingHere.has(localId)
  }

  /**
   * A booking its New Job sheet in this tab closed on the job: booked with
   * signal, it lands in the day's list as it always did, and the list never
   * draws the booking itself, however its storage catches up, this page
   * load.
   */
  answeredOnScreen(localId: string): void {
    if (this.answeredOnScreenHere.has(localId)) return
    this.answeredOnScreenHere.add(localId)
    this.notify()
  }

  /** Whether a day's list may put `localId` on screen (`deciding`,
   * `answeredOnScreen`). */
  mayDraw(localId: string): boolean {
    return (
      !this.decidingHere.has(localId) && !this.answeredOnScreenHere.has(localId)
    )
  }

  /**
   * The server made `id` of `localId`: noted the moment its answer is in,
   * in the same turn, so a day's list can take the job for the booking's
   * from its first draw rather than once the phone's storage has caught up
   * (lib/outbox/latchSlots.ts `answeredView`). Only for drawing: what the
   * phone holds, and what the sender reads, is still the store's.
   */
  noteAnswered(localId: string, id: string, at: number): void {
    const was = this.answers.get(localId)
    if (was?.id === id) return
    this.answers.set(localId, { id, at })
    this.notify()
  }

  answeredWith(localId: string): { id: string; at: number } | undefined {
    return this.answers.get(localId)
  }

  /**
   * Keeps a booking New Job has just made (`keepOutboxItem`): in memory as
   * it lands, told to every other tab, and noted as this tab's own doing
   * (`keptHere`). The first this page load also asks the browser to keep
   * the site's storage (`askToPersist`). `landed`: what it came to in the
   * end, which may be after this has answered `'error'`
   * (`keepOutboxItem`); one kept that late is taken in as it lands, so a
   * booking on the phone is never one this tab doesn't know of.
   */
  async keep(
    item: OutboxItem,
    landed?: (result: 'kept' | 'exists' | 'refused' | 'error') => void,
  ): Promise<'kept' | 'exists' | 'refused' | 'error'> {
    let taken = false
    const take = () => {
      if (taken) return
      taken = true
      this.took(item)
    }
    const kept = await keepOutboxItem(item, (result) => {
      if (result === 'kept') take()
      landed?.(result)
    })
    if (kept === 'kept') take()
    return kept
  }

  /** A booking New Job kept in this tab, in memory from now. */
  private took(item: OutboxItem): void {
    this.items.set(item.localId, item)
    this.keptHere.add(item.localId)
    this.version++
    this.notify()
    this.post()
    askToPersist()
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
   * the note a failure leaves. One the store didn't answer in time
   * (`'error'`) may land yet: the outbox is read again once it has, so what
   * this tab holds is never left behind what the phone does. `landed` is
   * told what the change really came to, however long that takes, once this
   * tab holds it: never the store's `'error'` for taking too long, only one
   * for a change that failed (`changeLanded`).
   */
  async change(
    op: string,
    localId: string,
    change: (item: OutboxItem) => Change,
    landed?: (result: StoreResult<OutboxItem | 'deleted'>) => void,
  ): Promise<StoreResult<OutboxItem | 'deleted'>> {
    let answered = false
    let early: StoreResult<OutboxItem | 'deleted'> | undefined
    // Landed after the store's own limit: read again, then told.
    const lateLanded = (real: StoreResult<OutboxItem | 'deleted'>) => {
      if (real === 'error') {
        landed?.(real)
        return
      }
      void this.refresh().then(() => {
        this.post()
        landed?.(real)
      })
    }
    const result = await changeOutboxItem(op, localId, change, (real) => {
      if (answered) lateLanded(real)
      else early = real
    })
    answered = true
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
    if (result !== 'error') landed?.(result)
    // Its own answer by the time the store's was taken: a change that
    // failed, or one that landed as the store's limit ran out.
    else if (early !== undefined) lateLanded(early)
    return result
  }

  /**
   * `change`, answered with what it really came to, however long that
   * takes (`landed`), not with the store's `'error'` for taking too long: for
   * New Job's sheet, which decides what to show on what the phone did.
   */
  changeLanded(
    op: string,
    localId: string,
    change: (item: OutboxItem) => Change,
  ): Promise<StoreResult<OutboxItem | 'deleted'>> {
    return new Promise((resolve) => {
      void this.change(op, localId, change, resolve)
    })
  }

  private post(): void {
    try {
      this.channel?.postMessage({ changed: true })
    } catch {
      // A channel closed under it says nothing to anyone.
    }
  }

  private notify(): void {
    this.seen++
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
