import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { rq } from '#/lib/routeQueries'
import { LicenceViewer } from './LicenceViewer'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * "View licence" on a Team row (Phase 8.1): the owner opens a member's licence
 * document, read-only, inside the app — no Share, no Save, no Replace, and no
 * copy kept on the owner's phone (`licenceSource.ts`).
 *
 * Shown only where the roster says there is one this viewer may open
 * (`team.roster`'s `hasLicenceFile`, true for the owner alone). The document
 * itself is asked for on the tap, not with the roster: a team of twenty is
 * not twenty signed URLs nobody asked for.
 */
export function MemberLicenceButton({
  businessId,
  membershipId,
  name,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  name: string
}) {
  const [open, setOpen] = useState(false)
  const licence = useQuery({
    ...rq.licenceFile(businessId, membershipId),
    enabled: open,
  })

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          if (licence.isError) void licence.refetch()
        }}
        disabled={open && licence.isPending}
        className="flex h-11 items-center gap-1.5 rounded-xl bg-surface-2 px-3 text-body font-semibold text-blue transition active:scale-[.975] disabled:opacity-50"
      >
        <FileText aria-hidden size={16} strokeWidth={1.8} />
        {open && licence.isPending ? 'Opening…' : 'View licence'}
      </button>
      {open && licence.isError && (
        <FormAlert
          error={licence.error}
          copy={{ default: 'Could not open this licence. Try again.' }}
          className="mt-2 w-full"
        />
      )}
      {open && licence.data === null && (
        <p className="mt-2 w-full text-caption text-muted">
          {name} has removed their licence document.
        </p>
      )}
      {open && licence.data && (
        <LicenceViewer
          businessId={businessId}
          membershipId={membershipId}
          licence={licence.data}
          title={`${name}’s licence`}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
