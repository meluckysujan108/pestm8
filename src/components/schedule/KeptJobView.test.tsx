import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KeptJobView, NotKeptJob } from './KeptJobView'
import type { ReactNode } from 'react'
import type { DayRow } from '#/lib/offline/keeper'

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
 * A job opened with no answer from PestM8, as its day lists it: who the
 * card would ring, and only what the day has, read-only.
 */

const TZ = 'Australia/Perth'
/** Monday 26 Oct 2026, 9am in Perth. */
const NOW = Date.UTC(2026, 9, 26, 1)

function job(extra: Partial<DayRow> = {}): DayRow {
  return {
    _id: 'j1',
    _creationTime: NOW,
    businessId: 'b1',
    jobNumber: 1042,
    jobType: 'Termite Inspection',
    price: 38500,
    scheduledAt: NOW + 90 * 60_000,
    durationMinutes: 90,
    status: 'pending',
    addressLine: '220 Hay St',
    suburb: 'Subiaco',
    postcode: '6008',
    propertyState: 'WA',
    clientName: 'Subi Café Group',
    clientPhone: '08 9381 2200',
    clientKind: 'business',
    assigneeColour: '#FF3B30',
    assigneeName: 'Kevin Doyle',
    assignedMembershipId: 'm_kev',
    alsoGoing: [],
    ...extra,
  } as unknown as DayRow
}

function render(row: DayRow, down: 'no-signal' | 'unreachable' | null) {
  return renderToStaticMarkup(
    <KeptJobView
      job={row}
      asOf={Date.UTC(2026, 9, 26, 0, 42)}
      down={down}
      timezone={TZ}
      roster={undefined}
    />,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a job from its day', () => {
  test('a business’s job rings its site contact, as the card does, beside the Map', () => {
    const html = render(
      job({ siteContactName: 'Priya', siteContactPhone: '0433 111 222' }),
      'no-signal',
    )
    expect(html).toContain(
      'No signal — showing the copy kept on this phone, updated 8:42am. Editing needs signal.',
    )
    expect(html).toContain('aria-label="Call Priya"')
    expect(html).toContain('aria-label="Text Priya"')
    expect(html).toContain('aria-label="Map of 220 Hay St, Subiaco"')
    expect(html).not.toContain('Call Subi Café Group')
    // Who to ask for, as the card's Contact line says it.
    expect(html).toMatch(/Contact<\/span> <span[^>]*>Priya</)
  })

  test('a person’s job rings the client', () => {
    const html = render(
      job({
        clientKind: 'person',
        clientName: 'Daniel Price',
        clientPhone: '0400 000 111',
        // A person client has no site contact of their own to ring.
        siteContactName: 'Someone',
        siteContactPhone: '0433 111 222',
      }),
      'no-signal',
    )
    expect(html).toContain('aria-label="Call Daniel Price"')
    expect(html).not.toContain('Call Someone')
  })

  test('a recurring visit due today is to book: no Map, and its Call says so', () => {
    const html = render(
      job({ status: 'recurring', scheduledAt: NOW - 60 * 60_000 }),
      'no-signal',
    )
    expect(html).toContain('Not booked yet — contact to book')
    expect(html).toContain('aria-label="Call to book: Subi Café Group"')
    expect(html).not.toContain('Map of')
  })

  test('a cancelled job rings nobody', () => {
    const html = render(job({ status: 'cancelled' }), 'no-signal')
    expect(html).not.toContain('aria-label="Call')
    expect(html).not.toContain('Map of')
  })

  test('a business client’s work order, or that there is none', () => {
    expect(render(job({ workOrder: 'PO 88213' }), 'no-signal')).toContain(
      'PO 88213',
    )
    expect(render(job(), 'no-signal')).toContain('None recorded')
    // A person's job without one says nothing of it.
    expect(
      render(job({ clientKind: 'person', clientName: 'Daniel Price' }), null),
    ).not.toContain('Work order')
  })

  test('a late answer on a line that looks up is PestM8 not answering', () => {
    expect(render(job(), null)).toContain(
      'Could not reach PestM8 — showing the kept copy, updated 8:42am. Editing needs signal.',
    )
  })

  test('nothing on it edits: its only buttons reach the client or the map', () => {
    const html = render(job(), 'no-signal')
    const buttons = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)]
    expect(buttons.map((match) => match[1])).toEqual([
      'Call Subi Café Group',
      'Text Subi Café Group',
      'Map of 220 Hay St, Subiaco',
    ])
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).not.toContain('<form')
  })
})

describe('a job no day lists', () => {
  test('says it isn’t on this phone, and when it opens', () => {
    expect(renderToStaticMarkup(<NotKeptJob />)).toContain(
      'This job isn’t on this phone. It opens when you have signal.',
    )
  })
})
