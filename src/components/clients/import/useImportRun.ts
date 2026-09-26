import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { errorCode } from '#/components/forms/describeError'
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
 * signal, a server that timed out — is worth another go.
 */
const FINAL = new Set([
  'IMPORT_UNDONE',
  'NO_ACCESS',
  'NOT_FOUND',
  'BATCH_TOO_LARGE',
])

type Job = {
  batches: Array<Array<ImportClient>>
  /** The first batch the server hasn't confirmed. */
  landed: number
  importId: Id<'clientImports'> | null
  fileName: string
  source: string | null
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
      if (current.importId === null) {
        const importId = await start({
          businessId,
          fileName: current.fileName,
          ...(current.source ? { source: current.source } : {}),
        })
        current.importId = importId
        setState((s) => ({ ...s, importId }))
      }
      const importId = current.importId
      current.landed = await sendBatches(
        current.batches,
        current.landed,
        (clients) => addBatch({ businessId, importId, clients }),
        (index, results) => {
          current.landed = index + 1
          const size = current.batches[index].length
          setState((s) => ({
            ...s,
            sent: s.sent + size,
            results: [...s.results, ...results],
          }))
        },
        () => gone.current,
      )
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
  }, [addBatch, businessId, start])

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
