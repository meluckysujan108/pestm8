import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'

/** How often an open page asks whether there is a newer build. The app is
 * left open on a phone all day; a visit back to the tab asks too. */
const UPDATE_CHECK_MS = 30 * 60 * 1000

/**
 * Registers the worker built by scripts/build-sw.mjs, and says when a newer
 * version of the app has arrived.
 *
 * Dev is deliberately excluded: a stale precache during development produces
 * confusing "why is my change not showing" failures, and there is no offline
 * story worth testing against a local dev server.
 *
 * The worker skips waiting and claims open pages (src/sw.ts), so a new one
 * takes over this page as soon as it installs — but the JavaScript already
 * running is still the old build, calling functions whose arguments may since
 * have changed. So the page says so, and offers Reload. It never reloads by
 * itself: the person may be halfway through a booking or a report.
 */
export function ServiceWorker() {
  const [newVersion, setNewVersion] = useState(false)

  useEffect(() => {
    if (import.meta.env.DEV) return
    if (!('serviceWorker' in navigator)) return
    const sw = navigator.serviceWorker

    // The very first install also takes control of this page (clientsClaim),
    // and that is not a new version: this page was loaded from the network
    // and is already current. Only a change of worker after one was in
    // charge — or already active when we registered — is news.
    let hadWorker = sw.controller !== null
    const onControllerChange = () => {
      if (hadWorker) setNewVersion(true)
      hadWorker = true
    }
    sw.addEventListener('controllerchange', onControllerChange)

    let registration: ServiceWorkerRegistration | undefined
    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible') return
      // Offline, or the server down: it will ask again later.
      registration?.update().catch(() => {})
    }
    const onVisibility = () => checkForUpdate()
    document.addEventListener('visibilitychange', onVisibility)
    const every = setInterval(checkForUpdate, UPDATE_CHECK_MS)

    const register = () => {
      sw.register('/sw.js')
        .then((reg) => {
          registration = reg
          // A shift-reload leaves the page uncontrolled with a worker
          // already active; the next one to claim it is still a new version.
          if (reg.active) hadWorker = true
        })
        .catch(() => {
          // An unavailable worker degrades to a normal online-only app, which
          // is the correct outcome — never block the page on it.
        })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })

    return () => {
      sw.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('load', register)
      clearInterval(every)
    }
  }, [])

  if (!newVersion) return null

  // Bottom of the screen, just above the phone's tab bar (68px + the home
  // indicator) and bottom-right on a desktop, where it covers no navigation.
  // z-30 sits under the tab bar and under every sheet and dialog (their
  // scrim is z-40): a sheet opened over it hides it, so it can never land on
  // top of a sheet's Save button. Closing the sheet brings it back.
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-[420px] items-center gap-2 rounded-2xl border border-hairline bg-surface py-1.5 pl-4 pr-1.5 shadow-elevation lg:inset-x-auto lg:bottom-4 lg:right-4"
    >
      <p className="min-w-0 flex-1 text-caption text-ink">
        A new version of PestM8 is ready.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-blue/10 px-3.5 text-[15px] font-semibold text-blue-ink transition active:scale-[.975]"
      >
        <RefreshCw aria-hidden className="size-4" />
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setNewVersion(false)}
        className="flex size-11 shrink-0 items-center justify-center rounded-xl text-grey-ink"
      >
        <X aria-hidden className="size-5" />
      </button>
    </div>
  )
}
