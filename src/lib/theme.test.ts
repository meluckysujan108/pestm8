import { describe, expect, it } from 'vitest'
import {
  THEME_COOKIE,
  normaliseThemePref,
  resolveTheme,
  themeInitScript,
} from './theme'
import type { ThemePref } from './theme'

describe('normaliseThemePref', () => {
  it('keeps the two explicit choices', () => {
    expect(normaliseThemePref('light')).toBe('light')
    expect(normaliseThemePref('dark')).toBe('dark')
  })

  /**
   * Everything else is `system`, including a value someone has hand-edited in
   * devtools. A cookie is user-writable, so this is the only thing standing
   * between a junk value and `data-theme="'; drop"` on <html>.
   */
  it('falls back to system for anything else', () => {
    for (const value of [
      'system',
      'Dark',
      'DARK',
      '',
      'purple',
      undefined,
      null,
    ]) {
      expect(normaliseThemePref(value)).toBe('system')
    }
  })
})

describe('resolveTheme', () => {
  it('honours an explicit choice regardless of the OS', () => {
    for (const dark of [true, false]) {
      expect(resolveTheme('light', dark)).toBe('light')
      expect(resolveTheme('dark', dark)).toBe('dark')
    }
  })

  it('follows the OS only when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('never returns system', () => {
    const prefs: Array<ThemePref> = ['light', 'dark', 'system']
    for (const pref of prefs) {
      for (const dark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(pref, dark))
      }
    }
  })
})

/**
 * `themeInitScript` ships as a string and runs before any bundle, so nothing
 * type-checks it and a mistake shows up as a theme that silently never
 * applies. Pull the real regex out of the real string and exercise it.
 */
describe('themeInitScript cookie parsing', () => {
  const source = themeInitScript.match(/\.match\((\/.*?\/)\)/)?.[1]

  function read(cookie: string): string | undefined {
    if (!source)
      throw new Error('could not find the cookie regex in themeInitScript')
    return cookie.match(new RegExp(source.slice(1, -1)))?.[1]
  }

  it('was found in the script at all', () => {
    expect(source).toBeDefined()
  })

  it('reads the cookie whether it is first, last or alone', () => {
    expect(read(`${THEME_COOKIE}=dark`)).toBe('dark')
    expect(read(`other=1; ${THEME_COOKIE}=light`)).toBe('light')
    expect(read(`${THEME_COOKIE}=system; other=1`)).toBe('system')
    expect(read(`a=1;${THEME_COOKIE}=dark;b=2`)).toBe('dark')
  })

  /**
   * The reason for the `(?:^|;\s*)` anchor. A bare `pm8_theme=` would match
   * inside a longer cookie name and read someone else's value as the theme.
   */
  it('does not match a cookie whose name merely ends in this one', () => {
    expect(read(`my_${THEME_COOKIE}=dark`)).toBeUndefined()
    expect(read(`sess=abc; other_${THEME_COOKIE}=dark`)).toBeUndefined()
    expect(read(`x${THEME_COOKIE}=dark`)).toBeUndefined()
  })

  it('ignores a value outside the three it knows', () => {
    expect(read(`${THEME_COOKIE}=purple`)).toBeUndefined()
    expect(read('')).toBeUndefined()
    expect(read('other=1')).toBeUndefined()
  })

  it('sets both attributes the client half reads back', () => {
    expect(themeInitScript).toContain('dataset.themePref')
    expect(themeInitScript).toContain('dataset.theme')
  })
})
