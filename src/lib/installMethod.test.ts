import { describe, expect, test } from 'vitest'
import {
  INSTALL_CARD_QUIET_DAYS,
  forgetInstalled,
  hideInstallCard,
  installCardHidden,
  installMethod,
  isHandheld,
  offerInstallCard,
  rememberInstalled,
} from './installMethod'
import type { InstallMethod } from './installMethod'

/**
 * Which steps a device is shown, read from what browsers actually send. A
 * wrong answer here tells someone to tap a button their phone doesn't have,
 * which is how the person who deleted the app got stuck in the first place.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36'

const CASES: Array<[string, string, InstallMethod, Partial<Hints>?]> = [
  [
    'Safari on iOS 18',
    `${IPHONE} ${WEBKIT} Version/18.0 Mobile/15E148 Safari/604.1`,
    'ios-safari',
  ],
  [
    // iOS 26 freezes the OS in the user agent and moves Version on.
    'Safari on iOS 26',
    `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ${WEBKIT} Version/26.0 Mobile/15E148 Safari/604.1`,
    'ios-safari',
  ],
  [
    // The e2e suite's mobile project (Playwright's "iPhone 13"): it must see
    // the iPhone steps, the sign-in link and the schedule's card.
    'the e2e iPhone',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
    'ios-safari',
  ],
  [
    'Safari on an iPad',
    `Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) ${WEBKIT} Version/17.0 Mobile/15E148 Safari/604.1`,
    'ios-safari',
  ],
  [
    'an iPad asking for the desktop site',
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/18.0 Safari/605.1.15`,
    'ios-safari',
    { platform: 'MacIntel', maxTouchPoints: 5 },
  ],
  [
    'Chrome on an iPhone',
    `${IPHONE} ${WEBKIT} CriOS/129.0.6668.46 Mobile/15E148 Safari/604.1`,
    'ios-browser',
  ],
  [
    'Firefox on an iPhone',
    `${IPHONE} ${WEBKIT} FxiOS/131.0 Mobile/15E148 Safari/605.1.15`,
    'ios-browser',
  ],
  [
    'Edge on an iPhone',
    `${IPHONE} ${WEBKIT} Version/18.0 EdgiOS/129.2792.84 Mobile/15E148 Safari/605.1.15`,
    'ios-browser',
  ],
  [
    'the Google app on an iPhone',
    `${IPHONE} ${WEBKIT} GSA/338.0.679569035 Mobile/15E148 Safari/604.1`,
    'ios-in-app',
  ],
  [
    'Facebook on an iPhone',
    `${IPHONE} ${WEBKIT} Mobile/15E148 [FBAN/FBIOS;FBAV/482.0.0.31.87;FBDV/iPhone15,2]`,
    'ios-in-app',
  ],
  [
    'Instagram on an iPhone',
    `${IPHONE} ${WEBKIT} Mobile/15E148 Instagram 352.0.0.29.91 (iPhone15,2; iOS 18_0; en_AU)`,
    'ios-in-app',
  ],
  [
    // Outlook, Gmail and most others: a bare web view, with no "Safari/".
    'a mail app’s own browser on an iPhone',
    `${IPHONE} ${WEBKIT} Mobile/15E148`,
    'ios-in-app',
  ],
  [
    'Chrome on Android',
    `${ANDROID} (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36`,
    'android-chrome',
  ],
  [
    'Edge on Android',
    `${ANDROID} (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0`,
    'android-chrome',
  ],
  [
    // DevTools' (and the Claude browser pane's) phone preset on a Mac: an
    // Android user agent, but the Mac's platform, with touch points.
    'an Android phone emulated on a Mac',
    `${ANDROID} (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36`,
    'android-chrome',
    { platform: 'MacIntel', maxTouchPoints: 5 },
  ],
  [
    // Chrome asks for desktop sites by default on a large Android tablet,
    // and then says only "X11; Linux" — its touch screen gives it away.
    'an Android tablet asking for the desktop site',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'android-chrome',
    { platform: 'Linux armv81', maxTouchPoints: 5 },
  ],
  [
    'Samsung Internet asking for the desktop site on a tablet',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36',
    'android-samsung',
    { platform: 'Linux armv81', maxTouchPoints: 5 },
  ],
  [
    'Chrome on a Linux computer',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'desktop-chromium',
    { platform: 'Linux x86_64' },
  ],
  [
    // A Chromebook with a touch screen says "CrOS", and is a computer.
    'a touch-screen Chromebook',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'desktop-chromium',
    { platform: 'Linux x86_64', maxTouchPoints: 10 },
  ],
  [
    'Samsung Internet',
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    'android-samsung',
  ],
  [
    'Firefox on Android',
    'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    'android-firefox',
  ],
  [
    'an Android web view',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36',
    'android-in-app',
  ],
  [
    'Facebook on Android',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/482.0.0.47.109;]',
    'android-in-app',
  ],
  [
    'an old Android browser',
    'Mozilla/5.0 (Linux; U; Android 4.0.3; en-au; GT-I9100 Build/IML74K) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    'android-other',
  ],
  [
    'Chrome on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'desktop-chromium',
  ],
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    'desktop-chromium',
  ],
  [
    'Chrome on a Mac',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'desktop-chromium',
    { platform: 'MacIntel' },
  ],
  [
    'Safari 17 on a Mac',
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/17.4 Safari/605.1.15`,
    'mac-safari',
    { platform: 'MacIntel' },
  ],
  [
    // Add to Dock came with macOS Sonoma and Safari 17.
    'Safari 16 on a Mac',
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/16.6 Safari/605.1.15`,
    'unsupported',
    { platform: 'MacIntel' },
  ],
  [
    'Firefox on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'unsupported',
  ],
  [
    'Firefox on a Mac',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0',
    'unsupported',
    { platform: 'MacIntel' },
  ],
]

type Hints = Parameters<typeof installMethod>[0]

const hints = (userAgent: string, extra: Partial<Hints> = {}): Hints => ({
  userAgent,
  platform: '',
  maxTouchPoints: 0,
  standalone: false,
  ...extra,
})

describe('installMethod', () => {
  test.each(CASES)('%s', (_name, userAgent, method, extra) => {
    expect(installMethod(hints(userAgent, extra))).toBe(method)
  })

  test('opened as the installed app wins over everything else', () => {
    for (const [, userAgent, , extra] of CASES) {
      expect(
        installMethod(hints(userAgent, { ...extra, standalone: true })),
      ).toBe('installed')
    }
  })

  test('only phones and tablets are handheld', () => {
    const handheld = CASES.filter(([, , method]) => isHandheld(method)).map(
      ([name]) => name,
    )
    expect(handheld).not.toContain('Chrome on Windows')
    expect(handheld).not.toContain('Safari 17 on a Mac')
    expect(handheld).toContain('an iPad asking for the desktop site')
    expect(isHandheld('installed')).toBe(false)
  })
})

/** Browser storage as far as the card needs it, and one that refuses. */
function memory() {
  const kept = new Map<string, string>()
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  }
}
const refusing = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError')
  },
}

const NOW = Date.UTC(2026, 8, 29, 2)
const DAY = 24 * 60 * 60 * 1000

describe('the schedule card', () => {
  test('is offered to a phone or tablet in a browser, and nowhere else', () => {
    expect(offerInstallCard('ios-safari', memory(), NOW)).toBe(true)
    expect(offerInstallCard('android-chrome', memory(), NOW)).toBe(true)
    expect(offerInstallCard('ios-in-app', memory(), NOW)).toBe(true)
    expect(offerInstallCard('installed', memory(), NOW)).toBe(false)
    expect(offerInstallCard('desktop-chromium', memory(), NOW)).toBe(false)
    expect(offerInstallCard('mac-safari', memory(), NOW)).toBe(false)
  })

  test(`stays away for ${INSTALL_CARD_QUIET_DAYS} days after ✕, then comes back`, () => {
    const storage = memory()
    hideInstallCard(storage, NOW)
    expect(installCardHidden(storage, NOW + DAY)).toBe(true)
    expect(
      installCardHidden(storage, NOW + (INSTALL_CARD_QUIET_DAYS - 1) * DAY),
    ).toBe(true)
    expect(
      installCardHidden(storage, NOW + INSTALL_CARD_QUIET_DAYS * DAY + 1),
    ).toBe(false)
  })

  test('stays away while this browser knows PestM8 is installed', () => {
    const storage = memory()
    rememberInstalled(storage)
    expect(installCardHidden(storage, NOW + 1000 * DAY)).toBe(true)
  })

  test('comes back once Chrome offers to install again: the app was deleted', () => {
    const storage = memory()
    rememberInstalled(storage)
    forgetInstalled(storage)
    expect(installCardHidden(storage, NOW)).toBe(false)
  })

  test('is not offered where it could not be put away', () => {
    expect(installCardHidden(null, NOW)).toBe(true)
    expect(installCardHidden(refusing, NOW)).toBe(true)
    expect(() => hideInstallCard(refusing, NOW)).not.toThrow()
    expect(() => rememberInstalled(refusing)).not.toThrow()
    expect(() => forgetInstalled(refusing)).not.toThrow()
  })

  test('shows when nothing has been kept, or what was kept is not a date', () => {
    const storage = memory()
    expect(installCardHidden(storage, NOW)).toBe(false)
    storage.setItem('pestm8-install-card-hidden-until', 'soon')
    expect(installCardHidden(storage, NOW)).toBe(false)
  })
})
