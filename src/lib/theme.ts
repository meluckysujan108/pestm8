/**
 * Which theme the app renders in, and how that survives a reload.
 *
 * The preference is a cookie rather than localStorage because the server has to
 * be able to read it: `RootDocument` renders <html> during SSR, and a value
 * only the client can see cannot agree with a server render. That is the same
 * rule `components/ui/sidebar.tsx` states for its collapsed state — read the
 * cookie in `beforeLoad`, before anything renders.
 *
 * What the server reads is used to seed React state, never to render the
 * attribute. `themeInitScript` owns <html> exclusively, and reads the cookie
 * itself rather than trusting the served HTML, because `src/sw.ts` caches
 * navigations NetworkFirst under `pages`: a cached document can carry a theme
 * the user has since changed, while the cookie cannot go stale. Leaving React
 * with no prop for the attribute also means reconciliation has nothing to
 * clobber on a later render.
 */

export const THEME_COOKIE = 'pm8_theme'
export const THEME_MAX_AGE = 60 * 60 * 24 * 365

/** What the person chose. `system` defers to the OS, and is the default. */
export type ThemePref = 'light' | 'dark' | 'system'
/** What that resolves to once the OS preference is known. */
export type ResolvedTheme = 'light' | 'dark'

/** How each choice is named on screen — the Appearance page and its row on
 * the Settings hub, which must not disagree. */
export const THEME_LABEL: Record<ThemePref, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

export function normaliseThemePref(
  value: string | undefined | null,
): ThemePref {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function resolveTheme(
  pref: ThemePref,
  prefersDark: boolean,
): ResolvedTheme {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}

export const PREFERS_DARK = '(prefers-color-scheme: dark)'

/**
 * Runs in <head>, before <body> is parsed, so the first paint is already
 * correct — there is no frame on which the wrong theme is visible.
 *
 * Kept as a string so it closes over nothing and waits for no bundle. The
 * attribute names have to match `applyThemePref` below; that they can drift is
 * the reason both live in this file.
 *
 * The `(?:^|;\s*)` anchor matters: without it the pattern would also match a
 * cookie whose name merely *ends* in this one's.
 */
export const themeInitScript = `(function(){try{
var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark|system)/);
var p=m?m[1]:'system';
var d=p==='dark'||(p==='system'&&window.matchMedia('${PREFERS_DARK}').matches);
var r=document.documentElement;
r.dataset.themePref=p;
r.dataset.theme=d?'dark':'light';
}catch(e){}})()`

/**
 * The live preference, read back off the element `themeInitScript` wrote. Used
 * in place of the server's value once mounted, because the two disagree when
 * the service worker serves a cached document.
 */
export function readThemePref(): ThemePref {
  if (typeof document === 'undefined') return 'system'
  return normaliseThemePref(document.documentElement.dataset.themePref)
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia(PREFERS_DARK).matches
}

/**
 * Writes the preference and applies it in one go. Setting the attribute here
 * rather than routing it through React is what makes the switch instant: no
 * invalidate, no refetch, no server round trip. The next SSR navigation picks
 * the cookie up on its own.
 *
 * Deliberately not HttpOnly — the init script and this both need to read it. It
 * holds a UI preference and nothing else.
 */
export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement
  root.dataset.themePref = pref
  root.dataset.theme = resolveTheme(pref, systemPrefersDark())

  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${THEME_COOKIE}=${pref}; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax${secure}`
}
