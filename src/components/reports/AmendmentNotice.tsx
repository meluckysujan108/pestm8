import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useLayoutEffect, useState } from 'react'
import { ConvexError } from 'convex/values'
import { FilePenLine, History } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { Sheet, SheetLock } from '#/components/primitives/Sheet'
import type { Id } from '../../../convex/_generated/dataModel'
import { PRIMARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { FIELD_SURFACE } from '#/components/forms/FormField'

/**
 * What a client holding two documents with the same number is owed.
 *
 * A finalised report is never edited, so a correction is a new document at the
 * next version of the same number. Both ends of that pair have to say so on
 * screen: the one that was replaced, so nobody works from it, and the one that
 * replaced it, so its reason is attached to it rather than kept in an audit
 * log nobody reads.
 */
export function AmendmentNotice({
  businessSlug,
  supersededBy,
  supersedes,
  reason,
  reportNumber,
  version,
  className = 'px-4 pt-4',
}: {
  businessSlug: string
  supersededBy?: Id<'reports'>
  supersedes?: Id<'reports'>
  reason?: string
  reportNumber?: number
  version?: number
  className?: string
}) {
  const navigate = useNavigate()
  if (!supersededBy && !supersedes) return null

  const numbered = numberedAs(reportNumber)

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {supersededBy && (
        <ReplacedNotice
          businessSlug={businessSlug}
          supersededBy={supersededBy}
          reportNumber={reportNumber}
        />
      )}

      {supersedes && (
        <div className="flex items-start gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2.5">
          <FilePenLine
            size={16}
            strokeWidth={2}
            className="mt-0.5 shrink-0 text-blue"
          />
          <p className="min-w-0 flex-1 text-caption text-ink-2">
            <span className="font-semibold text-ink">
              Version {version ?? 2} of {numbered}.
            </span>{' '}
            {reason ? `Reissued because: ${reason}` : 'Reissued.'}{' '}
            <button
              type="button"
              onClick={() =>
                void navigate({
                  to: '/$businessSlug/reports/$reportId',
                  params: { businessSlug, reportId: supersedes },
                })
              }
              className="relative tap-target font-semibold text-blue underline"
            >
              See what it replaced
            </button>
          </p>
        </div>
      )}
    </div>
  )
}

function numberedAs(reportNumber: number | undefined): string {
  return reportNumber !== undefined ? `#${reportNumber}` : 'this report'
}

/**
 * The replaced end of the pair: this document is no longer the current one,
 * and the way to the one that is. At the top of its page, and in the viewer's
 * badge, so nobody reads, shares or marks up the old document without being
 * told.
 */
export function ReplacedNotice({
  businessSlug,
  supersededBy,
  reportNumber,
}: {
  businessSlug: string
  supersededBy: Id<'reports'>
  reportNumber?: number
}) {
  const navigate = useNavigate()
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5">
      <History
        size={16}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-amber-ink"
      />
      <p className="min-w-0 flex-1 text-caption text-amber-ink">
        <span className="font-semibold">Replaced.</span> A later version of{' '}
        {numberedAs(reportNumber)} has been issued. This document is kept
        because the client was sent it.{' '}
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: '/$businessSlug/reports/$reportId',
              params: { businessSlug, reportId: supersededBy },
            })
          }
          className="relative tap-target font-semibold underline"
        >
          Open the current version
        </button>
      </p>
    </div>
  )
}

/**
 * A correction has been started and not yet issued.
 *
 * The document it corrects is still the current one until then — the client
 * holds it, and the draft may yet be abandoned — so this says where the
 * correction is rather than calling the document replaced.
 */
export function CorrectionUnderWay({
  businessSlug,
  amendmentId,
}: {
  businessSlug: string
  amendmentId: Id<'reports'>
}) {
  const navigate = useNavigate()
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2.5">
      <FilePenLine
        size={16}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-blue"
      />
      <p className="min-w-0 flex-1 text-caption text-ink-2">
        <span className="font-semibold text-ink">
          A correction is under way.
        </span>{' '}
        This document stays current until it is issued.{' '}
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: '/$businessSlug/reports/$reportId',
              params: { businessSlug, reportId: amendmentId },
            })
          }
          className="relative tap-target font-semibold text-blue underline"
        >
          Open the correction
        </button>
      </p>
    </div>
  )
}

/**
 * Starting a correction: the sheet the finished report's "Issue a correction"
 * opens.
 *
 * The reason is required rather than optional: a client holding two documents
 * with the same number is owed the difference between them, and "amended" on
 * its own is not it.
 */
export function AmendSheet({
  open,
  onClose,
  businessId,
  businessSlug,
  reportId,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  businessSlug: string
  reportId: Id<'reports'>
}) {
  const [reason, setReason] = useState('')
  const navigate = useNavigate()

  const convexAmend = useConvexMutation(api.reports.amend)
  const amend = useMutation({
    mutationFn: () => convexAmend({ businessId, reportId, reason }),
    onSuccess: (newId: Id<'reports'>) => {
      onClose()
      void navigate({
        to: '/$businessSlug/reports/$reportId',
        params: { businessSlug, reportId: newId },
      })

      // Each opening starts empty: a reason thrown away with "Discard" must not
      // be waiting the next time, nor the last try's failure.
      const { reset } = amend
      useLayoutEffect(() => {
        if (!open) return
        setReason('')
        reset()
      }, [open, reset])
    },
  })

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Issue a correction"
      description="This document stays as it is. A new one is issued at the next version of the same number."
      footer={
        <button
          type="button"
          disabled={reason.trim() === '' || amend.isPending}
          onClick={() => amend.mutate()}
          className={`${PRIMARY_BUTTON_COMPACT} w-full`}
        >
          {amend.isPending ? 'Starting…' : 'Start the correction'}
        </button>
      }
    >
      {/* Something typed is not thrown away by a stray swipe. */}
      <SheetLock changed={reason.trim() !== ''} whileUnchanged={false} />
      <label className="flex flex-col gap-1.5">
        <span className="section-label">What was wrong?</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder="Wrong product recorded against the second treatment"
          aria-label="What was wrong?"
          className={`${FIELD_SURFACE} w-full p-3`}
        />
      </label>
      <p className="mt-2 text-caption text-muted">
        This prints on the corrected document. The client may be holding the old
        one, so it should say what changed.
      </p>

      {amend.isError && (
        <p role="alert" className="mt-3 text-caption text-amber-ink">
          {amendError(amend.error)}
        </p>
      )}
    </Sheet>
  )
}

function amendError(error: unknown): string {
  const code =
    error instanceof ConvexError && typeof error.data === 'string'
      ? error.data
      : null
  switch (code) {
    case 'AMENDMENT_IN_PROGRESS':
      return 'A correction of this document is already under way.'
    case 'ALREADY_SUPERSEDED':
      return 'This document has already been replaced.'
    case 'NO_ACCESS':
      return 'Only the person who signed this document, or the owner, can correct it.'
    default:
      return 'Could not start a correction. Check your signal and try again.'
  }
}
