import { useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { useConvexMutation } from '@convex-dev/react-query'
import { RefreshCw } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { restartingReports } from '#/lib/restartingReports'
import type { Id } from '../../../convex/_generated/dataModel'

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
          onRestarted(await restart({ businessId, reportId }))
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
            className="mt-2 h-9 rounded-xl bg-amber-ink px-3 text-[14px] font-semibold text-white transition active:scale-[.975]"
          >
            {switching ? 'Switch to the new form' : 'Start again'}
          </button>
        </div>
      </div>

      <AlertDialog.Root open={open} onOpenChange={setOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-canvas p-4 shadow-elevation outline-none">
            <AlertDialog.Title className="text-row-title text-ink">
              {switching ? 'Switch to the new form?' : 'Start again on the new form?'}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-body text-ink-2">
              {switching
                ? 'Your answers and photos carry across, re-worded to match the new options. Any signatures were given against the old wording, so they will need to be signed again.'
                : 'A new, empty draft opens for the same property and job. This draft is removed from your list; its photos are kept, not deleted.'}
            </AlertDialog.Description>
            {failed && (
              <p role="alert" className="mt-2 text-caption text-red">
                That didn't go through. Check your connection and try again.
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.975]"
                >
                  Not now
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                disabled={busy}
                onClick={confirm}
                className="h-11 flex-1 rounded-xl bg-red text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
              >
                {switching ? 'Switch' : 'Start again'}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  )
}
