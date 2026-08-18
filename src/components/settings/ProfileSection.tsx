import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { authClient } from '#/lib/auth-client'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'

/** Licence field labelling is state-based, so the label follows the tenant. */
const LICENCE_LABEL: Record<string, string> = {
  WA: 'Pest management technician licence',
  NSW: 'Pest management technician licence',
  QLD: 'Pest management technician licence (PMT)',
  VIC: 'Pest control licence',
  SA: 'Pest controller licence',
  TAS: 'Pest control operator licence',
  NT: 'Pest management technician licence',
  ACT: 'Pest management technician licence',
}

export function ProfileSection({
  businessId,
  membershipId,
  licenceNumber,
  state,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  licenceNumber?: string
  state: string
}) {
  const [licence, setLicence] = useState(licenceNumber ?? '')

  const hydrated = useHydrated()

  const convexSet = useConvexMutation(api.memberships.setLicence)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      licenceNumber: string
    }) => convexSet(args),
  })

  return (
    <>
      <h2 className="section-label mb-2">Your licence</h2>
      <form
        className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ businessId, membershipId, licenceNumber: licence })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">
            {LICENCE_LABEL[state] ?? 'Licence number'}
          </span>
          <input
            value={licence}
            onChange={(e) => setLicence(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>
        <p className="mt-2 text-caption text-muted">
          Printed on every report and certificate you finalise.
        </p>
        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="mt-3 h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save'}
        </button>
      </form>

      <button
        type="button"
        onClick={async () => {
          await authClient.signOut()
          // expectAuth requires a full reload so the client re-authenticates.
          window.location.href = '/login'
        }}
        className="mt-6 h-12 w-full rounded-xl bg-surface-2 text-[17px] font-semibold text-red transition active:scale-[.975]"
      >
        Sign out
      </button>
    </>
  )
}
