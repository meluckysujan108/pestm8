import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { APP_VERSION } from '#/lib/appVersion'
import { watchForNewBuild } from '#/lib/workerVersion'

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
 * running may still be the old build, calling functions whose arguments may
 * since have changed. So the page says so, and offers Reload. It never
 * reloads by itself: the person may be halfway through a booking or a report.
 */
export function ServiceWorker() {
  const [newVersion, setNewVersion] = useState(false)

  useEffect(() => {
    if (import.meta.env.DEV) return
    if (!('serviceWorker' in navigator)) return
    const sw = navigator.serviceWorker

    let stopped = false
    const onNewBuild = () => {
      if (!stopped) setNewVersion(true)
    }
    const watch = watchForNewBuild(APP_VERSION, onNewBuild)
    const onControllerChange = () => watch.controllerChanged(sw.controller)
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
          reg.addEventListener('updatefound', () =>
            watch.installing(reg.installing),
          )
        })
        .catch(() => {
          // An unavailable worker degrades to a normal online-only app, which
          // is the correct outcome — never block the page on it.
        })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })

    return () => {
      stopped = true
      sw.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('load', register)
      clearInterval(every)
    }
  }, [])

  if (!newVersion) return null
  return (
    <NewVersionBanner
      onReload={() => window.location.reload()}
      onDismiss={() => setNewVersion(false)}
    />
  )
}

/**
 * At the top of the screen, under the page header — not the bottom, where it
 * used to sit just above the tab bar. That is where the pages with work to
 * finish keep their own fixed action bars: the report builder's Back / Next /
 * Finalise and the template editor's Save / Issue both sit 64px up, and at
 * the same z-30 this, painted later, covered them across the phone's width.
 * Nothing that saves or moves on lives under the header: what it can cover
 * there scrolls, or is the schedule's week strip, and Dismiss is one tap.
 *
 * 84px clears the tallest header (76px with a kicker line) with a gap, plus
 * the notch or status bar that the header itself pads for. z-30 puts it over
 * the page and its sticky strips (z-20) but under every sheet, dialog and
 * menu (their scrim is z-40), so it never lands on a sheet's Save button;
 * closing the sheet brings it back.
 */
export function NewVersionBanner({
  onReload,
  onDismiss,
}: {
  onReload: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      className="fixed inset-x-4 top-[calc(84px+env(safe-area-inset-top))] z-30 mx-auto flex max-w-[420px] items-center gap-2 rounded-2xl border border-hairline bg-surface py-1.5 pl-4 pr-1.5 shadow-elevation lg:inset-x-auto lg:right-4"
    >
      <p className="min-w-0 flex-1 text-caption text-ink">
        A new version of PestM8 is ready.
      </p>
      <button
        type="button"
        onClick={onReload}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-blue/10 px-3.5 text-[15px] font-semibold text-blue-ink transition active:scale-[.975]"
      >
        <RefreshCw aria-hidden className="size-4" />
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex size-11 shrink-0 items-center justify-center rounded-xl text-grey-ink"
      >
        <X aria-hidden className="size-5" />
      </button>
    </div>
  )
}
