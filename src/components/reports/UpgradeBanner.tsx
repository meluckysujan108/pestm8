import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { RefreshCw } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { restartingReports } from '#/lib/restartingReports'
import type { Id } from '../../../convex/_generated/dataModel'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'

/**
 * Shown on a draft started against wording the business no longer issues.
 *
 * An offer, never a block: a technician mid-job on an old draft can still
 * finish it. The Service Report's questions kept their places, so its answers
 * carry across in one tap. The Timber and Certificate forms were rebuilt
 * question by question, so the honest option there is a fresh draft — and the
 * copy says that before the tap, not after.
 */
export function UpgradeBanner({
  businessId,
  reportId,
  upgrade,
  beforeSwitch,
  onRestarted,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  upgrade: 'switch' | 'restart'
  /**
   * Saves any unsaved answers and reports whether the server now holds them,
   * so the switch works on what is on screen and never on an older copy.
   */
  beforeSwitch: () => Promise<boolean>
  onRestarted: (newReportId: Id<'reports'>) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const switchVersion = useConvexMutation(api.reports.switchTemplateVersion)
  const restart = useConvexMutation(api.reports.restartDraft)

  const switching = upgrade === 'switch'

  async function confirm() {
    setBusy(true)
    setFailed(false)
    try {
      if (!(await beforeSwitch())) {
        // Switching now would migrate the server's older copy and the latest
        // answers would be lost when the form re-opens. Stop and say so.
        setFailed(true)
        return
      }
      if (switching) {
        // The report re-renders on the new form by itself once its revision
        // changes; nothing to navigate to.
        await switchVersion({ businessId, reportId })
      } else {
        restartingReports.add(reportId)
        try {
          onRestarted(await restart({ businessId, reportId, suggestions: true }))
        } finally {
          // Cleared once the page has moved on; a failed restart leaves the
          // draft exactly where it was.
          setTimeout(() => restartingReports.delete(reportId), 5000)
        }
      }
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div
        role="status"
        className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-line bg-amber-bg px-3.5 py-3"
      >
        <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-ink" />
        <div className="flex-1">
          <p className="text-body font-semibold text-amber-ink">
            {switching
              ? 'This form has been updated'
              : 'This form was rebuilt'}
          </p>
          <p className="mt-0.5 text-caption text-amber-ink">
            {switching
              ? 'Switch to use the wording your business now issues. Your answers carry across.'
              : 'The questions changed, so answers cannot carry across. Start again on the new form.'}
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            // --amber-ink is warning *text*, so it inverts between themes: a
            // dark orange on a pale well in light, a bright one on a dark
            // well in dark. White would be unreadable on the second.
            className="mt-2 h-11 rounded-xl bg-amber-ink px-4 text-body font-semibold text-canvas outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.975]"
          >
            {switching ? 'Switch to the new form' : 'Start again'}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={switching ? 'Switch to the new form?' : 'Start again on the new form?'}
        body={
          <>
            {switching
              ? 'Your answers and photos carry across, re-worded to match the new options. Any signatures were given against the old wording, so they will need to be signed again.'
              : 'A new, empty draft opens for the same property and job. This draft is removed from your list; its photos are kept, not deleted.'}
          </>
        }
        cancel="Keep this version"
        confirm={switching ? 'Switch' : 'Start again'}
        pending={busy}
        error={failed ? "That didn’t go through. Check your signal and try again." : undefined}
        closeOnConfirm={false}
        onConfirm={confirm}
      />
    </>
  )
}
