import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { rq } from '#/lib/routeQueries'
import { dropIdleClientLists } from './queries'
import { ConvexError } from 'convex/values'
import { refusedBeforeStart, sendJob } from './useImportRun'
import type { Job, RunState } from './useImportRun'
import type {
  ImportClient,
  ImportResult,
} from '../../../../convex/lib/clientImport'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * One go at an import, as useImportRun makes it: that the idle client lists
 * are let go of before every batch — Try again's included — and not only
 * once at the start, which a link preloaded mid-import would undo.
 */

const BUSINESS = 'b1' as Id<'businesses'>
const IMPORT = 'i1' as Id<'clientImports'>

const clientOf = (key: string) => ({ key }) as unknown as ImportClient
const resultOf = (clients: Array<ImportClient>): Array<ImportResult> =>
  clients.map((c) => ({
    key: c.key,
    status: 'created',
    sitesCreated: 1,
    sitesSkipped: 0,
    notesCreated: 0,
  }))

function job(batches: number): Job {
  return {
    batches: Array.from({ length: batches }, (_, i) => [clientOf(`c${i}`)]),
    landed: 0,
    importId: null,
    fileName: 'clients.csv',
    source: null,
  }
}

describe('sendJob', () => {
  it('lets go of the idle lists before every batch, Try again’s too', async () => {
    const said: Array<string> = []
    let failOnce = true
    const io = {
      start: async () => {
        said.push('start')
        return IMPORT
      },
      addBatch: async (
        _: Id<'clientImports'>,
        clients: Array<ImportClient>,
      ) => {
        said.push(`send ${clients[0].key}`)
        if (clients[0].key === 'c2' && failOnce) {
          failOnce = false
          throw new Error('Server Error')
        }
        return resultOf(clients)
      },
      beforeBatch: () => said.push('drop'),
      started: () => said.push('started'),
      landed: (index: number) => said.push(`landed ${index}`),
      stopped: () => false,
    }
    const run = job(4)

    await expect(sendJob(run, io)).rejects.toThrow('Server Error')
    expect(said).toEqual([
      'start',
      'started',
      'drop',
      'send c0',
      'landed 0',
      'drop',
      'send c1',
      'landed 1',
      'drop',
      'send c2',
    ])
    // Where Try again carries on from.
    expect(run.landed).toBe(2)
    expect(run.importId).toBe(IMPORT)

    said.length = 0
    await sendJob(run, io)
    // Started already; the failed batch and the rest, each after a drop.
    expect(said).toEqual([
      'drop',
      'send c2',
      'landed 2',
      'drop',
      'send c3',
      'landed 3',
    ])
    expect(run.landed).toBe(4)
  })

  it('a list warmed again mid-import is gone again before the next batch', async () => {
    const queryClient = new QueryClient()
    const lists = [rq.clients(BUSINESS), rq.properties(BUSINESS)]
    // What a preload leaves: the whole list in the cache, watched by no
    // one, and so still subscribed.
    const warm = () => {
      for (const { queryKey } of lists) queryClient.setQueryData(queryKey, [])
    }
    const cached = () =>
      lists.filter(
        ({ queryKey }) =>
          queryClient.getQueryCache().find({ queryKey, exact: true }) !==
          undefined,
      ).length

    warm()
    const atSend: Array<number> = []
    await sendJob(job(3), {
      start: async () => IMPORT,
      addBatch: async (_, clients) => {
        atSend.push(cached())
        // ‹ Clients touched, or the sidebar hovered, while this batch was
        // on its way.
        warm()
        return resultOf(clients)
      },
      beforeBatch: () => dropIdleClientLists(queryClient, BUSINESS),
      started: () => {},
      landed: () => {},
      stopped: () => false,
    })
    expect(atSend).toEqual([0, 0, 0])
  })

  it('stops between batches once the page has gone', async () => {
    let gone = false
    const sent: Array<string> = []
    const run = job(3)
    await sendJob(run, {
      start: async () => IMPORT,
      addBatch: async (_, clients) => {
        sent.push(clients[0].key)
        gone = true
        return resultOf(clients)
      },
      beforeBatch: () => {},
      started: () => {},
      landed: () => {},
      stopped: () => gone,
    })
    expect(sent).toEqual(['c0'])
    expect(run.landed).toBe(1)
  })
})

describe('refusedBeforeStart', () => {
  const failed = (over: Partial<RunState>): RunState => ({
    status: 'failed',
    importId: null,
    sent: 0,
    total: 3,
    results: [],
    error: new ConvexError('UNDO_IN_PROGRESS'),
    retryable: true,
    ...over,
  })

  it('sends the page back to its review when an undo stops the start', () => {
    expect(refusedBeforeStart(failed({}))).toBe(true)
  })

  it('leaves a batch turned down part-way to Try again', () => {
    // Started, so what landed stays, and the rest waits for the undo.
    expect(refusedBeforeStart(failed({ importId: IMPORT, sent: 1 }))).toBe(
      false,
    )
    expect(refusedBeforeStart(failed({ importId: IMPORT }))).toBe(false)
  })

  it('is only for that refusal, and only once it has failed', () => {
    expect(
      refusedBeforeStart(failed({ error: new ConvexError('NO_ACCESS') })),
    ).toBe(false)
    expect(refusedBeforeStart(failed({ error: new Error('offline') }))).toBe(
      false,
    )
    expect(refusedBeforeStart(failed({ status: 'running', error: null }))).toBe(
      false,
    )
  })
})
