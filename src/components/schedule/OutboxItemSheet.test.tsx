import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, test, vi } from 'vitest'
import { outboxFooter } from '#/lib/outbox/outboxInset'
import { outboxRow } from '#/lib/outbox/outboxRow'
import { DISPLAY, bookingFor, itemFor } from '#/lib/outbox/outboxStore.fixtures'
import { JobDetailSheet } from './JobDetailSheet'
import {
  SHEET_BODY_ABOVE_FOOTER,
  SHEET_FOOTER,
} from '#/components/primitives/Sheet'
import { NOT_ON_PHONE, OutboxItemView, handOverTo } from './OutboxItemSheet'
import { OutboxGroup } from './OutboxGroup'
import type { ReactNode } from 'react'
import type { InsetFacts } from '#/lib/outbox/outboxInset'
import type { OutboxItem } from '#/lib/outbox/outboxItem'
import type { WeatherCell } from '#/lib/weather'
import type { Id } from '../../../convex/_generated/dataModel'

// The keeper and the outbox read who is signed in (lib/rootState.ts), whose
// server function needs a deployment's address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

// vaul's pieces as plain elements: there's no document here to open one in.
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
      Handle: () => null,
      NestedRoot: pass,
    },
  }
})

/**
 * A booking's sheet (plan part 2c §9.5): what it draws for a booking in
 * each state, its footer's fix and Discard, and that the server and a
 * hydrating render never open it (F18).
 */

const TZ = 'Australia/Perth'
const SAVED = Date.UTC(2026, 9, 27, 1, 42)

function draw(
  item: OutboxItem,
  extra: Partial<InsetFacts> = {},
  holdFooter = false,
) {
  const facts: InsetFacts = {
    item,
    lineLive: true,
    held: null,
    sendingHere: false,
    sendingElsewhere: false,
    storageTrouble: false,
    timezone: TZ,
    todayKey: '2026-10-27',
    ...extra,
  }
  return renderToStaticMarkup(
    <OutboxItemView
      facts={facts}
      footer={outboxFooter(item, { now: SAVED, mayHaveGone: false })}
      holdFooter={holdFooter}
      roster={undefined}
      down={null}
      seesPrices
    />,
  )
}

describe('the sheet of a booking on the phone', () => {
  test('sent, its footer’s space kept unseen where it had one, the body as it was above it', () => {
    const sent = itemFor(
      'u1',
      { state: 'sent', result: { id: 'j1' }, sentAt: SAVED },
      SAVED,
    )
    const held = draw(sent, {}, true)
    expect(held).toContain(`${SHEET_FOOTER} invisible`)
    expect(held).toContain(SHEET_BODY_ABOVE_FOOTER)
    expect(held).not.toContain('>Discard<')
    expect(draw(sent)).not.toContain(`${SHEET_FOOTER} invisible`)
    expect(draw(sent)).not.toContain(SHEET_BODY_ABOVE_FOOTER)
  })

  test('booked on a client with a number: it’s printed beside their name, as the job’s sheet will, so the name wraps there and nothing moves at the hand-over', () => {
    const html = draw(
      itemFor('u1', { display: { ...DISPLAY, clientNumber: 2041 } }, SAVED),
    )
    expect(html).toContain('Client #2041')
    // "Job #" is how e2e/outbox.spec.ts knows the sheet has become the job's.
    expect(html).not.toMatch(/Job #\d+/)
    const none = draw(
      itemFor(
        'u1',
        { display: { ...DISPLAY, clientNumber: undefined } },
        SAVED,
      ),
    )
    expect(none).not.toContain('Client #')
  })

  test('waiting: where it is, when it was saved, and Edit beside Discard', () => {
    const html = draw(itemFor('u1', {}, SAVED))
    expect(html).toContain('Not sent yet — it goes in a moment.')
    expect(html).toContain('Saved on this phone at 9:42am.')
    expect(html).toContain('>Edit<')
    expect(html).toContain('>Discard<')
  })

  test('needing a look: why, in FormAlert, and its fix', () => {
    const html = draw(
      itemFor(
        'u1',
        { state: 'needsLook', problem: { code: 'STALE' } },
        Date.UTC(2026, 9, 20, 1),
      ),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain(
      'Saved on this phone on Tue 20 Oct and not sent. Send it now, or discard it.',
    )
    expect(html).toContain('>Send<')
  })

  test('an unknown refusal says Edit or Discard, never the offline words', () => {
    const html = draw(
      itemFor('u1', { state: 'needsLook', problem: { code: 'ODD' } }, SAVED),
    )
    expect(html).toContain(
      'Could not book this job. Nothing was booked — edit it to book it, or discard it.',
    )
  })

  test('sending: says not to book it again, with both buttons there and locked', () => {
    const html = draw(itemFor('u1', { state: 'sending' }, SAVED))
    expect(html).toContain('so it may already be booked')
    expect(html.match(/disabled=""/g)?.length).toBe(2)
  })

  test('each footer button is padded past its word, and 44 wide however short it is', () => {
    const buttons = (html: string) =>
      [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)</g)]
        .filter(([, , word]) =>
          ['Edit', 'Send', 'Try again', 'Change the date'].includes(word),
        )
        .map(([, classes]) => classes.split(' '))
    const shown = [
      draw(itemFor('u1', {}, SAVED)),
      draw(
        itemFor(
          'u1',
          { state: 'needsLook', problem: { code: 'SERVER' } },
          SAVED,
        ),
      ),
      draw(
        itemFor('u1', { state: 'needsLook', problem: { code: 'STALE' } }, 1),
      ),
    ].flatMap(buttons)
    // Edit; Edit beside Try again; Send.
    expect(shown).toHaveLength(4)
    for (const classes of shown) {
      expect(classes).toEqual(expect.arrayContaining(['px-4', 'min-w-11']))
    }
  })

  test('saved by a newer PestM8 and sent: its line says why Discard is locked', () => {
    const html = draw(itemFor('u1', { v: 2, state: 'sending' }, SAVED))
    expect(html).toContain('Saved by a newer PestM8 and sent')
    expect(html.match(/disabled=""/g)?.length).toBe(1)
  })

  test('saved by a newer PestM8: its line, and Discard alone', () => {
    const html = draw(itemFor('u1', { v: 2 }, SAVED))
    expect(html).toContain('Saved by a newer PestM8.')
    expect(html).toContain('>Discard<')
    expect(html).not.toContain('>Edit<')
  })

  test('sent: no footer', () => {
    const html = draw(
      itemFor(
        'u1',
        { state: 'sent', result: { id: 'j1' }, sentAt: SAVED },
        SAVED,
      ),
    )
    expect(html).toContain('Sent — PestM8 has booked it.')
    expect(html).not.toContain('>Discard<')
  })
})

describe('the hand-over to its job', () => {
  test('a one-off’s job as soon as the answer is heard; a Recurring Job’s first visit once found', () => {
    const job = itemFor('u1', {}, SAVED)
    expect(handOverTo(job, undefined)).toBeNull()
    expect(handOverTo(job, { id: 'j1' })).toBe('j1')
    expect(
      handOverTo({ ...job, state: 'sent', result: { id: 'j2' } }, undefined),
    ).toBe('j2')
    const series = itemFor(
      'u1',
      {
        kind: 'series',
        booking: bookingFor({ repeat: { count: 3, unit: 'month' } }),
      },
      SAVED,
    )
    // The recurrence's own id is no job's.
    expect(
      handOverTo(
        { ...series, state: 'sent', result: { id: 'r1' } },
        { id: 'r1' },
      ),
    ).toBeNull()
    expect(
      handOverTo(
        {
          ...series,
          state: 'sent',
          result: { id: 'r1', firstJobId: 'j9' as Id<'jobs'> },
        },
        undefined,
      ),
    ).toBe('j9')
  })
})

describe('today’s group, with one saved by a newer PestM8 (D13)', () => {
  test('its card says what it is once, beside its chip', () => {
    const html = renderToStaticMarkup(
      <OutboxGroup
        day={{
          slots: [],
          foreign: [itemFor('u1', { v: 2 }, SAVED)],
          hidden: new Set(),
          heading: '1 job not sent yet',
          lineLive: false,
        }}
        timezone={TZ}
        dayShown="2026-10-27"
        onOpenItem={() => {}}
        onOpenJob={() => {}}
        weatherOf={() => ({ status: 'outOfWindow' })}
        grid=""
      />,
    )
    expect(html).toContain('A job saved by a newer PestM8')
    expect(html).toContain('Not sent yet')
    expect(html).not.toContain('Saved by a newer PestM8.')
  })
})

describe('today’s group, with a booking of another day (D13)', () => {
  const TODAY = '2026-11-11'
  const READY: WeatherCell = {
    status: 'ready',
    weather: { suburb: 'Perth', code: 0, maxTempC: 39, minTempC: 21 },
  }

  function card(scheduledAt: number, cell: WeatherCell) {
    const item = itemFor(
      'u1',
      { booking: bookingFor({ scheduledAt }), state: 'needsLook' },
      SAVED,
    )
    return renderToStaticMarkup(
      <OutboxGroup
        day={{
          slots: [
            {
              key: `outbox:${item.localId}`,
              localId: item.localId,
              item,
              real: null,
              chip: 'needsLook',
              row: outboxRow(item, { seesPrices: true }),
            },
          ],
          hidden: new Set(),
          heading: '1 job not sent yet',
          lineLive: false,
        }}
        timezone={TZ}
        dayShown={TODAY}
        onOpenItem={() => {}}
        onOpenJob={() => {}}
        weatherOf={() => cell}
        grid=""
      />,
    )
  }

  // 9am in Perth, Saturday; the forecast on hand is Wednesday's, or none.
  const SATURDAY = Date.UTC(2026, 10, 14, 1)

  test('prints its own date beside no forecast of the day on screen', () => {
    const html = card(SATURDAY, READY)
    expect(html).toContain('Sat 14 Nov')
    expect(html).not.toContain('39°')
  })

  test('never says "No forecast" of a day nobody asked about', () => {
    expect(card(SATURDAY, { status: 'absent' })).not.toContain('No forecast')
  })

  test('a booking of the day shown keeps the day’s forecast', () => {
    expect(card(Date.UTC(2026, 10, 11, 1), READY)).toContain('39°')
  })
})

describe('?outboxId= on a server render (F18)', () => {
  test('draws the sheet closed: nothing to show until the phone is read', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <JobDetailSheet
          businessId={'b1' as Id<'businesses'>}
          businessSlug="pest-co"
          timezone={TZ}
          jobId={null}
          outboxId="local-1"
          canReassign={false}
          canDelete={false}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(html).not.toContain(NOT_ON_PHONE)
    expect(html).not.toContain('Not sent yet')
    expect(html).not.toContain('>Job<')
  })
})
