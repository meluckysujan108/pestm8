import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { InstallSteps } from './InstallSteps'
import type { InstallMethod } from '#/lib/installMethod'
import type { InstallProgress } from '#/lib/installPrompt'

/**
 * What each device is told, rendered. Words are what these steps are made
 * of, so a word that goes missing — the toggle that keeps an iPhone's copy
 * a real app, the browser to open an in-app page in — is a person stuck.
 */

function render(
  method: InstallMethod,
  {
    canPrompt = false,
    progress = null,
  }: { canPrompt?: boolean; progress?: InstallProgress | null } = {},
) {
  // Tags out and entities decoded, so words read as a person reads them.
  return renderToStaticMarkup(
    <InstallSteps
      method={method}
      canPrompt={canPrompt}
      onInstall={() => {}}
      progress={progress}
    />,
  )
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

describe('InstallSteps', () => {
  test('an iPhone in Safari: Share, Add to Home Screen, keep it a web app', () => {
    const html = render('ios-safari')
    expect(text(html)).toContain('Tap Share')
    expect(text(html)).toContain('Add to Home Screen')
    // The toggle is on the same screen as Add, so it comes first.
    expect(text(html)).toContain(
      'Leave Open as Web App on, if you see it, then tap Add',
    )
    expect(text(html)).toContain(
      'Open PestM8 from your Home Screen, and sign in if it asks',
    )
    expect(text(html)).toContain('Open this page in Safari')
    // ••• is read out as what it is.
    expect(html).toContain('<span class="sr-only">More</span>')
    expect(html.match(/<li/g)).toHaveLength(4)
  })

  test('another iPhone browser finds Share in its address bar', () => {
    expect(text(render('ios-browser'))).toContain('in the address bar')
  })

  test('an app’s own browser is sent to the phone’s browser, with the link', () => {
    const iphone = text(render('ios-in-app'))
    expect(iphone).toContain('Open this page in Safari first')
    expect(iphone).toContain('Copy link')
    expect(iphone).not.toContain('Add to Home Screen')
    expect(text(render('android-in-app'))).toContain(
      'Open this page in Chrome first',
    )
  })

  test.each([
    ['android-chrome', 'Add to Home screen'],
    ['android-samsung', 'Add page to'],
    ['android-firefox', 'Install'],
    ['android-other', 'Add to Home screen'],
    ['desktop-chromium', 'address bar'],
    ['mac-safari', 'Add to Dock'],
    ['unsupported', 'can’t install PestM8'],
  ] as const)('%s names its own menu: %s', (method, words) => {
    expect(text(render(method))).toContain(words)
  })

  test('Android always has a way out to Chrome', () => {
    for (const method of [
      'android-chrome',
      'android-samsung',
      'android-firefox',
      'android-other',
    ] as const) {
      expect(text(render(method))).toContain('Open this page in Chrome')
    }
  })

  test('where Chrome offers its prompt, one tap and nothing else', () => {
    const html = render('android-chrome', { canPrompt: true })
    expect(text(html)).toBe('Install PestM8')
    expect(html).toMatch(/^<button type="button"/)
  })

  test('says so once installed, in the words of the device', () => {
    expect(text(render('installed'))).toBe('You’re using the installed app.')
    expect(text(render('android-chrome', { progress: 'installed' }))).toBe(
      'Installed. Open PestM8 from your Home Screen.',
    )
    expect(text(render('desktop-chromium', { progress: 'installed' }))).toBe(
      'Installed. Open PestM8 from your apps.',
    )
  })

  test('between accepting Chrome’s prompt and the app arriving, it says so', () => {
    // Not the steps again, which would read as "you still have to do it".
    const html = render('android-chrome', { progress: 'installing' })
    expect(text(html)).toBe('Installing PestM8…')
    expect(html).toContain('role="status"')
  })

  test('a Mac that can’t Add to Dock is told why, and what to use instead', () => {
    expect(text(render('mac-safari'))).toContain(
      'It needs macOS Sonoma or later',
    )
    // Not "use Safari", said to someone already in Safari.
    expect(text(render('unsupported'))).not.toContain('Safari')
  })

  test('a button’s glyph is grey: blue would read as a link', () => {
    for (const method of [
      'ios-safari',
      'android-chrome',
      'android-samsung',
      'desktop-chromium',
    ] as const) {
      expect(render(method)).not.toContain('text-blue')
    }
  })

  test('draws no heading, which the e2e suite reads as a page having loaded', () => {
    for (const method of [
      'ios-safari',
      'ios-in-app',
      'android-chrome',
      'desktop-chromium',
      'installed',
    ] as const) {
      expect(render(method)).not.toMatch(/<h[1-6]/)
    }
  })
})
