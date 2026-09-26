import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConvexError } from 'convex/values'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { UNDO_STUCK_MS } from '../../../../convex/lib/clientImport'
import { ImportingStep } from './ImportingStep'
import { RecheckNote, ReviewStep } from './ReviewStep'
import { UndoHold } from './undo'
import type * as ConvexReactQuery from '@convex-dev/react-query'
import type { ReactNode } from 'react'
import type { RecentImport } from './queries'
import type { RunState } from './useImportRun'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { ReviewClient } from '#/lib/clientImport/types'

/**
 * The review's filter and the paused import, rendered: what the chips
 * count, and what a batch the server turned down is called.
 */

// Carry on undoing is a Convex mutation; nothing here presses it.
vi.mock('@convex-dev/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ConvexReactQuery>()),
  useConvexMutation: () => async () => null,
}))
// Up and running: on the server's render every button is disabled anyway,
// which would say nothing about what holds Import back.
vi.mock('#/lib/useHydrated', () => ({ useHydrated: () => true }))

// The edit sheet (vaul) reads the page's address as it mounts, which the
// test runtime hasn't got.
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://localhost/'))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

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

const noSuburb = {
  issues: [
    {
      level: 'error' as const,
      field: 'suburb' as const,
      siteIndex: 0,
      message: 'No suburb.',
    },
  ],
}

function review(clients: Array<ReviewClient>) {
  return text(
    renderToStaticMarkup(
      <ReviewStep
        sheet={{
          fileName: 'clients.csv',
          headers: ['Name'],
          rows: clients.map((c) => [c.name]),
        }}
        clients={clients}
        progress={null}
        checkFailed={false}
        businessState="WA"
        onFix={() => {}}
        onSave={() => {}}
        onToggle={() => {}}
        onBack={() => {}}
        onImport={() => {}}
      />,
    ),
  )
}

describe('ReviewStep', () => {
  it('files a left-out client under Left out, not under what it was', () => {
    const page = review([
      client('c1'),
      client('c2', noSuburb),
      client('c3', { ...noSuburb, included: false }),
    ])
    expect(page).toContain('Can’t import 1')
    expect(page).toContain('Left out 1')
    expect(page).toContain('Ready 1')
    expect(page).toContain('Import 1 client')
  })

  it('offers no Left out chip while nothing is left out', () => {
    expect(review([client('c1')])).not.toContain('Left out')
  })

  it('says what it is waiting for before the addresses are checked', () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        sheet={{ fileName: 'clients.csv', headers: ['Name'], rows: [] }}
        clients={null}
        progress={null}
        checkFailed={false}
        businessState="WA"
        onFix={() => {}}
        onSave={() => {}}
        onToggle={() => {}}
        onBack={() => {}}
        onImport={() => {}}
      />,
    )
    const page = text(html)
    expect(page).toContain('Checking what’s in PestM8…')
    // Where focus goes after Continue, whose button went with Match.
    expect(html).toMatch(
      /<h2 tabindex="-1" data-step-heading=""[^>]*>Checking what’s in PestM8…<\/h2>/,
    )
    // With no signal that wait is open-ended: there is a way back.
    expect(page).toContain('Change the columns')
  })
})

describe('ReviewStep, with an undo since it was built', () => {
  const NOW = Date.now()
  const undoing = (over: Partial<RecentImport> = {}) =>
    ({
      _id: 'i9' as Id<'clientImports'>,
      fileName: 'old-list.csv',
      createdAt: NOW - 60_000,
      clients: 1,
      sites: 1,
      notes: 0,
      skipped: 0,
      failed: 0,
      byName: 'Jo',
      canUndo: true,
      undoneAt: NOW - 1_000,
      undoState: 'running',
      ...over,
    }) as RecentImport

  function reviewWith(wait?: ReactNode) {
    const clients = [client('c1')]
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ReviewStep
          sheet={{
            fileName: 'clients.csv',
            headers: ['Name'],
            rows: clients.map((c) => [c.name]),
          }}
          clients={clients}
          progress={null}
          checkFailed={false}
          businessState="WA"
          wait={wait}
          onFix={() => {}}
          onSave={() => {}}
          onToggle={() => {}}
          onBack={() => {}}
          onImport={() => {}}
        />
      </QueryClientProvider>,
    )
  }

  /** Whether the button with these words is there and can be pressed. */
  function button(html: string, words: string) {
    const found = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find(
      ([, , inside]) => text(inside) === words,
    )
    if (!found) return 'missing'
    return /\sdisabled=""/.test(found[1]) ? 'disabled' : 'enabled'
  }

  it('lets Import go when nothing waits', () => {
    expect(button(reviewWith(), 'Import 1 client')).toBe('enabled')
  })

  it('holds Import while another import is being undone, and says why', () => {
    const html = reviewWith(
      <UndoHold
        businessId={'b1' as Id<'businesses'>}
        row={undoing()}
        stopped={false}
        then="import"
      />,
    )
    expect(text(html)).toContain(
      'Undoing “old-list.csv” — you can import once it’s done.',
    )
    expect(button(html, 'Import 1 client')).toBe('disabled')
    expect(button(html, 'Carry on undoing')).toBe('missing')
  })

  it('offers to carry on an undo that stopped, and still holds Import', () => {
    const html = reviewWith(
      <UndoHold
        businessId={'b1' as Id<'businesses'>}
        row={undoing({ undoneAt: NOW - UNDO_STUCK_MS - 1_000 })}
        stopped
        then="import"
      />,
    )
    expect(text(html)).toContain(
      'Undoing “old-list.csv” stopped part-way. Carry it on, and you can import once it’s done.',
    )
    expect(button(html, 'Carry on undoing')).toBe('enabled')
    expect(button(html, 'Import 1 client')).toBe('disabled')
  })

  it('holds Import while PestM8 is read again after the undo', () => {
    const html = reviewWith(<RecheckNote error={null} onRetry={() => {}} />)
    expect(text(html)).toContain(
      'Checking what’s in PestM8 again after the undo…',
    )
    expect(button(html, 'Import 1 client')).toBe('disabled')
  })

  it('says so when that read fails, with a way to try it again', () => {
    const html = reviewWith(
      <RecheckNote
        error={
          new Error('[CONVEX Q(clients:list)] [Request ID: 1] Server Error')
        }
        onRetry={() => {}}
      />,
    )
    expect(text(html)).toContain(
      'Couldn’t read what’s in PestM8 since the undo, so Import waits. Check again in a moment.',
    )
    expect(button(html, 'Check again')).toBe('enabled')
    expect(button(html, 'Import 1 client')).toBe('disabled')
  })
})

describe('ImportingStep', () => {
  const failed = (error: unknown, retryable = true): RunState => ({
    status: 'failed',
    importId: null,
    sent: 25,
    total: 60,
    results: [],
    error,
    retryable,
  })

  it('doesn’t blame the connection for a batch the server turned down', () => {
    const page = text(
      renderToStaticMarkup(
        <ImportingStep
          state={failed(
            new Error(
              '[CONVEX M(clientImports:addBatch)] [Request ID: 1] Server Error',
            ),
          )}
          onRetry={() => {}}
          onFinish={() => {}}
        />,
      ),
    )
    expect(page).not.toContain('connection dropped')
    expect(page).toContain('PestM8 couldn’t take the last few clients')
    // The two ways on it names are the two buttons on the screen.
    expect(page).toContain('Try again')
    expect(page).toContain('Stop here')
  })

  it('pauses for another import’s undo, and says Try again carries on once it’s done', () => {
    const page = text(
      renderToStaticMarkup(
        <ImportingStep
          state={failed(new ConvexError('UNDO_IN_PROGRESS'))}
          onRetry={() => {}}
          onFinish={() => {}}
        />,
      ),
    )
    expect(page).toContain('The import is paused')
    expect(page).toContain(
      'An earlier import is still being undone. Once it’s finished, Try again carries on from here.',
    )
    expect(page).toContain('Try again')
  })

  it('says which undo it waits for, with a way to carry it on, while it is paused', () => {
    const wait = <p>Undoing “old.csv” stopped part-way.</p>
    const paused = text(
      renderToStaticMarkup(
        <ImportingStep
          state={failed(new ConvexError('UNDO_IN_PROGRESS'))}
          wait={wait}
          onRetry={() => {}}
          onFinish={() => {}}
        />,
      ),
    )
    expect(paused).toContain('Undoing “old.csv” stopped part-way.')
    // Stopped for good, nothing is waited for.
    const stopped = text(
      renderToStaticMarkup(
        <ImportingStep
          state={failed(new ConvexError('NO_ACCESS'), false)}
          wait={wait}
          onRetry={() => {}}
          onFinish={() => {}}
        />,
      ),
    )
    expect(stopped).not.toContain('old.csv')
  })

  it('gives focus somewhere to go while it sends — after Import, or Try again', () => {
    const html = renderToStaticMarkup(
      <ImportingStep
        state={{ ...failed(null), status: 'running' }}
        onRetry={() => {}}
        onFinish={() => {}}
      />,
    )
    expect(html).toMatch(
      /<h2 tabindex="-1" data-step-heading=""[^>]*>Importing… 25 of 60<\/h2>/,
    )
  })
})
