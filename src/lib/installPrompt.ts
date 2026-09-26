import { useSyncExternalStore } from 'react'

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
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    deferred = event as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
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
      // A prompt shows once; either way, this one is spent.
      deferred = null
      notify()
      return outcome === 'accepted'
    } catch {
      deferred = null
      notify()
      return false
    }
  }
}
