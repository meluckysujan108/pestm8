import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../../convex/_generated/api'
import { latchSlots } from '#/lib/outbox/latchSlots'
import { outboxRow } from '#/lib/outbox/outboxRow'
import { bookingFor, itemFor } from '#/lib/outbox/outboxStore.fixtures'
import { ClientJobsTab } from './ClientJobsTab'
import type * as ReactRouter from '@tanstack/react-router'
import type * as OutboxSet from '#/lib/outbox/outboxSet'
import type * as LineDownModule from '#/lib/offline/useLineDown'
import type { ClientOwed } from './ClientOwing'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'
import type { InlineReport } from '#/components/reports/ReportRows'
import type { LatchRow, SlotLatch } from '#/lib/outbox/latchSlots'
import type { OutboxItem } from '#/lib/outbox/outboxItem'
import type { OutboxList } from '#/lib/outbox/useOutbox'

/**
 * A client's Jobs tab with bookings on this phone (plan part 2c §9.8): a
 * slot drawing the job its booking made keeps that job out of the tab's
 * sections, a Recurring Job's whole service with it, and files the job's
 * reports under the slot; with nothing else, neither "Nothing booked." nor
 * "No jobs for … yet." is said beside it. What the phone holds is
 * `useOutboxList`'s, pinned in its own tests: here it is the tab's to draw.
 */

// Who is signed in reads a server function, which needs a deployment's
// address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))
// Each link as an element saying where it goes: nothing here follows one.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  Link: ({
    children,
    search,
    params,
  }: {
    children?: ReactNode
    search?: Record<string, unknown>
    params?: Record<string, unknown>
  }) => <a data-to={JSON.stringify({ ...params, ...search })}>{children}</a>,
}))
const phone = vi.hoisted(() => ({
  list: null as OutboxList<{ _id: string }> | null,
  /** Or drawn through the real `latchSlots`, from the rows the tab hands
   * over: see `drawThrough`. */
  draw: null as
    ((at: { rows: ReadonlyArray<LatchRow> }) => OutboxList<LatchRow>) | null,
}))
vi.mock('#/lib/outbox/useOutbox', () => ({
  useOutboxList: (at: { rows: ReadonlyArray<LatchRow> }) =>
    phone.draw === null ? phone.list : phone.draw(at),
  useOutboxSettled: () => true,
}))
// Keeping switched on or off (a build's VITE_PESTM8_OUTBOX), as this run's
// build has it unless a test says; and the line, up unless a test says.
const build = vi.hoisted(() => ({ keeping: null as boolean | null }))
vi.mock('#/lib/outbox/outboxSet', async (importOriginal) => {
  const real = await importOriginal<typeof OutboxSet>()
  return {
    ...real,
    get OUTBOX_ENABLED() {
      return build.keeping ?? real.OUTBOX_ENABLED
    },
  }
})
const line = vi.hoisted(() => ({ down: null as 'no-signal' | null }))
vi.mock('#/lib/offline/useLineDown', async (importOriginal) => ({
  ...(await importOriginal<typeof LineDownModule>()),
  useLineDown: () => line.down,
}))

const TZ = 'Australia/Perth'
/** Monday 26 Oct 2026, 9am in Perth. */
const NOW = Date.UTC(2026, 9, 26, 1)
const DAY = 86_400_000
const B = 'b1' as Id<'businesses'>
const C = 'c1' as Id<'clients'>

type Summary = NonNullable<FunctionReturnType<typeof api.clients.summary>>
type Visit = Summary['visits'][number]

function visit(id: string, at: number, extra: Partial<Visit> = {}): Visit {
  return {
    _id: id,
    jobNumber: 100,
    scheduledAt: at,
    status: 'pending',
    jobType: 'Termite Inspection',
    propertyId: 'p1',
    assignedMembershipId: 'm1',
    ...extra,
  } as unknown as Visit
}

/** A quarterly service, its first visit Wednesday, two more booked ahead. */
const FIRST = NOW + 2 * DAY
const quarterly = {
  _id: 's1',
  jobType: 'Quarterly Pest Control',
  interval: { count: 3, unit: 'month' },
  active: true,
  propertyId: 'p1',
  assignedMembershipId: 'm1',
  anchorDate: FIRST,
} as unknown as Summary['series'][number]
const ofSeries = (id: string, at: number) =>
  visit(id, at, {
    jobType: 'Quarterly Pest Control',
    recurrenceId: 's1' as Visit['recurrenceId'],
    occurrenceAt: at,
    status: id === 'v1' ? 'pending' : 'recurring',
  })

function summaryOf(over: Partial<Summary> = {}): Summary {
  return {
    properties: [{ _id: 'p1', addressLine: '1 Hay St', suburb: 'Perth' }],
    series: [],
    visits: [],
    capped: false,
    sitesCapped: false,
    ...over,
  } as unknown as Summary
}

/** The phone's list as `useOutboxList` hands it over. */
function listOf(
  slots: Array<{ item: OutboxItem; real: Visit | null }>,
): OutboxList<{ _id: string }> {
  return {
    slots: slots.map(({ item, real }) => ({
      key: `outbox:${item.localId}`,
      localId: item.localId,
      item,
      real,
      chip: real === null ? 'waiting' : null,
      card: outboxRow(item, { seesPrices: true }),
    })),
    hidden: new Set(slots.flatMap(({ real }) => (real ? [real._id] : []))),
    heading: slots.every(({ real }) => real !== null)
      ? 'Sent'
      : '1 job not sent yet',
    lineLive: true,
  }
}

/**
 * The phone holding `items`, drawn as `useOutboxList` draws a list of every
 * day: through `latchSlots`, against the rows the tab hands over, the latch
 * held from one render to the next (one redraw throughout).
 */
function drawThrough(items: Array<OutboxItem>) {
  let latch: SlotLatch | null = null
  phone.draw = ({ rows }) => {
    const drawn = latchSlots(latch, {
      items,
      drawing: true,
      rows,
      redrawKey: 'all',
      dayShown: null,
      timezone: TZ,
      dayLive: true,
      now: Date.now(),
      mayAdd: () => true,
    })
    latch = drawn.latch
    return {
      slots: drawn.slots.map((slot) => ({
        ...slot,
        card: outboxRow(slot.item, { seesPrices: true }),
      })),
      hidden: drawn.hidden,
      heading: drawn.heading,
      lineLive: true,
    }
  }
}

/** What they owe, for someone who doesn't see prices: nothing drawn. */
const PRICES_HIDDEN: ClientOwed = {
  pricesHidden: true,
  owing: null,
  toBill: null,
  rows: [],
  more: false,
}

function render(
  summary: Summary,
  reports: Array<InlineReport> = [],
  {
    owed = PRICES_HIDDEN,
  }: {
    /** What they owe as the tab has it: null, not answered (yet). */
    owed?: ClientOwed | null
  } = {},
) {
  // The answers are here already; a fetch would never come back.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { queryFn: () => new Promise(() => {}) } },
  })
  const args = { businessId: B, clientId: C }
  queryClient.setQueryData(
    convexQuery(api.clients.summary, args).queryKey,
    summary,
  )
  queryClient.setQueryData(
    convexQuery(api.clients.visitReports, args).queryKey,
    { reports, capped: false },
  )
  queryClient.setQueryData(
    convexQuery(api.memberships.listForBusiness, { businessId: B }).queryKey,
    [],
  )
  // What they owe (#172), which the tab waits for too: unless a test says,
  // nothing to show, as for someone who doesn't see prices, so the tab
  // draws as before it.
  if (owed !== null) {
    queryClient.setQueryData(
      convexQuery(api.payments.forClient, args).queryKey,
      owed,
    )
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ClientJobsTab
        businessId={B}
        businessSlug="pest-co"
        timezone={TZ}
        clientId={C}
        clientName="Jane Nguyen"
        site="all"
        onSite={() => {}}
      />
    </QueryClientProvider>,
  )
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** How many rows open this job. */
const rowsOf = (html: string, jobId: string) =>
  html.split(`&quot;jobId&quot;:&quot;${jobId}&quot;`).length - 1

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
  phone.list = null
  phone.draw = null
  build.keeping = null
  line.down = null
})

describe('a client’s Jobs tab with bookings on this phone', () => {
  test('a sent Recurring Job’s slot holds its first visit, its whole service out of the sections, and that visit’s reports under it', () => {
    const v1 = ofSeries('v1', FIRST)
    const series = itemFor(
      'u1',
      {
        kind: 'series',
        state: 'sent',
        result: { id: 's1', firstJobId: 'v1' as Id<'jobs'> },
        booking: bookingFor({
          jobType: 'Quarterly Pest Control',
          scheduledAt: FIRST,
          repeat: { count: 3, unit: 'month' },
        }),
      },
      NOW,
    )
    phone.list = listOf([{ item: series, real: v1 }])
    const html = render(
      summaryOf({
        series: [quarterly],
        visits: [
          // Latest first, as `clients.summary` has them.
          ofSeries('v3', FIRST + 182 * DAY),
          ofSeries('v2', FIRST + 91 * DAY),
          v1,
          visit('o1', NOW + 7 * DAY),
        ],
      }),
      [
        {
          _id: 'r1' as Id<'reports'>,
          status: 'draft',
          createdAt: NOW,
          legalBasis: 'WA',
          templateName: 'Pest Treatment Report',
          jobId: 'v1' as Id<'jobs'>,
        },
      ],
    )
    // Drawn once, in its slot; the service's later visits nowhere.
    expect(rowsOf(html, 'v1')).toBe(1)
    expect(rowsOf(html, 'v2')).toBe(0)
    expect(rowsOf(html, 'v3')).toBe(0)
    expect(text(html)).not.toContain('Recurring services')
    // The one-off still in "Coming up" (and with the one-off jobs).
    expect(rowsOf(html, 'o1')).toBe(2)
    // The first visit's report is under it, not with the other reports.
    expect(text(html)).toContain('Pest Treatment Report')
    expect(text(html)).not.toContain('Other reports')
  })

  test('a sent one-off’s slot holds its job, which the sections leave out', () => {
    const job = visit('o2', NOW + 3 * DAY, { jobType: 'General Pest Control' })
    const sent = itemFor(
      'u1',
      {
        state: 'sent',
        result: { id: 'o2' },
        booking: bookingFor({ scheduledAt: job.scheduledAt }),
      },
      NOW,
    )
    phone.list = listOf([{ item: sent, real: job }])
    const html = render(
      summaryOf({ visits: [job, visit('o1', NOW + 7 * DAY)] }),
    )
    expect(rowsOf(html, 'o2')).toBe(1)
    expect(text(html)).toContain('One-off jobs · 1')
  })

  test('with nothing else, its booking says neither “Nothing booked.” nor “No jobs for … yet.”', () => {
    const waiting = itemFor(
      'u1',
      { booking: bookingFor({ scheduledAt: NOW + 3 * DAY }) },
      NOW,
    )
    phone.list = listOf([{ item: waiting, real: null }])
    const said = text(render(summaryOf()))
    expect(said).toContain('1 job not sent yet')
    expect(said).not.toContain('Nothing booked.')
    expect(said).not.toContain('No jobs for Jane Nguyen yet.')
    // None on the phone: both, as before.
    phone.list = listOf([])
    const empty = text(render(summaryOf()))
    expect(empty).toContain('Nothing booked.')
    expect(empty).toContain('No jobs for Jane Nguyen yet.')
  })
})

describe('a booking whose job is here before this tab hears it went (sent from another tab, say): drawn once, as its job (plan §9.4)', () => {
  test('a one-off: its slot draws the job carrying its request id, which the sections leave out', () => {
    const sending = itemFor(
      'u1',
      {
        state: 'sending',
        attempts: 1,
        booking: bookingFor({ scheduledAt: NOW + 3 * DAY }),
      },
      NOW,
    )
    drawThrough([sending])
    const before = render(summaryOf({ visits: [visit('o1', NOW + 7 * DAY)] }))
    expect(text(before)).toContain('1 job sending')
    // The job comes, this tab not having heard.
    const html = render(
      summaryOf({
        visits: [
          visit('o2', NOW + 3 * DAY, { clientRequestId: sending.requestId }),
          visit('o1', NOW + 7 * DAY),
        ],
      }),
    )
    expect(rowsOf(html, 'o2')).toBe(1)
    expect(text(html)).toContain('One-off jobs · 1')
    expect(text(html)).not.toMatch(/sending/i)
  })

  test('a Recurring Job: its slot draws the visit booked, its whole service out of the sections, by the request id the service carries', () => {
    const sending = itemFor(
      'u1',
      {
        kind: 'series',
        state: 'sending',
        attempts: 1,
        booking: bookingFor({
          jobType: 'Quarterly Pest Control',
          scheduledAt: FIRST,
          repeat: { count: 3, unit: 'month' },
        }),
      },
      NOW,
    )
    drawThrough([sending])
    const before = render(summaryOf({ visits: [visit('o1', NOW + 7 * DAY)] }))
    expect(text(before)).toContain('1 job sending')
    const html = render(
      summaryOf({
        series: [{ ...quarterly, clientRequestId: sending.requestId }],
        visits: [
          ofSeries('v3', FIRST + 182 * DAY),
          ofSeries('v2', FIRST + 91 * DAY),
          ofSeries('v1', FIRST),
          visit('o1', NOW + 7 * DAY),
        ],
      }),
    )
    expect(rowsOf(html, 'v1')).toBe(1)
    expect(rowsOf(html, 'v2')).toBe(0)
    expect(rowsOf(html, 'v3')).toBe(0)
    expect(text(html)).not.toContain('Recurring services')
    expect(text(html)).not.toMatch(/sending/i)
    // Another phone's service, booked under another id, is the tab's.
    const theirs = render(
      summaryOf({
        series: [{ ...quarterly, clientRequestId: 'another-phone' }],
        visits: [ofSeries('v1', FIRST)],
      }),
    )
    expect(text(theirs)).toContain('Recurring services · 1')
  })

  test('a Recurring Job with no visit here yet (begun in the past, its next beyond those booked): its service out of the sections, the booking in its slot', () => {
    const sending = itemFor(
      'u1',
      {
        kind: 'series',
        state: 'sending',
        attempts: 1,
        booking: bookingFor({
          jobType: 'Quarterly Pest Control',
          scheduledAt: NOW - 30 * DAY,
          repeat: { count: 12, unit: 'month' },
        }),
      },
      NOW,
    )
    phone.list = listOf([{ item: sending, real: null }])
    const said = text(
      render(
        summaryOf({
          series: [{ ...quarterly, clientRequestId: sending.requestId }],
        }),
      ),
    )
    expect(said).not.toContain('Recurring services')
    expect(said).toContain('1 job not sent yet')
  })
})

describe('what they owe, which the tab waits for, isn’t kept on the phone: with the line down, the tab draws without it (keeping on)', () => {
  /** $120 owing on one job, billed a week ago. */
  const OWING: ClientOwed = {
    pricesHidden: false,
    owing: { count: 1, value: 120, since: NOW - 7 * DAY },
    toBill: { count: 0, value: 0 },
    rows: [
      {
        _id: 'o9' as Id<'jobs'>,
        list: 'owing',
        jobNumber: 90,
        jobType: 'General Pest Control',
        scheduledAt: NOW - 8 * DAY,
        completedAt: NOW - 8 * DAY,
        invoicedAt: NOW - 7 * DAY,
        price: 120,
        paid: 0,
        owed: 120,
      },
    ],
    more: false,
  } as unknown as ClientOwed

  function waitingBooking() {
    const waiting = itemFor(
      'u1',
      { booking: bookingFor({ scheduledAt: NOW + 3 * DAY }) },
      NOW,
    )
    phone.list = listOf([{ item: waiting, real: null }])
  }

  test('not answered, the line down: their jobs and the booking on this phone, with nothing of what they owe', () => {
    build.keeping = true
    line.down = 'no-signal'
    waitingBooking()
    const said = text(
      render(summaryOf({ visits: [visit('o1', NOW + 7 * DAY)] }), [], {
        owed: null,
      }),
    )
    expect(said).not.toContain('Loading their jobs')
    expect(said).toContain('1 job not sent yet')
    expect(said).toContain('Coming up')
    expect(said).not.toContain('What they owe')
  })

  test('not answered, the line up: the tab waits for it, as ever', () => {
    build.keeping = true
    waitingBooking()
    const said = text(render(summaryOf(), [], { owed: null }))
    expect(said).toContain('Loading their jobs')
    expect(said).not.toContain('1 job not sent yet')
  })

  test('keeping off: the tab waits for it with the line down too, as on main', () => {
    build.keeping = false
    line.down = 'no-signal'
    waitingBooking()
    const said = text(render(summaryOf(), [], { owed: null }))
    expect(said).toContain('Loading their jobs')
  })

  test('answered before the line went: drawn above their jobs, as ever', () => {
    build.keeping = true
    line.down = 'no-signal'
    phone.list = listOf([])
    const said = text(
      render(summaryOf({ visits: [visit('o1', NOW + 7 * DAY)] }), [], {
        owed: OWING,
      }),
    )
    expect(said).toContain('What they owe')
    expect(said.indexOf('What they owe')).toBeLessThan(
      said.indexOf('Coming up'),
    )
  })
})
