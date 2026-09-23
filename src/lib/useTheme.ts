import { useCallback, useEffect, useState } from 'react'
import {
  PREFERS_DARK,
  applyThemePref,
  readThemePref,
  resolveTheme,
} from '#/lib/theme'
import type { ThemePref } from '#/lib/theme'

/**
 * The current preference, and a setter that applies it immediately.
 *
 * `initial` is the cookie the server read, so the first client render agrees
 * with SSR and there is no hydration mismatch. The effect then reconciles
 * against <html>, which `themeInitScript` set from the *live* cookie — the two
 * disagree when the service worker replays a cached document (src/sw.ts), and
 * in that case the DOM is the one telling the truth.
 */
export function useThemePref(initial: ThemePref) {
  const [pref, setPref] = useState<ThemePref>(initial)

  useEffect(() => setPref(readThemePref()), [])

  const setTheme = useCallback((next: ThemePref) => {
    applyThemePref(next)
    setPref(next)
  }, [])

  return [pref, setTheme] as const
}

/**
 * Keeps `system` honest while the app is open: someone whose phone flips to
 * dark at sunset should see the app follow without reopening it.
 *
 * Writes the attribute directly rather than through React, for the same reason
 * `themeInitScript` does — see src/lib/theme.ts. Mounted once, at the root.
 */
export function useSystemThemeSync(): void {
  useEffect(() => {
    const mq = window.matchMedia(PREFERS_DARK)

    const sync = () => {
      const root = document.documentElement
      if (root.dataset.themePref !== 'system') return
      root.dataset.theme = resolveTheme('system', mq.matches)
    }

    /**
     * Reconciled once here, and not only on `change`. `themeInitScript` read
     * the OS while <head> was parsing; this effect runs after hydration, and a
     * flip inside that window is a `change` event no listener existed to hear.
     * Nothing else ever revisits the attribute while `system` is in force, so
     * the page stayed on the wrong theme for as long as it was open — which is
     * what made `e2e/theme.spec.ts` flaky rather than merely slow.
     *
     * A no-op when the OS has not moved, and an explicit light/dark choice is
     * left alone by the guard above.
     */
    sync()

    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
}
