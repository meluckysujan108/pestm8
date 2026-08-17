import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Switch } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

export type Member = {
  _id: Id<'memberships'>
  name: string
  email: string
  role: 'owner' | 'subcontractor'
  canViewAllJobs: boolean
  licenceNumber?: string
  colour: string
  status: string
}

export function MemberAccessRow({
  businessId,
  member,
}: {
  businessId: Id<'businesses'>
  member: Member
}) {
  const convexSet = useConvexMutation(api.memberships.setCanViewAllJobs)
  const setAccess = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      canViewAllJobs: boolean
    }) => convexSet(args),
  })

  const isOwner = member.role === 'owner'

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: member.colour }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-row-title text-ink">
            {member.name || member.email || 'Team member'}
          </p>
          <p className="truncate text-secondary capitalize text-muted">
            {member.role}
            {member.licenceNumber ? ` · Licence ${member.licenceNumber}` : ''}
          </p>
        </div>
      </div>

      {/* Owners already see everything, so offering the toggle would imply it
          could be turned off. */}
      {!isOwner && (
        <label className="mt-3 flex items-start justify-between gap-3 border-t border-hairline-2 pt-3">
          <span className="min-w-0">
            <span className="block text-body text-ink">Can view all jobs</span>
            <span className="block text-secondary text-muted">
              Read-only visibility of the whole schedule and property history.
              Never the right to edit someone else's booking.
            </span>
          </span>
          <Switch.Root
            checked={member.canViewAllJobs}
            disabled={setAccess.isPending}
            onCheckedChange={(checked) =>
              setAccess.mutate({
                businessId,
                membershipId: member._id,
                canViewAllJobs: checked,
              })
            }
            className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full bg-fill-track transition data-[state=checked]:bg-green disabled:opacity-50"
          >
            <Switch.Thumb className="block size-[27px] translate-x-0.5 rounded-full bg-white shadow-elevation transition-transform will-change-transform data-[state=checked]:translate-x-[22px]" />
          </Switch.Root>
        </label>
      )}
    </div>
  )
}
