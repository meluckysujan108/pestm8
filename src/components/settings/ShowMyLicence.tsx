import { useState } from 'react'
import { IdCard } from 'lucide-react'
import { useHydrated } from '#/lib/useHydrated'
import { useMyLicence } from './useMyLicence'
import { LicenceViewer } from './LicenceViewer'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The hub's "Show my licence": opens the signed-in person's own licence
 * document in the viewer, for the inspector on site who asks to see it, one
 * tap from Settings rather than two.
 *
 * Never suspends: it reads the licence the way the Licence page's tile does
 * (`useMyLicence`), so with no signal the copy kept on this phone stands in
 * after a few seconds — the moment this button is for. Renders nothing while
 * there is nothing to show: no document, or none known yet.
 *
 * No Replace in the viewer from here. Replacing belongs on the Licence page,
 * which has the picker, its checks and its error messages.
 */
export function ShowMyLicenceButton({
  businessId,
  membershipId,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
}) {
  const { shown } = useMyLicence(businessId, membershipId)
  const hydrated = useHydrated()
  const [open, setOpen] = useState(false)

  if (!shown) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!hydrated}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
      >
        <IdCard
          aria-hidden
          size={19}
          strokeWidth={1.8}
          className="shrink-0 text-blue"
        />
        Show my licence
      </button>
      {open && (
        <LicenceViewer
          businessId={businessId}
          membershipId={membershipId}
          licence={shown}
          title="Your licence"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
