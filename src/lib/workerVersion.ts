/**
 * How a page and the service worker agree on whether the app has moved on.
 *
 * The worker skips waiting and claims every open page (src/sw.ts), so it
 * changes under a page more often than the app does. Straight after a deploy,
 * a page loaded from the network is already the new build, and a moment
 * later the new worker from that same deploy claims it. A change of worker
 * alone said "a new version is ready" on every launch after every deploy,
 * over a page that was already that version — which teaches people to ignore
 * the one time it is true.
 *
 * So the page asks the worker which build it came from, and only a different
 * build is news. Both sides are built with the same short commit
 * (vite.config.ts for the app, scripts/build-sw.ts for the worker).
 *
 * Imported by the worker too, so nothing here may touch the DOM.
 */

/** The message a page posts to ask. */
export const VERSION_REQUEST = 'pestm8:version'

/** How long a page waits for the answer. A worker that has just taken over
 * answers at once; one that says nothing is from before workers were asked. */
export const VERSION_TIMEOUT_MS = 3000

/**
 * In the worker: answers a page's question on the port it sent. Returns
 * whether the message was that question, so other messages (Serwist's own)
 * are left alone.
 */
export function answerVersionRequest(
  data: unknown,
  ports: ReadonlyArray<Pick<MessagePort, 'postMessage'>>,
  version: string,
): boolean {
  if (typeof data !== 'object' || data === null) return false
  if ((data as { type?: unknown }).type !== VERSION_REQUEST) return false
  ports[0]?.postMessage({ type: VERSION_REQUEST, version })
  return true
}

/**
 * In the page: the build `worker` came from, or null when it does not say in
 * time. A worker built before workers were asked never answers, and null is
 * never news: a false "new version" is the failure this exists to stop.
 */
export function askWorkerVersion(
  worker: Pick<ServiceWorker, 'postMessage'>,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const done = (version: string | null) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(version)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const version = (event.data as { version?: unknown } | null)?.version
      done(typeof version === 'string' ? version : null)
    }
    try {
      worker.postMessage({ type: VERSION_REQUEST }, [channel.port2])
    } catch {
      // A worker already replaced (redundant) cannot be asked.
      done(null)
    }
  })
}

/** Whether a worker's build is not the one this page is running. */
export function isOtherBuild(
  workerVersion: string | null,
  pageVersion: string,
): boolean {
  return workerVersion !== null && workerVersion !== pageVersion
}

/**
 * What decides that the app has moved on under this page: a worker from
 * another build, asked as it takes this page over (controllerchange) or as it
 * finishes installing (updatefound), whichever comes first. Never the change
 * of worker by itself: straight after a deploy, that is the new worker of the
 * very build this page already is. Each worker is asked once, and one that
 * does not answer is not news.
 */
export function watchForNewBuild(
  pageVersion: string,
  onNewBuild: () => void,
  ask: (worker: ServiceWorker) => Promise<string | null> = askWorkerVersion,
) {
  const asked = new WeakSet<ServiceWorker>()
  const check = (worker: ServiceWorker | null | undefined) => {
    if (!worker || asked.has(worker)) return
    asked.add(worker)
    void ask(worker).then((version) => {
      if (isOtherBuild(version, pageVersion)) onNewBuild()
    })
  }
  return {
    controllerChanged: check,
    installing(worker: ServiceWorker | null | undefined) {
      if (!worker) return
      // Asked once it is running: while installing it is still precaching,
      // and Reload before that would load from the network anyway.
      const onState = () => {
        if (worker.state !== 'activated') return
        worker.removeEventListener('statechange', onState)
        check(worker)
      }
      worker.addEventListener('statechange', onState)
    },
  }
}
