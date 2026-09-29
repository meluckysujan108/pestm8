import { useSyncExternalStore } from 'react'
import {
  forgetInstalled,
  installMethod,
  rememberInstalled,
} from './installMethod'
import type { InstallMethod } from './installMethod'

/**
 * Putting PestM8 on the Home Screen — which matters more here than for most
 * web apps. Safari clears what a website has stored after seven days without
 * a visit; a Home Screen app is exempt, and the licence and products kept on
 * the phone for sites with no signal (keptLicence.ts, keptProducts.ts) are
 * exactly that kind of storage.
 *
 * iPhone has no install prompt at all: the only way is Share, then Add to
 * Home Screen, so set-up shows those steps. Chrome on Android offers one, but
 * fires its `beforeinstallprompt` once, early, whenever it decides to — so
 * the event is caught here, as this module loads, and kept for the screen
 * that offers it. It is not `preventDefault`ed: Chrome's own banner, where it
 * shows one, is left to do what it did before.
 *
 * Which steps each device is shown is lib/installMethod.ts; the screens that
 * show them are components/install/.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
/**
 * How far an install from this page has got: accepted in Chrome's prompt
 * (it can take a few seconds more), then confirmed by `appinstalled`.
 */
export type InstallProgress = 'installing' | 'installed'
let progress: InstallProgress | null = null
/** TanStack Router's key for the history entry the last Back or Forward
 * went to (`cameByHistory`). */
let traversedTo: string | undefined
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    deferred = event as InstallPromptEvent
    // Chrome offers only what is not installed: if this browser thought it
    // was, the app has since been deleted, and the schedule may ask again.
    forgetInstalled(browserStorage())
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    progress = 'installed'
    // So the schedule's card doesn't ask this browser again.
    rememberInstalled(browserStorage())
    notify()
  })
  window.addEventListener('popstate', () => {
    traversedTo = (window.history.state as { __TSR_key?: string } | null)
      ?.__TSR_key
  })
}

/**
 * Whether the page at this history entry (TanStack Router's key for it) was
 * reached with Back or Forward. The router puts the scroll back where it was
 * then, so nothing may appear above it that was not there before.
 */
export function cameByHistory(key: string | undefined): boolean {
  return key !== undefined && key === traversedTo
}

/** This browser's `localStorage`, or null where reading it throws (a
 * private window, storage switched off). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** How this browser installs PestM8 (lib/installMethod.ts). */
export function currentInstallMethod(): InstallMethod {
  const nav = navigator as Partial<Navigator>
  return installMethod({
    userAgent: nav.userAgent ?? '',
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: isStandalone(),
  })
}

/** Opened from the Home Screen, or installed and opened as an app. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** An iPhone or iPad, where Share → Add to Home Screen is the only way. An
 * iPad asking for the desktop site says "Macintosh" but has a touch screen. */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  )
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The browser's own install prompt, when it has offered one, and a way to
 * show it. Null everywhere else — Safari, Firefox, already installed.
 */
export function useInstallPrompt(): (() => Promise<boolean>) | null {
  const event = useSyncExternalStore(
    subscribe,
    () => deferred,
    () => null,
  )
  if (!event) return null
  return async () => {
    try {
      await event.prompt()
      const { outcome } = await event.userChoice
      // A prompt shows once; either way, this one is spent. Accepted, the
      // app takes a few seconds more to arrive, and until `appinstalled`
      // says it has, the page says so rather than showing the steps again.
      deferred = null
      if (outcome === 'accepted' && progress === null) progress = 'installing'
      notify()
      return outcome === 'accepted'
    } catch {
      deferred = null
      notify()
      return false
    }
  }
}

/**
 * How this browser installs PestM8, or null while the page hydrates: the
 * server cannot know which phone it is, so the first render must not either.
 */
export function useInstallMethod(): InstallMethod | null {
  return useSyncExternalStore(subscribe, currentInstallMethod, () => null)
}

/** Opened as the installed app. False while the page hydrates. */
export function useStandalone(): boolean {
  return useSyncExternalStore(subscribe, isStandalone, () => false)
}

/** An install from this page: accepted, then arrived. Null otherwise. */
export function useInstallProgress(): InstallProgress | null {
  return useSyncExternalStore(
    subscribe,
    () => progress,
    () => null,
  )
}
