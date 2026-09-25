import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { LicenceViewer } from './LicenceViewer'
import { ROW_CLASS, RowBody } from './ui'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * "View licence" on a member's page (Phase 8.1), a row of its Licence group:
 * the owner opens a member's licence document, read-only, inside the app — no
 * Share, no Save, no Replace, and no copy kept on the owner's phone
 * (`licenceSource.ts`).
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
  const hydrated = useHydrated()
  const [open, setOpen] = useState(false)
  const licence = useQuery({
    ...rq.licenceFile(businessId, membershipId),
    enabled: open,
  })

  const failed = open && licence.isError
  const removed = open && licence.data === null

  // One element, so the group's hairlines fall above and below the row and
  // whatever it says under itself, not between them.
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          if (licence.isError) void licence.refetch()
        }}
        // Before hydration a tap has no handler and is lost.
        disabled={!hydrated || (open && licence.isPending)}
        className={`${ROW_CLASS} disabled:opacity-50`}
      >
        <RowBody
          icon={FileText}
          tint="blue"
          title={open && licence.isPending ? 'Opening…' : 'View licence'}
          chevron
        />
      </button>
      {(failed || removed) && (
        <div className="px-3.5 pb-3">
          {failed && (
            <FormAlert
              error={licence.error}
              copy={{ default: 'Could not open this licence. Try again.' }}
            />
          )}
          {removed && (
            <p className="text-caption text-muted">
              {name} has removed their licence document.
            </p>
          )}
        </div>
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
    </div>
  )
}
