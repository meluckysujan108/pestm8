import type { Locks } from './outboxLocks'

/**
 * Web Locks in memory, for tests: one lock manager shared by every tab of a
 * phone, as the browser's is per origin, with a `Locks` for each tab
 * (`forTab`). Granted as the spec grants them: shared beside shared,
 * exclusive alone, in the order asked for, so a request waiting for an
 * exclusive lock keeps a later shared one out; `ifAvailable` only when
 * nothing holds or waits for it in the way; `signal` gives a wait up.
 * `query` says what each tab holds and waits for.
 */

type Held = { name: string; mode: LockMode; clientId: string }
type Waiting = Held & { grant: () => void; drop: (error: unknown) => void }

export class FakeLockManager {
  readonly held: Array<Held> = []
  readonly waiting: Array<Waiting> = []

  /** What one tab, named `clientId`, asks of `navigator.locks`. */
  forTab(clientId: string): Locks {
    return {
      request: (
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ) => {
        const options =
          typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
        const callback =
          typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : (maybeCallback as LockGrantedCallback<unknown>)
        return this.request(clientId, name, options, callback)
      },
      query: () =>
        Promise.resolve({
          held: this.held.map((lock) => ({ ...lock })),
          pending: this.waiting.map(({ name, mode, clientId: id }) => ({
            name,
            mode,
            clientId: id,
          })),
        }),
    }
  }

  /** Whether any tab holds `name`. */
  isHeld(name: string, clientId?: string): boolean {
    return this.held.some(
      (lock) =>
        lock.name === name &&
        (clientId === undefined || lock.clientId === clientId),
    )
  }

  private grantable(name: string, mode: LockMode, ahead: number): boolean {
    const holding = this.held.filter((lock) => lock.name === name)
    if (
      mode === 'exclusive'
        ? holding.length > 0
        : holding.some((l) => l.mode === 'exclusive')
    ) {
      return false
    }
    return !this.waiting.slice(0, ahead).some((wait) => wait.name === name)
  }

  private request(
    clientId: string,
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<unknown>,
  ): Promise<unknown> {
    const mode = options.mode ?? 'exclusive'
    const run = (): Promise<unknown> => {
      const lock: Held = { name, mode, clientId }
      this.held.push(lock)
      let result: Promise<unknown>
      try {
        result = Promise.resolve(callback({ name, mode }))
      } catch (error) {
        result = Promise.reject(error)
      }
      const release = () => {
        const at = this.held.indexOf(lock)
        if (at >= 0) this.held.splice(at, 1)
        this.next()
      }
      return result.then(
        (value) => {
          release()
          return value
        },
        (error: unknown) => {
          release()
          throw error
        },
      )
    }
    if (this.grantable(name, mode, this.waiting.length)) return run()
    if (options.ifAvailable) {
      return Promise.resolve(callback(null))
    }
    return new Promise((resolve, reject) => {
      const wait: Waiting = {
        name,
        mode,
        clientId,
        grant: () => {
          run().then(resolve, reject)
        },
        drop: reject,
      }
      this.waiting.push(wait)
      options.signal?.addEventListener('abort', () => {
        const at = this.waiting.indexOf(wait)
        if (at < 0) return
        this.waiting.splice(at, 1)
        reject(
          Object.assign(new Error('The request was aborted.'), {
            name: 'AbortError',
          }),
        )
        this.next()
      })
    })
  }

  /** Grants whatever can be now, in the order asked for. */
  private next(): void {
    for (let i = 0; i < this.waiting.length; i++) {
      const wait = this.waiting[i]
      if (!this.grantable(wait.name, wait.mode, i)) continue
      this.waiting.splice(i, 1)
      i--
      wait.grant()
    }
  }
}
