import { describe, expect, test } from 'vitest'
import { mapsUrl, openMapTab } from './maps'

function queryOf(url: string | null): string | null {
  return url === null ? null : new URL(url).searchParams.get('query')
}

describe('the job card Map link', () => {
  test('searches the full street address, with the postcode standing in for the state', () => {
    const url = mapsUrl({
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    expect(
      url?.startsWith('https://www.google.com/maps/search/?api=1&query='),
    ).toBe(true)
    expect(queryOf(url)).toBe('12 Wattle Street, Bayswater, 6053, Australia')
  })

  test('encodes what a street address can contain', () => {
    const url = mapsUrl({
      addressLine: 'Unit 3/14 Smith & Co Lane',
      suburb: 'Perth',
    })
    expect(url).not.toContain(' ')
    expect(url).not.toContain('&Co')
    expect(queryOf(url)).toBe('Unit 3/14 Smith & Co Lane, Perth, Australia')
  })

  test('skips missing and blank parts rather than leaving empty commas', () => {
    expect(
      queryOf(mapsUrl({ addressLine: '  ', suburb: 'Morley', postcode: '' })),
    ).toBe('Morley, Australia')
  })

  test('offers no link when there is no address at all', () => {
    expect(mapsUrl({})).toBeNull()
    expect(mapsUrl({ addressLine: '', suburb: ' ', postcode: '' })).toBeNull()
  })
})

describe('opening the map', () => {
  function fakeWindow(opts: { active?: boolean; blocked?: boolean }) {
    const opened: Array<string> = []
    const tab = { opener: 'the app' as unknown }
    return {
      opened,
      tab,
      win: {
        open: (url: string) => {
          opened.push(url)
          return opts.blocked ? null : tab
        },
        navigator:
          opts.active === undefined
            ? {}
            : { userActivation: { isActive: opts.active } },
      },
    }
  }

  test('opens a new tab, and cuts the link back to the app', () => {
    const f = fakeWindow({ active: true })
    expect(openMapTab('https://maps.example/x', f.win)).toBe(true)
    expect(f.opened).toEqual(['https://maps.example/x'])
    expect(f.tab.opener).toBeNull()
  })

  test('says so when the browser blocks the tab, so the card can offer a link', () => {
    const f = fakeWindow({ active: true, blocked: true })
    expect(openMapTab('https://maps.example/x', f.win)).toBe(false)
  })

  test('does not try at all without a gesture the browser counts', () => {
    const f = fakeWindow({ active: false })
    expect(openMapTab('https://maps.example/x', f.win)).toBe(false)
    expect(f.opened).toEqual([])
  })

  test('tries where the browser cannot say (no userActivation)', () => {
    const f = fakeWindow({})
    expect(openMapTab('https://maps.example/x', f.win)).toBe(true)
  })
})
