/**
 * Just enough of IndexedDB to test how the outbox opens its database: opens
 * with and without a version, what an upgrade may do, and transactions that
 * commit or roll back as a whole. The edge runtime the tests run in has no
 * IndexedDB, and no package for one is installed.
 *
 * Faithful where the outbox depends on it:
 * - An open with no version opens the database at the version it is at, or
 *   makes it at 1 with an upgrade. An open at a lower version than the
 *   database's fails (VersionError); at a higher one, upgrades to it.
 * - Object stores are made only during an upgrade, and never twice under
 *   one name (ConstraintError). An upgrade that throws is undone, and its
 *   open fails (AbortError).
 * - An upgrade can be held up by a connection that won't close
 *   (`blockUpgrades`): its open is told `blocked`, and goes on once
 *   `unblock` is called.
 * - A transaction's requests answer in the order they were made, each a
 *   tick later, and it commits once none is left. One whose handler throws,
 *   or that is aborted, writes nothing; so does one whose commit fails
 *   (`failCommits`, as a full disk's would), which is told only `abort`.
 *   Transactions over a database run one at a time.
 * - What is put is copied when it is put, and what is read is a copy.
 * Nothing else: no key ranges, cursors or index reads.
 */

type StoreData = {
  keyPath: string
  rows: Map<string, unknown>
  indexes: Set<string>
}

export type FakeDatabase = {
  version: number
  stores: Map<string, StoreData>
  /** The transaction before the next one's turn. */
  turn: Promise<void>
}

type Handler = (() => void) | null

class FakeRequest<T> {
  result = undefined as T
  error: unknown = null
  onsuccess: Handler = null
  onerror: Handler = null
}

class FakeOpenRequest extends FakeRequest<FakeConnection> {
  onupgradeneeded: Handler = null
  onblocked: Handler = null
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function domError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

export class FakeIndexedDb {
  readonly databases = new Map<string, FakeDatabase>()
  /** Every open asked, by the version it gave: undefined for none. */
  readonly opens: Array<number | undefined> = []
  /** Every database anything asked to delete. */
  readonly deletes: Array<string> = []
  /** True: an open that needs an upgrade is blocked until `unblock`. */
  blockUpgrades = false
  /** True: every read-write transaction's commit fails from now on. */
  failCommits = false
  private readonly connections = new Set<FakeConnection>()
  private readonly heldUp: Array<() => void> = []

  /** The connections still open, for a test that they were all closed. */
  get openConnections(): number {
    return this.connections.size
  }

  /** The upgrades held up by `blockUpgrades` go on. */
  unblock(): void {
    this.blockUpgrades = false
    for (const go of this.heldUp.splice(0)) go()
  }

  /** A database as an earlier or later build left it. */
  seed(
    name: string,
    version: number,
    stores: Record<string, { keyPath: string; rows?: Array<unknown> }>,
  ): void {
    this.databases.set(name, {
      version,
      turn: Promise.resolve(),
      stores: new Map(
        Object.entries(stores).map(([store, { keyPath, rows = [] }]) => [
          store,
          {
            keyPath,
            indexes: new Set<string>(),
            rows: new Map(
              rows.map((row) => [
                String((row as Record<string, unknown>)[keyPath]),
                structuredClone(row),
              ]),
            ),
          },
        ]),
      ),
    })
  }

  open(name: string, version?: number): FakeOpenRequest {
    this.opens.push(version)
    const request = new FakeOpenRequest()
    void tick().then(() => {
      this.runOpen(name, version, request)
    })
    return request
  }

  deleteDatabase(name: string): FakeRequest<undefined> {
    this.deletes.push(name)
    const request = new FakeRequest<undefined>()
    void tick().then(() => {
      this.databases.delete(name)
      request.onsuccess?.()
    })
    return request
  }

  private runOpen(
    name: string,
    version: number | undefined,
    request: FakeOpenRequest,
  ): void {
    const existing = this.databases.get(name)
    const current = existing?.version ?? 0
    const target = version ?? Math.max(current, 1)
    if (target < current) {
      request.error = domError('VersionError')
      request.onerror?.()
      return
    }
    if (target > current && this.blockUpgrades) {
      request.onblocked?.()
      this.heldUp.push(() => this.upgrade(name, target, request))
      return
    }
    this.upgrade(name, target, request)
  }

  private upgrade(
    name: string,
    target: number,
    request: FakeOpenRequest,
  ): void {
    const existing = this.databases.get(name)
    const current = existing?.version ?? 0
    const data: FakeDatabase = existing ?? {
      version: 0,
      stores: new Map(),
      turn: Promise.resolve(),
    }
    this.databases.set(name, data)
    const connection = new FakeConnection(
      name,
      data,
      (closed) => this.connections.delete(closed),
      () => this.failCommits,
    )
    request.result = connection
    if (target > current) {
      for (const other of this.connections) {
        if (other.name === name) other.onversionchange?.()
      }
      const before = { version: data.version, stores: new Map(data.stores) }
      data.version = target
      connection.upgrading = true
      try {
        request.onupgradeneeded?.()
      } catch {
        // The upgrade's transaction aborts: as if it never began.
        data.version = before.version
        data.stores = before.stores
        if (!existing) this.databases.delete(name)
        request.error = domError('AbortError')
        request.onerror?.()
        return
      } finally {
        connection.upgrading = false
      }
    }
    this.connections.add(connection)
    request.onsuccess?.()
  }
}

class FakeConnection {
  onversionchange: Handler = null
  upgrading = false
  closed = false

  constructor(
    readonly name: string,
    private readonly data: FakeDatabase,
    private readonly onClose: (connection: FakeConnection) => void,
    private readonly failCommits: () => boolean,
  ) {}

  get version(): number {
    return this.data.version
  }

  get objectStoreNames(): { contains: (name: string) => boolean } {
    const names = [...this.data.stores.keys()]
    return { contains: (store) => names.includes(store) }
  }

  createObjectStore(
    name: string,
    options: { keyPath: string },
  ): { createIndex: (index: string, keyPath: unknown) => void } {
    if (!this.upgrading) throw domError('InvalidStateError')
    if (this.data.stores.has(name)) throw domError('ConstraintError')
    const store: StoreData = {
      keyPath: options.keyPath,
      rows: new Map(),
      indexes: new Set(),
    }
    this.data.stores.set(name, store)
    return {
      createIndex: (index) => {
        store.indexes.add(index)
      },
    }
  }

  transaction(
    names: string | Array<string>,
    mode: 'readonly' | 'readwrite' = 'readonly',
    _options?: { durability?: string },
  ): FakeTransaction {
    if (this.closed) throw domError('InvalidStateError')
    const list = typeof names === 'string' ? [names] : names
    for (const name of list) {
      if (!this.data.stores.has(name)) throw domError('NotFoundError')
    }
    return new FakeTransaction(this.data, list, mode, this.failCommits)
  }

  close(): void {
    this.closed = true
    this.onClose(this)
  }
}

class FakeTransaction {
  oncomplete: Handler = null
  onerror: Handler = null
  onabort: Handler = null
  private readonly queue: Array<() => void> = []
  private working = new Map<string, Map<string, unknown>>()
  private finished = false

  constructor(
    private readonly data: FakeDatabase,
    private readonly names: Array<string>,
    readonly mode: 'readonly' | 'readwrite',
    private readonly failCommit: () => boolean,
  ) {
    const started = data.turn.then(async () => {
      this.working = new Map(
        names.map((name) => [
          name,
          new Map(
            [
              ...(data.stores.get(name)?.rows ?? new Map<string, unknown>()),
            ].map(([key, row]) => [key, structuredClone(row)]),
          ),
        ]),
      )
      await this.run()
    })
    data.turn = started
  }

  objectStore(name: string): FakeStore {
    if (!this.names.includes(name)) throw domError('NotFoundError')
    const keyPath = this.data.stores.get(name)?.keyPath ?? 'id'
    return new FakeStore(this, name, keyPath)
  }

  /** A request on `store`'s rows, answered in its turn. */
  request<T>(
    store: string,
    work: (rows: Map<string, unknown>) => T,
  ): FakeRequest<T> {
    if (this.finished) throw domError('TransactionInactiveError')
    const request = new FakeRequest<T>()
    this.queue.push(() => {
      request.result = work(this.working.get(store) ?? new Map())
      request.onsuccess?.()
    })
    return request
  }

  writable(): void {
    if (this.mode === 'readonly') throw domError('ReadOnlyError')
  }

  abort(): void {
    if (this.finished) return
    this.finished = true
    this.queue.length = 0
    void tick().then(() => this.onabort?.())
  }

  private async run(): Promise<void> {
    for (;;) {
      await tick()
      if (this.finished) return
      const next = this.queue.shift()
      if (!next) break
      try {
        next()
      } catch {
        this.abort()
        return
      }
    }
    if (this.mode === 'readwrite' && this.failCommit()) {
      this.abort()
      return
    }
    this.finished = true
    if (this.mode === 'readwrite') {
      for (const [name, rows] of this.working) {
        const store = this.data.stores.get(name)
        if (store) store.rows = rows
      }
    }
    await tick()
    this.oncomplete?.()
  }
}

class FakeStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly name: string,
    private readonly keyPath: string,
  ) {}

  get(key: string): FakeRequest<unknown> {
    return this.tx.request(this.name, (rows) => {
      const row = rows.get(key)
      return row === undefined ? undefined : structuredClone(row)
    })
  }

  getAll(): FakeRequest<Array<unknown>> {
    return this.tx.request(this.name, (rows) =>
      [...rows.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, row]) => structuredClone(row)),
    )
  }

  count(): FakeRequest<number> {
    return this.tx.request(this.name, (rows) => rows.size)
  }

  put(value: unknown): FakeRequest<string> {
    this.tx.writable()
    const copy = structuredClone(value)
    const key = String((copy as Record<string, unknown>)[this.keyPath])
    return this.tx.request(this.name, (rows) => {
      rows.set(key, copy)
      return key
    })
  }

  delete(key: string): FakeRequest<undefined> {
    this.tx.writable()
    return this.tx.request(this.name, (rows) => {
      rows.delete(key)
      return undefined
    })
  }

  clear(): FakeRequest<undefined> {
    this.tx.writable()
    return this.tx.request(this.name, (rows) => {
      rows.clear()
      return undefined
    })
  }
}
