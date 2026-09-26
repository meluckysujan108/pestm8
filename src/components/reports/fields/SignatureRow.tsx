import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Check, PenLine } from 'lucide-react'
import { SignSheet } from './SignSheet'
import { api } from '../../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../../convex/_generated/dataModel'
import { SECONDARY_BUTTON } from '#/components/primitives/buttons'

/**
 * A signature in the form: what was signed, or the way to sign it.
 *
 * The pad itself lives in a sheet — see `SignSheet` for why — so what stays on
 * the form is the evidence: the signature as an image once there is one, and
 * one button when there is not.
 */
export function SignatureRow({
  businessId,
  reportId,
  slot,
  label,
  statement,
  askName,
  ownSignature,
  signedAt,
  onSigned,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slot: string
  label: string
  statement?: string
  askName?: boolean
  ownSignature: boolean
  signedAt?: number
  onSigned: (signedAt: number | undefined) => void
}) {
  const [signing, setSigning] = useState(false)
  const hydrated = useHydrated()

  const { data: urls } = useQuery(
    convexQuery(api.reports.signatureUrls, { businessId, reportId }),
  )
  const existing = urls?.[slot]

  return (
    <span className="flex flex-col gap-2">
      {existing && (
        <img
          src={existing}
          alt={`${label} — signed`}
          // Paper: a signature is dark ink on a transparent PNG.
          className="h-24 w-full rounded-xl border border-hairline bg-paper object-contain"
        />
      )}

      <button
        type="button"
        disabled={!hydrated}
        // Named by which signature it is: a form with a technician's and a
        // client's pad has two of these, and "Sign" alone says nothing about
        // whose name is going on the document.
        aria-label={
          existing ? `${label} — signed, sign again` : `${label} — sign`
        }
        onClick={() => setSigning(true)}
        className={`${SECONDARY_BUTTON} flex items-center justify-center gap-2`}
      >
        {existing ? (
          <>
            <Check size={16} strokeWidth={2.2} className="text-green" />
            Signed — sign again
          </>
        ) : (
          <>
            <PenLine size={16} strokeWidth={2} />
            Sign
          </>
        )}
      </button>

      <SignSheet
        open={signing}
        onClose={() => setSigning(false)}
        businessId={businessId}
        reportId={reportId}
        slot={slot}
        label={label}
        statement={statement}
        askName={askName}
        ownSignature={ownSignature}
        onSigned={onSigned}
      />

      {signedAt !== undefined && !existing && (
        // The answers say this was signed but storage has no image: a report
        // in this state cannot be finalised, and saying so beats a silent gap.
        <span role="alert" className="text-caption text-amber-ink">
          This signature did not save. Sign again before finalising.
        </span>
      )}
    </span>
  )
}
