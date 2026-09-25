import { useLayoutEffect, useMemo, useRef } from 'react'
import { useConvexAction } from '@convex-dev/react-query'
import { ViewerHost } from '#/components/pdf/host/ViewerHost'
import { api } from '../../../convex/_generated/api'
import { draftPreviewSource } from './reportPdfSources'
import type { ViewerActions } from '#/components/pdf/types'
import type { Id } from '../../../convex/_generated/dataModel'

/** Said under the top bar for as long as the preview is open. */
export const DRAFT_BADGE = 'Draft — not the finished document'

/**
 * Nothing leaves the app from a preview: no Share, no Save. A draft is not a
 * document anyone should be holding — the watermark says so on paper, and
 * this makes sure there is no paper.
 */
const NO_ACTIONS: ViewerActions = {}

/**
 * A draft's watermarked preview, in the app's own viewer — read before it is
 * locked, without leaving the app.
 *
 * It used to open in a new browser tab. From the installed app on an iPhone
 * that is Safari taking over the screen, with no way back into the report but
 * the app switcher — mid-way through finalising a job, in a roof void.
 *
 * View only: no Share or Save (above), no marks (a draft has nothing to mark
 * that its own form cannot say), and no remembered reading position — each
 * opening is a new drawing of the answers as they are then, and its key would
 * only push real documents out of the remembered list.
 */
export function DraftPreviewViewer({
  nonce,
  businessId,
  reportId,
  title,
  fileName,
  flush,
  onClose,
  onRefused,
}: {
  /** New for every opening: the preview is of the answers at that moment. */
  nonce: number
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  title: string
  fileName: string
  /** Saves the answers on screen first; false when that failed. */
  flush: () => Promise<boolean>
  onClose: () => void
  /**
   * The preview could not be drawn for a reason that is not the signal — the
   * report was locked meanwhile, the answers would not save — said in plain
   * words. The viewer's own error screen would call it a bad connection, so
   * the page closes the viewer and says it where the preview was asked for.
   */
  onRefused: (words: string) => void
}) {
  const render = useConvexAction(api.reportPdf.preview)
  // Read when the viewer loads, which outlives the render that opened it.
  const latest = useRef({ flush, render, onRefused })
  useLayoutEffect(() => {
    latest.current = { flush, render, onRefused }
  })

  const source = useMemo(
    () =>
      draftPreviewSource(`draft-preview:${reportId}:${nonce}`, {
        flush: () => latest.current.flush(),
        render: () => latest.current.render({ businessId, reportId }),
        refused: (words) => latest.current.onRefused(words),
      }),
    [businessId, reportId, nonce],
  )

  return (
    <ViewerHost
      title={title}
      fileName={fileName}
      source={source}
      actions={NO_ACTIONS}
      badge={DRAFT_BADGE}
      rememberPosition={false}
      onClose={onClose}
    />
  )
}
