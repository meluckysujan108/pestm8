import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KeptClientView, NotKeptClient } from './KeptClientView'
import type { ReactNode } from 'react'
import type { DirectoryClient, DirectorySite } from '#/lib/directory'

// The keeper reads who is signed in (lib/rootState.ts), whose server
// function needs a deployment's address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

// vaul's pieces as plain elements: there's no document here to open a real
// one in.
vi.mock('vaul', () => {
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    Drawer: {
      Root: pass,
      Portal: pass,
      Overlay: () => null,
      Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
      Description: pass,
      Content: pass,
    },
  }
})

/**
 * A client opened with no answer from PestM8, from their row in the client
 * list the phone keeps: Call and Text, each site's Map and site contact, and
 * what opens with signal, read-only.
 */

const TZ = 'Australia/Perth'
/** Monday 26 Oct 2026, 9am in Perth. */
const NOW = Date.UTC(2026, 9, 26, 1)

function client(extra: Partial<DirectoryClient> = {}): DirectoryClient {
  return {
    _id: 'c1',
    _creationTime: NOW,
    name: 'Subi Café Group',
    kind: 'business',
    phone: '08 9381 2200',
    clientNumber: 1916,
    status: 'active',
    createdAt: NOW,
    ...extra,
  } as unknown as DirectoryClient
}

function site(
  id: string,
  addressLine: string,
  extra: Partial<DirectorySite> = {},
): DirectorySite {
  return {
    _id: id,
    clientId: 'c1',
    addressLine,
    suburb: 'Subiaco',
    postcode: '6008',
    createdAt: NOW,
    ...extra,
  } as unknown as DirectorySite
}

function render(
  who: DirectoryClient,
  sites: ReadonlyArray<DirectorySite>,
  more: { down?: 'no-signal' | 'unreachable' | null; xero?: boolean } = {},
) {
  return renderToStaticMarkup(
    <KeptClientView
      client={who}
      sites={sites}
      asOf={Date.UTC(2026, 9, 26, 0, 42)}
      down={more.down === undefined ? 'no-signal' : more.down}
      timezone={TZ}
      xero={more.xero}
    />,
  )
}

/** The accessible names of every button, in order. */
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map(
    (match) => match[1],
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a client from the client list', () => {
  test('a business: its own number, each site’s Map, and a site contact’s Call and Text', () => {
    const html = render(client(), [
      site('p1', '220 Hay St', {
        siteContactName: 'Priya',
        siteContactPhone: '0433 111 222',
      }),
      site('p2', '9 Rokeby Rd'),
    ])
    expect(html).toContain(
      'No signal — showing the copy kept on this phone, updated 8:42am. Editing needs signal.',
    )
    expect(buttons(html)).toEqual([
      'Call Subi Café Group',
      'Text Subi Café Group',
      'Map of 220 Hay St, Subiaco',
      'Call Priya',
      'Text Priya',
      'Map of 9 Rokeby Rd, Subiaco',
    ])
    expect(html).toContain('Client #1916')
    // A business's named people aren't kept.
    expect(html).toMatch(/Contacts<\/dt>.*Opens when you have signal\./)
  })

  test('a site contact with no name is named after their site', () => {
    const html = render(client(), [
      site('p1', '220 Hay St', { siteContactPhone: '0433 111 222' }),
    ])
    expect(buttons(html)).toContain('Call site contact at 220 Hay St')
  })

  test('a person is their own one contact: no Contacts row, and no site contact', () => {
    const html = render(
      client({ kind: 'person', name: 'Daniel Price', phone: '0400 000 111' }),
      [
        site('p1', '7 Bagot Rd', {
          siteContactName: 'Someone',
          siteContactPhone: '0433 111 222',
        }),
      ],
    )
    expect(buttons(html)).toEqual([
      'Call Daniel Price',
      'Text Daniel Price',
      'Map of 7 Bagot Rd, Subiaco',
    ])
    expect(html).not.toContain('Contacts</dt>')
    expect(html).not.toContain('Site contact')
  })

  test('no Call or Text without a number, and no sites said so', () => {
    const html = render(client({ phone: undefined }), [])
    expect(buttons(html)).toEqual([])
    expect(html).toContain('No properties yet')
  })

  test('jobs and notes open with signal, and Xero only where the live sheet would have a row for it', () => {
    const without = render(client(), [])
    expect(without).toMatch(/Jobs<\/dt>.*Opens when you have signal\./)
    expect(without).toMatch(/Notes<\/dt>.*Opens when you have signal\./)
    expect(without).not.toContain('Xero')
    expect(render(client(), [], { xero: true })).toMatch(
      /Xero<\/dt>.*Opens when you have signal\./,
    )
  })

  test('a late answer on a line that looks up is PestM8 not answering', () => {
    expect(render(client(), [], { down: null })).toContain(
      'Could not reach PestM8 — showing the kept copy, updated 8:42am. Editing needs signal.',
    )
  })
})

describe('a client the list doesn’t have', () => {
  test('says they aren’t on this phone, and when they open', () => {
    expect(renderToStaticMarkup(<NotKeptClient />)).toContain(
      'This client isn’t on this phone. It opens when you have signal.',
    )
  })
})
