import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { UNDO_STUCK_MS } from '../../../../convex/lib/clientImport'
import { ChooseStep } from './ChooseStep'
import { DoneStep } from './DoneStep'
import { recentImports } from './queries'
import { undoClock, undoHolding, useUndoClock } from './undo'
import type * as ConvexReactQuery from '@convex-dev/react-query'
import type * as ReactRouter from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { RecentImport } from './queries'
import type { ImportResult } from '../../../../convex/lib/clientImport'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { ReviewClient } from '#/lib/clientImport/types'

/**
 * The Done screen and Recent imports, rendered against a recent-imports
 * answer: what the Done screen says once its import is being undone, what
 * it says about clients left out, and what an undo that stopped offers.
 */

// Undo is a Convex mutation, and Go to clients a router link; nothing here
// presses either.
vi.mock('@convex-dev/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ConvexReactQuery>()),
  useConvexMutation: () => async () => null,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
// As on the phone once the page is up: every button would be disabled on
// the server's render, which would say nothing about what holds one back.
// Set back to false for what the server's render says.
const screen = vi.hoisted(() => ({ hydrated: true }))
vi.mock('#/lib/useHydrated', () => ({ useHydrated: () => screen.hydrated }))

const BUSINESS = 'b1' as Id<'businesses'>
const IMPORT = 'i1' as Id<'clientImports'>
const NOW = Date.now()
/** The page's clock, up and with nothing learnt (`useUndoClock`). */
const CLOCK = undoClock(NOW, undefined, true)

function row(over: Partial<RecentImport> = {}): RecentImport {
  return {
    _id: IMPORT,
    fileName: 'jobber-clients.csv',
    createdAt: NOW - 60_000,
    clients: 1,
    sites: 1,
    notes: 0,
    skipped: 0,
    failed: 0,
    byName: 'Jo',
    canUndo: true,
    ...over,
  } as RecentImport
}

function withImports(rows: Array<RecentImport>, children: ReactNode) {
  // The answer is already here; a fetch would never come back.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { queryFn: () => new Promise(() => {}) } },
  })
  queryClient.setQueryData(recentImports(BUSINESS).queryKey, rows)
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Whether the button with these words is there and can be pressed, in a
 * static render: 'enabled', 'disabled', or 'missing'. */
function button(html: string, words: string) {
  const found = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find(
    ([, , inside]) => text(inside) === words,
  )
  if (!found) return 'missing'
  return /\sdisabled=""/.test(found[1]) ? 'disabled' : 'enabled'
}

const OTHER = 'i2' as Id<'clientImports'>
const STOPPED = {
  undoneAt: NOW - UNDO_STUCK_MS - 1_000,
  undoState: 'running' as const,
}

function client(key: string, over: Partial<ReviewClient> = {}): ReviewClient {
  return {
    key,
    rowNumbers: [Number(key.slice(1))],
    kind: 'person',
    name: `Client ${key}`,
    sites: [
      {
        addressLine: `${key.slice(1)} Main St`,
        suburb: 'Perth',
        state: 'WA',
        postcode: '6000',
      },
    ],
    issues: [],
    included: true,
    ...over,
  }
}

const REVIEW = [client('c1'), client('c2', { included: false })]
const RESULTS: Array<ImportResult> = [
  {
    key: 'c1',
    status: 'created',
    sitesCreated: 1,
    sitesSkipped: 0,
    notesCreated: 1,
  },
]

function done(rows: Array<RecentImport>) {
  return renderToStaticMarkup(
    withImports(
      rows,
      <DoneStep
        businessId={BUSINESS}
        businessSlug="acme"
        sheet={{
          fileName: 'jobber-clients.csv',
          headers: ['Name'],
          rows: [['Client c1'], ['Client c2']],
        }}
        review={REVIEW}
        results={RESULTS}
        importId={IMPORT}
        clock={CLOCK}
        onAnother={() => {}}
      />,
    ),
  )
}

describe('DoneStep', () => {
  it('says the clients left out apart from the ones that couldn’t go in', () => {
    const page = text(done([row()]))
    expect(page).toContain('1 client and 1 site are in PestM8')
    expect(page).toContain('1 client left out')
    expect(page).not.toContain('couldn’t be imported')
    // Left out rows are still in the download.
    expect(page).toContain('Download rows not imported')
  })

  it('once undone, drops what the import brought in', () => {
    const undoing = done([row({ undoneAt: NOW - 1_000, undoState: 'running' })])
    expect(text(undoing)).toContain('Undoing this import')
    expect(text(undoing)).toContain(
      'You can import another file once it’s done.',
    )
    expect(undoing).not.toContain('1 site note')
    expect(undoing).not.toContain('Download rows not imported')
    // No tick for an import being taken back.
    expect(undoing).not.toContain('<svg viewBox="0 0 24 24"')

    const undone = text(
      done([
        row({
          undoneAt: NOW - 5_000,
          undoState: 'done',
          undoRemoved: 2,
          undoKept: 0,
        }),
      ]),
    )
    expect(undone).toContain('This import has been undone')
    expect(undone).not.toContain('1 client left out')
  })

  it('offers to carry on an undo that stopped part-way, and holds another file back', () => {
    const html = done([row({ ...STOPPED })])
    const page = text(html)
    expect(page).toContain('This undo stopped part-way')
    expect(page).toContain(
      'Carry it on, and you can import another file once it’s done.',
    )
    expect(button(html, 'Carry on undoing')).toBe('enabled')
    // Stopped, it still holds the rows a re-import would skip.
    expect(button(html, 'Import another file')).toBe('disabled')
  })

  it('an undo carried on is undoing again, and still holds another file back', () => {
    const html = done([
      row({
        ...STOPPED,
        // Carrying it on marks a step; `undoneAt` stays as it was.
        undoStepAt: NOW - 1_000,
      }),
    ])
    expect(text(html)).toContain('Undoing this import')
    expect(button(html, 'Carry on undoing')).toBe('missing')
    expect(button(html, 'Import another file')).toBe('disabled')
  })

  it('holds another file back for another import’s undo, and says why', () => {
    const html = done([
      row(),
      row({
        _id: OTHER,
        fileName: 'old-list.csv',
        ...STOPPED,
      }),
    ])
    const page = text(html)
    // This import stands.
    expect(page).toContain('1 client and 1 site are in PestM8')
    expect(button(html, 'Import another file')).toBe('disabled')
    expect(page).toContain(
      'Undoing “old-list.csv” stopped part-way. Carry it on, and you can import another file once it’s done.',
    )
    expect(button(html, 'Carry on undoing')).toBe('enabled')
  })

  it('lets another file in once nothing is being undone', () => {
    const html = done([
      row(),
      row({
        _id: OTHER,
        undoneAt: NOW - 5_000,
        undoState: 'done',
      }),
    ])
    expect(button(html, 'Import another file')).toBe('enabled')
  })
})

describe('ChooseStep', () => {
  function choose(rows: Array<RecentImport>) {
    return renderToStaticMarkup(
      withImports(
        rows,
        <ChooseStep
          businessId={BUSINESS}
          timezone="Australia/Perth"
          reading={false}
          // As the page works it out.
          holding={undoHolding(rows, CLOCK)}
          clock={CLOCK}
          error={null}
          onChoose={() => {}}
        />,
      ),
    )
  }

  it('lets a file be chosen when nothing is being undone', () => {
    const html = choose([row()])
    expect(button(html, 'Choose a file')).toBe('enabled')
    expect(text(html)).not.toContain('once it’s done')
  })

  it('says why a file must wait while an undo runs', () => {
    const html = choose([row({ undoneAt: NOW - 1_000, undoState: 'running' })])
    const page = text(html)
    expect(page).toContain(
      'Undoing “jobber-clients.csv” — you can choose a file once it’s done.',
    )
    expect(page).toContain('Undoing…')
    expect(button(html, 'Choose a file')).toBe('disabled')
  })

  it('holds a file back for an undo that stopped, with a way to carry it on', () => {
    const html = choose([row({ ...STOPPED })])
    const page = text(html)
    expect(page).toContain(
      'Undoing “jobber-clients.csv” stopped part-way. Carry it on, and you can choose a file once it’s done.',
    )
    expect(button(html, 'Choose a file')).toBe('disabled')
    // Beside the message, and on its row in Recent imports.
    expect(page.match(/Carry on undoing/g)).toHaveLength(2)
    expect(page).toContain('Undo stopped')
  })

  it('tells someone who can’t carry a stopped undo on who can', () => {
    const html = choose([row({ ...STOPPED, canUndo: false })])
    const page = text(html)
    expect(button(html, 'Choose a file')).toBe('disabled')
    expect(page).toContain(
      'Whoever ran that import, or the business owner, can carry it on — you can choose a file once it’s done.',
    )
    expect(page).toContain(
      'Whoever ran this import, or the business owner, can carry it on.',
    )
    expect(page).not.toContain('Carry on undoing')
  })
})

describe('an undo that has stopped, on the server’s render', () => {
  /** The first step as the page draws it: its one clock, handed down. */
  function Choose({ rows }: { rows: Array<RecentImport> }) {
    const clock = useUndoClock(rows)
    return (
      <ChooseStep
        businessId={BUSINESS}
        timezone="Australia/Perth"
        reading={false}
        holding={undoHolding(rows, clock)}
        clock={clock}
        error={null}
        onChoose={() => {}}
      />
    )
  }
  const render = (rows: Array<RecentImport>, hydrated: boolean) => {
    screen.hydrated = hydrated
    try {
      return renderToStaticMarkup(withImports(rows, <Choose rows={rows} />))
    } finally {
      screen.hydrated = true
    }
  }

  it('says only “Undoing…”, whatever the clocks, until the page is up', () => {
    const rows = [row({ ...STOPPED })]
    const server = text(render(rows, false))
    expect(server).toContain(
      'Undoing “jobber-clients.csv” — you can choose a file once it’s done.',
    )
    expect(server).toContain('Undoing…')
    expect(server).not.toContain('stopped part-way')
    expect(server).not.toContain('Undo stopped')
    expect(server).not.toContain('Carry on undoing')

    // Up, the message beside the button and the row agree that it stopped.
    const up = text(render(rows, true))
    expect(up).toContain(
      'Undoing “jobber-clients.csv” stopped part-way. Carry it on, and you can choose a file once it’s done.',
    )
    expect(up).toContain('Undo stopped')
    expect(up.match(/Carry on undoing/g)).toHaveLength(2)
  })

  it('the Done screen says “Undoing…” too until the page is up', () => {
    const rows = [row({ ...STOPPED })]
    const html = renderToStaticMarkup(
      withImports(
        rows,
        <DoneStep
          businessId={BUSINESS}
          businessSlug="acme"
          sheet={{
            fileName: 'jobber-clients.csv',
            headers: ['Name'],
            rows: [['Client c1'], ['Client c2']],
          }}
          review={REVIEW}
          results={RESULTS}
          importId={IMPORT}
          clock={undoClock(NOW, undefined, false)}
          onAnother={() => {}}
        />,
      ),
    )
    expect(text(html)).toContain('Undoing… the clients and sites')
    expect(text(html)).not.toContain('stopped part-way')
    expect(button(html, 'Carry on undoing')).toBe('missing')
  })
})
