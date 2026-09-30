import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { describeError } from '#/components/forms/describeError'
import { leavingReports } from '#/lib/leavingReports'
import { deleteWords } from './deleteWords'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import type { DeletableReport } from './deleteWords'

/**
 * Moving a report to Deleted: its trigger, the confirm, and the mutation.
 *
 * The Reports list's rows draw a bin on each report; a finalised report's own
 * page draws "Delete report" at its foot. Both ask the same question in the
 * same words (`deleteWords`), so a report is never deleted from one place on
 * terms the other would not state.
 *
 * `leavesPage`: the report being deleted is the page on screen. Its live
 * query turns null as the delete lands, a moment before `onDeleted` moves on,
 * so the page is told it is being left (`leavingReports`) rather than showing
 * Not Found in between.
 */
export function DeleteReport({
  businessId,
  reportId,
  report,
  leavesPage = false,
  onDeleted,
  trigger,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  report: DeletableReport
  leavesPage?: boolean
  onDeleted?: () => void
  /** The control that asks; `open` shows the confirm. */
  trigger: (open: () => void) => ReactNode
}) {
  const [confirming, setConfirming] = useState(false)
  const words = deleteWords(report)
  const convexDelete = useConvexMutation(api.reports.softDelete)
  const remove = useMutation({
    mutationFn: async (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
    }) => {
      if (leavesPage) leavingReports.add(args.reportId)
      return convexDelete(args)
    },
    onSuccess: (_result, args) => {
      setConfirming(false)
      onDeleted?.()
      // Cleared once the page has moved on.
      if (leavesPage) {
        setTimeout(() => leavingReports.delete(args.reportId), 5000)
      }
    },
    onError: (_error, args) => {
      // Still here, so the page may show it again.
      leavingReports.delete(args.reportId)
    },
  })

  return (
    <>
      {trigger(() => {
        remove.reset()
        setConfirming(true)
      })}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={words.title}
        body={
          <>
            {words.body}
            {words.caution && (
              <span className="mt-2 block">{words.caution}</span>
            )}
          </>
        }
        confirm={words.confirm}
        cancel={words.cancel}
        closeOnConfirm={false}
        pending={remove.isPending}
        pendingLabel="Deleting…"
        error={
          remove.isError ? describeError(remove.error, words.failed) : null
        }
        onConfirm={() => remove.mutate({ businessId, reportId })}
      />
    </>
  )
}
