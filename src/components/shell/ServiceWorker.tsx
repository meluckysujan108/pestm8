import { useEffect } from 'react'

/**
 * Registers the worker built by scripts/build-sw.mjs.
 *
 * Dev is deliberately excluded: a stale precache during development produces
 * confusing "why is my change not showing" failures, and there is no offline
 * story worth testing against a local dev server.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (import.meta.env.DEV) return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // An unavailable worker degrades to a normal online-only app, which is
        // the correct outcome — never block the page on it.
      })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])

  return null
}
