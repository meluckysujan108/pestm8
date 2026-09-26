import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { errorCode } from '#/components/forms/describeError'
import { dropIdleClientLists } from './queries'
import { sendBatches, toBatches } from './run'
import type {
  ImportClient,
  ImportResult,
} from '../../../../convex/lib/clientImport'
import type { Id } from '../../../../convex/_generated/dataModel'

export type RunState = {
  status: 'idle' | 'running' | 'failed' | 'done'
  importId: Id<'clientImports'> | null
  /** Clients the server has answered for, and how many there are to send. */
  sent: number
  total: number
  /** What the server said about each client sent, in the order sent. */
  results: Array<ImportResult>
  error: unknown
  /** False for a refusal that trying again cannot change. */
  retryable: boolean
}

const IDLE: RunState = {
  status: 'idle',
  importId: null,
  sent: 0,
  total: 0,
  results: [],
  error: null,
  retryable: true,
}

/**
 * Refusals that are the same the second time: the import was undone from
 * another screen, or this person may no longer import. Anything else — no
 * signal, a server that timed out, another import's undo still running
 * (`UNDO_IN_PROGRESS`) — is worth another go.
 */
const FINAL = new Set([
  'IMPORT_UNDONE',
  'NO_ACCESS',
  'NOT_FOUND',
  'BATCH_TOO_LARGE',
])

/**
 * An import turned down at its start because an undo of the business's was
 * running (`UNDO_IN_PROGRESS`): nothing was opened and nothing sent. The
 * review it would have sent was built against PestM8 as it was before that
 * undo — what it calls already here may be going — so the page goes back to
 * it, to wait for the undo and read PestM8 again, rather than offering Try
 * again on it. A batch turned down part-way is different: what landed
 * stays, and Try again carries on once the undo is done.
 */
export function refusedBeforeStart(state: RunState): boolean {
  return (
    state.status === 'failed' &&
    state.importId === null &&
    errorCode(state.error) === 'UNDO_IN_PROGRESS'
  )
}

export type Job = {
  batches: Array<Array<ImportClient>>
  /** The first batch the server hasn't confirmed. */
  landed: number
  importId: Id<'clientImports'> | null
  fileName: string
  source: string | null
}

/**
 * One go at a job, apart from React so it can be tested without a screen:
 * `start` if it hasn't been, then every batch not yet confirmed, in order.
 * `job` is kept up to date as it goes — its id once started, and `landed`
 * after each batch — so the next go (Try again) picks up where this one
 * stopped. A failure is thrown as it came.
 *
 * `beforeBatch` runs before every batch, not once at the start: it is what
 * lets go of the idle client lists (`dropIdleClientLists`), and a link
 * hovered or touched mid-import — ‹ Clients, the sidebar, Schedule — warms
 * them again, after which each batch would wait on both being sent down
 * whole.
 */
export async function sendJob(
  job: Job,
  io: {
    start: (meta: {
      fileName: string
      source: string | null
    }) => Promise<Id<'clientImports'>>
    addBatch: (
      importId: Id<'clientImports'>,
      clients: Array<ImportClient>,
    ) => Promise<Array<ImportResult>>
    beforeBatch: () => void
    started: (importId: Id<'clientImports'>) => void
    landed: (index: number, results: Array<ImportResult>) => void
    stopped: () => boolean
  },
): Promise<void> {
  if (job.importId === null) {
    job.importId = await io.start({
      fileName: job.fileName,
      source: job.source,
    })
    io.started(job.importId)
  }
  const importId = job.importId
  job.landed = await sendBatches(
    job.batches,
    job.landed,
    (clients) => {
      io.beforeBatch()
      return io.addBatch(importId, clients)
    },
    (index, results) => {
      job.landed = index + 1
      io.landed(index, results)
    },
    io.stopped,
  )
}

/**
 * Sends an import: `start` once, then the clients in batches, one after
 * another (`sendBatches`), with the page told after each. A failure stops it
 * where it was; `retry` carries on from the first batch not yet confirmed,
 * so nothing is ever sent twice.
 *
 * Leaving the page stops it after the batch in flight: what landed stays,
 * and Recent imports has it, with Undo.
 */
export function useImportRun(businessId: Id<'businesses'>) {
  const queryClient = useQueryClient()
  const start = useConvexMutation(api.clientImports.start)
  const addBatch = useConvexMutation(api.clientImports.addBatch)
  const [state, setState] = useState<RunState>(IDLE)
  const job = useRef<Job | null>(null)
  const busy = useRef(false)
  const gone = useRef(false)

  useEffect(() => {
    gone.current = false
    return () => {
      gone.current = true
    }
  }, [])

  const go = useCallback(async () => {
    const current = job.current
    // One run at a time: a second tap on Try again must not send the same
    // batch alongside the first.
    if (!current || busy.current) return
    busy.current = true
    setState((s) => ({ ...s, status: 'running', error: null }))
    try {
      await sendJob(current, {
        start: ({ fileName, source }) =>
          start({ businessId, fileName, ...(source ? { source } : {}) }),
        addBatch: (importId, clients) =>
          addBatch({ businessId, importId, clients }),
        beforeBatch: () => dropIdleClientLists(queryClient, businessId),
        started: (importId) => setState((s) => ({ ...s, importId })),
        landed: (index, results) => {
          const size = current.batches[index].length
          setState((s) => ({
            ...s,
            sent: s.sent + size,
            results: [...s.results, ...results],
          }))
        },
        stopped: () => gone.current,
      })
      if (current.landed === current.batches.length) {
        setState((s) => ({ ...s, status: 'done' }))
      }
    } catch (error) {
      const code = errorCode(error)
      setState((s) => ({
        ...s,
        status: 'failed',
        error,
        retryable: code === null || !FINAL.has(code),
      }))
    } finally {
      busy.current = false
    }
  }, [addBatch, businessId, queryClient, start])

  const begin = useCallback(
    (
      clients: Array<ImportClient>,
      meta: { fileName: string; source: string | null },
    ) => {
      if (busy.current) return
      job.current = {
        batches: toBatches(clients),
        landed: 0,
        importId: null,
        ...meta,
      }
      setState({ ...IDLE, status: 'running', total: clients.length })
      void go()
    },
    [go],
  )

  /** Settles for what landed: the Done screen, without the rest. */
  const finish = useCallback(
    () => setState((s) => ({ ...s, status: 'done' })),
    [],
  )

  const reset = useCallback(() => {
    job.current = null
    setState(IDLE)
  }, [])

  return { state, begin, retry: go, finish, reset }
}
