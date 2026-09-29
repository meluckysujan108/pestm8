import { isAppleTouch } from './device'
import type { DeviceHints } from './device'

/**
 * How PestM8 goes onto this device: which steps someone is shown in Settings
 * → Install app, from the sign-in screen, and on the schedule's card
 * (components/install/).
 *
 * Read from the user agent, the one thing every browser says about itself.
 * A browser tab cannot tell whether a copy is already on the Home Screen — it
 * only knows it is not one — so nothing here, or on screen, says "not
 * installed".
 *
 * Chrome's own install prompt is not part of this. It comes and goes: it
 * arrives when Chrome decides, is spent after one use, and may come again.
 * The method is fixed for the page, and `useInstallPrompt`
 * (lib/installPrompt.ts) turns the steps into one tap while a prompt lasts.
 */
export type InstallMethod =
  /** Opened from the Home Screen, or as an installed app. */
  | 'installed'
  /** Safari on an iPhone or iPad: Share, then Add to Home Screen. */
  | 'ios-safari'
  /** Chrome, Edge, Firefox or Opera on an iPhone: the same, from their Share. */
  | 'ios-browser'
  /** Another app's own browser (Gmail, Outlook, Facebook…): it can't add to
   * the Home Screen, so the page has to be opened in Safari first. */
  | 'ios-in-app'
  /** Chrome, and the browsers built on it, on Android: ⋮ → Add to Home screen. */
  | 'android-chrome'
  /** Samsung Internet: ☰ → Add page to → Home screen. */
  | 'android-samsung'
  /** Firefox on Android: ⋮ → Install. */
  | 'android-firefox'
  /** An app's own browser on Android: open the page in Chrome first. */
  | 'android-in-app'
  /** Any other Android browser: look in its menu. */
  | 'android-other'
  /** Chrome or Edge on a computer: the install icon in the address bar. */
  | 'desktop-chromium'
  /** Safari on a Mac with macOS Sonoma or later: File → Add to Dock. */
  | 'mac-safari'
  /** Firefox on a computer, an older Safari, anything else: it can't. */
  | 'unsupported'

export type InstallHints = DeviceHints & {
  /** `display-mode: standalone`, or `navigator.standalone` on an iPhone. */
  standalone: boolean
}

/**
 * Apps that open links in a browser of their own. Most of these on an iPhone
 * also leave "Safari/" out of the user agent, which catches the ones not
 * named here; the Google app and Facebook's Android browser keep it.
 */
const IN_APP =
  /\b(?:FBAN|FBAV|FB_IAB|LinkedInApp|GSA|Line|MicroMessenger|Snapchat)\/|\bInstagram\b/

export function installMethod(hints: InstallHints): InstallMethod {
  if (hints.standalone) return 'installed'
  const ua = hints.userAgent

  // Before the iPad test, which counts a "Mac" with a touch screen as an
  // iPad: nothing Apple makes says Android, but a browser emulating an
  // Android phone on a Mac (DevTools, a test) says both.
  //
  // An Android tablet asking for desktop sites — Chrome's default on a large
  // one — says only "X11; Linux", like a computer. Its touch screen gives it
  // away, as it does an iPad's; a Chromebook says "CrOS".
  const androidTablet =
    /\bLinux\b/.test(ua) && !/\bCrOS\b/.test(ua) && hints.maxTouchPoints > 1
  if (/\bAndroid\b/.test(ua) || androidTablet) {
    // `; wv)` is Android's WebView: an app showing the page itself.
    if (/; wv\)/.test(ua) || IN_APP.test(ua)) return 'android-in-app'
    // Samsung Internet says "Chrome/" too, so it is asked about first.
    if (/\bSamsungBrowser\//.test(ua)) return 'android-samsung'
    if (/\bFirefox\//.test(ua)) return 'android-firefox'
    if (/\bChrome\//.test(ua)) return 'android-chrome'
    return 'android-other'
  }

  if (isAppleTouch(hints)) {
    if (IN_APP.test(ua) || !/\bSafari\//.test(ua)) return 'ios-in-app'
    if (/\b(?:CriOS|FxiOS|EdgiOS|OPiOS|OPT)\//.test(ua)) return 'ios-browser'
    return 'ios-safari'
  }

  // Edge, Opera and Brave all say "Chrome/"; Firefox never does.
  if (/\b(?:Chrome|Chromium|Edg)\//.test(ua)) return 'desktop-chromium'
  const safari = /\bVersion\/(\d+)[\d.]* Safari\//.exec(ua)
  if (safari && /\bMacintosh\b/.test(ua) && Number(safari[1]) >= 17) {
    return 'mac-safari'
  }
  return 'unsupported'
}

/** A phone or tablet, where the Home Screen is the point of it. */
export function isHandheld(method: InstallMethod): boolean {
  return method.startsWith('ios-') || method.startsWith('android-')
}

/**
 * The schedule's "Put PestM8 on your Home Screen" card, remembered per
 * device: put away with ✕ (or by set-up, which has just shown the same
 * steps) for 30 days, and while this browser knows PestM8 is installed —
 * from Chrome's `appinstalled`, or a visit from the installed app, which
 * shares Chrome's storage on Android. That lasts until Chrome offers to
 * install it again, which it does only once the app has been deleted
 * (`forgetInstalled`, from the `beforeinstallprompt` listener).
 *
 * An iPhone's Home Screen app keeps storage of its own, apart from Safari's,
 * so Safari never learns it was installed there — ✕ is the way to quiet it.
 * Safari also clears a site's storage after seven days of browsing without
 * a visit to it, so there the 30 days can end sooner: for someone who uses
 * the Home Screen app and rarely opens PestM8 in Safari, the card may be
 * back the next time they do.
 *
 * Storage that is missing or refuses (a private window) shows no card at
 * all: a card that could not be put away would come back on every visit.
 */
export const INSTALL_CARD_QUIET_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const HIDDEN_UNTIL = 'pestm8-install-card-hidden-until'
const INSTALLED = 'pestm8-installed'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function installCardHidden(storage: Store | null, now: number): boolean {
  if (!storage) return true
  try {
    if (storage.getItem(INSTALLED) === '1') return true
    return now < Number(storage.getItem(HIDDEN_UNTIL) ?? 0)
  } catch {
    return true
  }
}

export function hideInstallCard(storage: Store | null, now: number): void {
  try {
    storage?.setItem(HIDDEN_UNTIL, String(now + INSTALL_CARD_QUIET_DAYS * DAY))
  } catch {
    // Nowhere to keep it: the card comes back next time, nothing else.
  }
}

export function rememberInstalled(storage: Store | null): void {
  try {
    storage?.setItem(INSTALLED, '1')
  } catch {
    // As above.
  }
}

/** Chrome is offering to install it, so it is not installed any more. */
export function forgetInstalled(
  storage: Pick<Storage, 'removeItem'> | null,
): void {
  try {
    storage?.removeItem(INSTALLED)
  } catch {
    // As above.
  }
}

/** Whether the schedule offers the card to this device now. */
export function offerInstallCard(
  method: InstallMethod,
  storage: Store | null,
  now: number,
): boolean {
  return isHandheld(method) && !installCardHidden(storage, now)
}
