import { describe, expect, it } from 'vitest'
import {
  VERSION_REQUEST,
  answerVersionRequest,
  askWorkerVersion,
  isOtherBuild,
  watchForNewBuild,
} from './workerVersion'

/** A worker as far as the page sees one: it answers the version question the
 * way src/sw.ts does, from the build it was made in. */
function fakeWorker(version: string | null) {
  const listeners = new Set<() => void>()
  const worker = {
    state: 'installing' as ServiceWorkerState,
    postMessage(message: unknown, transfer: Array<MessagePort>) {
      // A worker from before workers were asked says nothing.
      if (version !== null) answerVersionRequest(message, transfer, version)
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    becomes(state: ServiceWorkerState) {
      worker.state = state
      for (const fn of [...listeners]) fn()
    },
  }
  return worker
}

const asWorker = (w: ReturnType<typeof fakeWorker>) =>
  w as unknown as ServiceWorker

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('the worker says which build it is', () => {
  it('answers the question on the port it came with', async () => {
    expect(await askWorkerVersion(asWorker(fakeWorker('abc1234')))).toBe(
      'abc1234',
    )
  })

  it('leaves every other message alone', () => {
    const sent: Array<unknown> = []
    const port = { postMessage: (m: unknown) => sent.push(m) }
    expect(answerVersionRequest({ type: 'SKIP_WAITING' }, [port], 'a')).toBe(
      false,
    )
    expect(answerVersionRequest('hello', [port], 'a')).toBe(false)
    expect(answerVersionRequest({ type: VERSION_REQUEST }, [port], 'a')).toBe(
      true,
    )
    expect(sent).toEqual([{ type: VERSION_REQUEST, version: 'a' }])
  })

  it('is null, not a guess, from a worker that never answers', async () => {
    expect(await askWorkerVersion(asWorker(fakeWorker(null)), 30)).toBeNull()
  })
})

describe('when the page says a new version is ready', () => {
  it('says nothing when the worker that takes over is this same build', async () => {
    // Straight after a deploy: the page came from the network as the new
    // build, and the new worker of that deploy claims it a moment later.
    // Deciding by the change of worker said "new version" here, every time.
    let told = 0
    const watch = watchForNewBuild('abc1234', () => told++)
    watch.controllerChanged(asWorker(fakeWorker('abc1234')))
    await settle()
    expect(told).toBe(0)
  })

  it('says so when the worker is from another build', async () => {
    let told = 0
    const watch = watchForNewBuild('abc1234', () => told++)
    watch.controllerChanged(asWorker(fakeWorker('def5678')))
    await settle()
    expect(told).toBe(1)
  })

  it('says nothing about a worker that does not answer', async () => {
    let told = 0
    const watch = watchForNewBuild(
      'abc1234',
      () => told++,
      (w) => askWorkerVersion(w, 30),
    )
    watch.controllerChanged(asWorker(fakeWorker(null)))
    await settle()
    await settle()
    expect(told).toBe(0)
  })

  it('asks an installing worker once it is running, and each worker once', async () => {
    let told = 0
    const asked: Array<unknown> = []
    const watch = watchForNewBuild(
      'abc1234',
      () => told++,
      (w) => {
        asked.push(w)
        return askWorkerVersion(w)
      },
    )
    const next = fakeWorker('def5678')
    watch.installing(asWorker(next))
    next.becomes('installed')
    expect(asked).toHaveLength(0)
    next.becomes('activated')
    // The same worker then claims the page: not asked, or told, twice.
    watch.controllerChanged(asWorker(next))
    await settle()
    expect(asked).toHaveLength(1)
    expect(told).toBe(1)
  })

  it('compares builds, and an unknown one is never news', () => {
    expect(isOtherBuild('abc1234', 'abc1234')).toBe(false)
    expect(isOtherBuild('def5678', 'abc1234')).toBe(true)
    expect(isOtherBuild(null, 'abc1234')).toBe(false)
  })
})
