import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { UNDO_STUCK_MS } from '../../../../convex/lib/clientImport'
import { MatchStep } from './MatchStep'
import { UndoHold } from './undo'
import type * as ConvexReactQuery from '@convex-dev/react-query'
import type { ReactNode } from 'react'
import type { RecentImport } from './queries'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * Continue reads what's already in PestM8 once, and keeps it: while an
 * import is being undone — or its undo has stopped part-way — it waits, and
 * says why, as the page hands it `UndoHold`.
 */

vi.mock('@convex-dev/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ConvexReactQuery>()),
  useConvexMutation: () => async () => null,
}))
// Up and running: on the server's render every button is disabled anyway.
vi.mock('#/lib/useHydrated', () => ({ useHydrated: () => true }))

const BUSINESS = 'b1' as Id<'businesses'>
const NOW = Date.now()

const row = (over: Partial<RecentImport>): RecentImport =>
  ({
    _id: 'i1' as Id<'clientImports'>,
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
  }) as RecentImport

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Whether Continue can be pressed, in a static render. */
function canContinue(html: string): boolean {
  const found = /<button([^>]*)>Continue<\/button>/.exec(html)
  expect(found).not.toBeNull()
  return !/\sdisabled=""/.test(found![1])
}

function match(wait?: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MatchStep
        sheet={{
          fileName: 'jobber-clients.csv',
          headers: ['Name', 'Address'],
          rows: [['Jo Smith', '12 Wattle St, Bayswater WA 6053']],
        }}
        source={null}
        mapping={['name', 'address']}
        error={null}
        wait={wait}
        onChange={() => {}}
        onBack={() => {}}
        onContinue={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('MatchStep while an undo runs', () => {
  it('continues when nothing is being undone', () => {
    expect(canContinue(match())).toBe(true)
  })

  it('holds Continue while an undo is going, and says why', () => {
    const html = match(
      <UndoHold
        businessId={BUSINESS}
        row={row({ undoneAt: NOW - 1_000, undoState: 'running' })}
        stopped={false}
        then="continue"
      />,
    )
    expect(canContinue(html)).toBe(false)
    expect(text(html)).toContain(
      'Undoing “jobber-clients.csv” — you can continue once it’s done.',
    )
  })

  it('holds Continue for an undo that stopped, with the way to carry it on', () => {
    const html = match(
      <UndoHold
        businessId={BUSINESS}
        row={row({
          undoneAt: NOW - UNDO_STUCK_MS - 1_000,
          undoState: 'running',
        })}
        stopped
        then="continue"
      />,
    )
    expect(canContinue(html)).toBe(false)
    expect(text(html)).toContain('Carry it on, and you can continue')
    expect(text(html)).toContain('Carry on undoing')
  })
})
