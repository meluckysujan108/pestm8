import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { useAccess, useCan } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import { DANGER_ROW_CLASS } from './ui'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * The owner's way back in for a technician who has lost their phone AND their
 * recovery codes (`team.resetTwoFactor`).
 *
 * Offered only to the owner, working as themselves — the server refuses
 * anyone else, and anyone inside someone else's account — and only on a
 * member who has two-step sign-in on (an older backend without `twoStepOn`
 * shows nothing).
 *
 * It asks first and says exactly what happens, because the consequence is
 * real in both directions: the person is signed out everywhere, and until
 * they turn it on again their password alone signs them in.
 * So: confirm it really is them before pressing it.
 *
 * A row of the member page's last group (`DangerGroup`), in red with Remove
 * from team: both take something away from the person, and both ask first.
 */
export function ResetTwoStepButton({
  businessId,
  membershipId,
  name,
  twoStepOn,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  name: string
  twoStepOn?: boolean
}) {
  // The server's rule, exactly (`team.resetTwoFactor`): `team.manage`, which
  // a switch drops, AND the real person is the owner — a contractor holds
  // `team.manage` for their own team.
  const canManage = useCan('team.manage')
  const isOwner = useAccess().role === 'owner'
  const [confirming, setConfirming] = useState(false)
  const hydrated = useHydrated()
  // What happens after the reset depends on it: where two-step sign-in is
  // compulsory (`AUTH_MFA_REQUIRED=on`) they are sent to set it up again at
  // their next sign-in; where it is optional, they are simply without it.
  const required =
    useQuery(convexQuery(api.auth.twoFactorStatus, {})).data?.required === true

  const convexReset = useConvexMutation(api.team.resetTwoFactor)
  const reset = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
    }) => convexReset(args),
    onSuccess: () => setConfirming(false),
  })

  if (!canManage || !isOwner) return null
  if (twoStepOn !== true) {
    return reset.isSuccess ? (
      <p role="status" className="px-3.5 py-3 text-caption text-muted">
        {required
          ? `Two-step sign-in reset. ${name} sets it up again at their next sign-in.`
          : `Two-step sign-in reset. ${name} signs in with just their password until they turn it on again in Settings.`}
      </p>
    ) : null
  }

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => setConfirming(true)}
        // A full-width row, 52 px tall: pressed in a driveway, with gloves on.
        className={DANGER_ROW_CLASS}
      >
        Reset two-step sign-in
      </button>
    )
  }

  return (
    <div className="px-3.5 py-3">
      <p className="text-body text-ink">Reset two-step sign-in for {name}?</p>
      <p className="mt-1 text-caption text-muted">
        For when they have lost their phone and their recovery codes. They are
        signed out on every device, their old authenticator and codes stop
        working, and{' '}
        {required
          ? 'at their next sign-in they set it up again on their new phone.'
          : 'they can turn it on again with their new phone from Settings.'}{' '}
        Their password is not changed or shown to you.
      </p>
      <p className="mt-2 text-caption text-amber-ink">
        Until they set it up again, their password alone gets into their
        account. Check it is really them asking — in person, or on a call to the
        number you know.
      </p>

      {reset.isError && (
        <FormAlert className="mt-2">{resetError(reset.error)}</FormAlert>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => {
            setConfirming(false)
            reset.reset()
          }}
          className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={reset.isPending}
          onClick={() => reset.mutate({ businessId, membershipId })}
          className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
        >
          {reset.isPending ? 'Resetting…' : 'Reset'}
        </button>
      </div>
    </div>
  )
}

function resetError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('MEMBER_OF_ANOTHER_BUSINESS')) {
    return 'They also work for another business on PestM8, so their sign-in is not yours alone to reset. Contact PestM8 support.'
  }
  if (message.includes('NOT_FOUND')) {
    return 'They are no longer an active member of this business.'
  }
  if (message.includes('NO_ACCESS')) {
    return 'Only the business owner, working as themselves, can do this.'
  }
  return 'Could not reset. Check your connection and try again.'
}
