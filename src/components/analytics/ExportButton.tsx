import { useState } from 'react'
import { Download } from 'lucide-react'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { analyticsCsv, analyticsCsvName } from '#/lib/analyticsCsv'
import { saveTextFile } from '#/lib/saveFile'
import type { AnalyticsBreakdown } from '#/components/analytics/AnalyticsBreakdowns'
import type { AnalyticsReport } from '#/components/analytics/AnalyticsOverview'
import type { AnalyticsPayments } from '#/components/analytics/PaidCard'

/**
 * The page's figures as a spreadsheet (`analyticsCsv`): the range on screen,
 * with whatever filters are on. On a phone it opens the share sheet; with a
 * mouse it downloads. Made on the device from what is already loaded, so it
 * needs no signal.
 */
export function ExportButton({
  report,
  breakdown,
  paid,
  disabled = false,
}: {
  report: AnalyticsReport | undefined
  breakdown: AnalyticsBreakdown | undefined
  paid?: AnalyticsPayments
  /** Until the page hydrates. */
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle')

  return (
    <div>
      <button
        type="button"
        disabled={disabled || !report || state === 'working'}
        onClick={() => {
          if (!report) return
          setState('working')
          saveTextFile(
            analyticsCsvName(report),
            analyticsCsv(report, breakdown, paid),
          )
            .then(() => setState('idle'))
            .catch(() => setState('failed'))
        }}
        className={`${LINK_BUTTON_COMPACT} w-full`}
      >
        <span className="inline-flex items-center justify-center gap-2">
          <Download size={15} strokeWidth={2} aria-hidden />
          {state === 'working' ? 'Exporting…' : 'Export as a spreadsheet'}
        </span>
      </button>
      {state === 'failed' && (
        <p role="alert" className="mt-2 text-caption text-amber-ink">
          Could not export the figures. Try again.
        </p>
      )}
    </div>
  )
}
