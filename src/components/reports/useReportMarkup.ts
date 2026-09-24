import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { hasOwnMarks, strokesByPage } from './reportPdfModel'
import { createMarkupQueue } from './markupQueue'
import type { MarkupStroke, ViewerMarkup } from '#/components/pdf/types'
import type { AnnotationRow } from './reportPdfModel'
import type { MarkupQueue } from './markupQueue'
import type { Id } from '../../../convex/_generated/dataModel'

/** The user's words (2026-09-24), said in the markup palette. */
export const MARKUP_NOTE =
  'Marks are for your team. Share sends the report without them.'
/** Said once when a report with marks is shared or saved. */
export const MARKUP_SHARE_NOTE =
  'Sent without the marks — they stay in the app for your team.'

const NO_STROKES: ReadonlyMap<number, ReadonlyArray<MarkupStroke>> = new Map()

/**
 * A report's marks, as the viewer's markup layer (`ViewerMarkup`): every
 * stroke on every page from one subscription, and the pen that adds to them.
 *
 * ── Who sees the pen ──────────────────────────────────────────────────────
 *
 * Marks are read and written as the REAL person (`reportAnnotations.ts`),
 * which is narrower than the report itself: someone looking through another
 * account can open the report but has no pen in it, and the query refuses
 * them. Undefined then — no marks and no pen — and undefined while the marks
 * are still on their way, so the pen never appears before the marks it would
 * draw over, and never as a tool that fails on its first stroke.
 *
 * ── Nothing here is optimistic ────────────────────────────────────────────
 *
 * The viewer keeps a stroke on screen while it saves; this only saves it. A
 * mark is the server's once the mutation resolves — Convex resolves it after
 * this client's queries have caught up with it — so `strokes` then includes
 * it and the viewer lets its own copy go.
 *
 * Saves, Undo and Clear go through one queue (`markupQueue.ts`), so they
 * reach the server in the order they were tapped and each Undo picks its
 * mark only after everything before it has landed. "Undo" straight after a
 * stroke means that stroke, and two quick Undos take your two newest marks —
 * not the newest one and then an older one on the same page.
 */
export function useReportMarkup({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}): ViewerMarkup | undefined {
  const queryClient = useQueryClient()
  const list = useMemo(
    () =>
      convexQuery(api.reportAnnotations.listForReport, {
        businessId,
        reportId,
      }),
    [businessId, reportId],
  )
  const { data, isError } = useQuery({
    ...list,
    // A refusal is the answer (someone with no pen here), not a blip: a
    // Convex query waits out a lost connection rather than failing, so a
    // retry would only keep the pen hidden for longer before deciding.
    retry: false,
  })

  const add = useConvexMutation(api.reportAnnotations.addStroke)
  const undoLast = useConvexMutation(api.reportAnnotations.undoLastStroke)
  const clearMine = useConvexMutation(api.reportAnnotations.clearMyStrokes)
  const latest = useRef({ add, undoLast, clearMine, data })
  useLayoutEffect(() => {
    latest.current = { add, undoLast, clearMine, data }
  })

  // How many strokes are on their way: state, so that a first stroke still
  // saving already offers Undo.
  const [savingCount, setSavingCount] = useState(0)

  // One queue per report, made once and kept: it holds the order of what has
  // been asked for, and a fresh one would forget an Undo still waiting. Made
  // again (during render, as React allows for state derived from props) only
  // if this hook is handed another report.
  const reportKey = `${businessId}/${reportId}`
  const makeQueue = (): { key: string; queue: MarkupQueue } => ({
    key: reportKey,
    queue: createMarkupQueue(
      {
        // The marks as they stand now: the cache, which a mutation that has
        // come back has already updated, rather than a render that may not
        // have happened yet.
        rows: () =>
          queryClient.getQueryData<Array<AnnotationRow>>(list.queryKey) ??
          latest.current.data ??
          [],
        add: (page, points) =>
          latest.current.add({ businessId, reportId, page, points }),
        undoLast: (page) =>
          latest.current.undoLast({ businessId, reportId, page }),
        clearMine: (page) =>
          latest.current.clearMine({ businessId, reportId, page }),
      },
      setSavingCount,
    ),
  })
  const [held, setHeld] = useState(makeQueue)
  if (held.key !== reportKey) setHeld(makeQueue())
  const { addStroke, undo, clearPage } = held.queue

  // A new Map only when the marks change: the viewer memoises its page
  // slots on it.
  const strokes = useMemo(
    () => (data ? strokesByPage(data) : NO_STROKES),
    [data],
  )
  // Only your own marks are yours to take back. A report marked only by
  // colleagues offers no Undo — the old canvas left it enabled there, and it
  // then did nothing.
  const canUndo = (data !== undefined && hasOwnMarks(data)) || savingCount > 0

  return useMemo(() => {
    if (isError || data === undefined) return undefined
    return {
      strokes,
      canDraw: true,
      addStroke,
      undo: canUndo ? undo : null,
      clearPage,
      note: MARKUP_NOTE,
      shareNote: MARKUP_SHARE_NOTE,
    }
  }, [isError, data, strokes, addStroke, canUndo, undo, clearPage])
}
