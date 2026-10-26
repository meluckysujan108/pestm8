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
 * live sheet lists to call, and only what the day has, read-only.
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

function render(
  row: DayRow,
  down: 'no-signal' | 'unreachable' | null,
  readOnly = false,
  clientNumber?: number,
) {
  return renderToStaticMarkup(
    <KeptJobView
      job={row}
      asOf={Date.UTC(2026, 9, 26, 0, 42)}
      down={down}
      timezone={TZ}
      roster={undefined}
      head={{ readOnly, clientNumber }}
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

/** The accessible names of every button, in order. */
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map(
    (match) => match[1],
  )

describe('a job from its day', () => {
  test('a business’s job lists its site contact and its own line, as the live sheet does, with the Map under them', () => {
    const html = render(
      job({ siteContactName: 'Priya', siteContactPhone: '0433 111 222' }),
      'no-signal',
    )
    expect(html).toContain(
      'No signal — showing the copy kept on this phone, updated 8:42am. Editing needs signal.',
    )
    expect(buttons(html)).toEqual([
      'Call Priya',
      'Text Priya',
      'Call Subi Café Group',
      'Text Subi Café Group',
      'Map of 220 Hay St, Subiaco',
    ])
    expect(html).toContain('Site contact')
    // The client's own line is captioned beside another Call.
    expect(html).toContain('Head office')
  })

  test('a business’s contact person, with their own Call, and the client’s Email', () => {
    const html = render(
      job({
        contactPersonName: 'Jan Morris',
        contactPersonPhone: '0400 222 333',
        clientEmail: 'accounts@subicafe.com.au',
      }),
      'no-signal',
    )
    expect(buttons(html)).toEqual([
      'Call Jan Morris',
      'Text Jan Morris',
      'Call Subi Café Group',
      'Text Subi Café Group',
      'Email Subi Café Group',
      'Map of 220 Hay St, Subiaco',
    ])
    expect(html).toContain('Contact person')
  })

  test('a person’s job rings the client, who is their own site contact', () => {
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
    expect(buttons(html)).toEqual([
      'Call Daniel Price',
      'Text Daniel Price',
      'Map of 220 Hay St, Subiaco',
    ])
    expect(html).not.toContain('Head office')
  })

  test('laid out as the live sheet down to the property’s Call, with the line saying why after the property', () => {
    const html = render(
      job({ siteContactName: 'Priya', siteContactPhone: '0433 111 222' }),
      'no-signal',
    )
    const at = (text: string) => {
      const index = html.indexOf(text)
      expect(index, text).toBeGreaterThan(-1)
      return index
    }
    // The live sheet's head, in its words: "Mon 26 Oct · 10:30am · 1 hr
    // 30 min", not a range, which can run to a second line.
    expect(html).toContain('· 10:30am')
    expect(html).toContain('· 1 hr 30 min')
    expect(at('Job #1042')).toBeLessThan(at('<h2>Termite Inspection</h2>'))
    expect(at('<h2>Termite Inspection</h2>')).toBeLessThan(at('Kevin Doyle'))
    expect(at('Kevin Doyle')).toBeLessThan(at('Property'))
    // Every Call and the Map before the line: nothing above a Call is
    // drawn where the live sheet has nothing.
    expect(at('aria-label="Map of 220 Hay St, Subiaco"')).toBeLessThan(
      at('No signal — showing the copy kept on this phone'),
    )
  })

  test('an invoiced job says so where the live sheet does', () => {
    const html = render(job({ status: 'invoiced' }), 'no-signal')
    expect(html).toContain(
      'This job has been invoiced, so its details are locked. Change its status to edit them.',
    )
    expect(html.indexOf('This job has been invoiced')).toBeLessThan(
      html.indexOf('aria-label="Call Subi Café Group"'),
    )
  })

  test('someone else’s job says so where the live sheet does', () => {
    const html = render(job(), 'no-signal', true)
    expect(html).toContain(
      'This job is assigned to someone else, so it is read-only.',
    )
    expect(html.indexOf('assigned to someone else')).toBeLessThan(
      html.indexOf('aria-label="Call Subi Café Group"'),
    )
    expect(render(job(), 'no-signal')).not.toContain('someone else')
  })

  test('Edit’s row and the status menu held unseen where the live sheet has them, so the date and the Calls under them don’t move', () => {
    const editable = render(job(), 'no-signal')
    // Unseen, and unheard: nothing here edits.
    expect(editable).toMatch(
      /<span aria-hidden="true" class="invisible mr-8[^"]*">.*Edit<\/span>/,
    )
    expect(editable).toMatch(/class="lucide lucide-chevron-down invisible"/)
    expect(editable).not.toContain('Edit job details')
    // A job too old for a number still has Edit's row.
    const old = render(job({ jobNumber: undefined }), 'no-signal')
    expect(old).not.toContain('Job #')
    expect(old).toContain('invisible mr-8')
    // No Edit on the live sheet for someone else's job, nor an invoiced one;
    // no menu for someone else's.
    const theirs = render(job(), 'no-signal', true)
    expect(theirs).not.toContain('invisible mr-8')
    expect(theirs).not.toContain('chevron-down')
    const invoiced = render(job({ status: 'invoiced' }), 'no-signal')
    expect(invoiced).not.toContain('invisible mr-8')
    expect(invoiced).toContain('chevron-down')
  })

  test('the client’s number beside their name, in the row the live sheet shares between them', () => {
    const html = render(job(), 'no-signal', false, 1916)
    expect(html).toMatch(
      /<div class="flex items-baseline justify-between gap-2"><p[^>]*>Subi Café Group<\/p><span class="shrink-0[^"]*">Client #1916<\/span><\/div>/,
    )
    // Where the client list doesn't say, the name has the row to itself.
    expect(render(job(), 'no-signal')).not.toContain('Client #')
  })

  test('the Map only where the card has one: not on a visit still to book, nor a cancelled job', () => {
    const due = render(
      job({ status: 'recurring', scheduledAt: NOW - 60 * 60_000 }),
      'no-signal',
    )
    expect(due).toContain('aria-label="Call Subi Café Group"')
    expect(due).not.toContain('Map of')
    expect(render(job({ status: 'cancelled' }), 'no-signal')).not.toContain(
      'Map of',
    )
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
    expect(buttons(html)).toEqual([
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
