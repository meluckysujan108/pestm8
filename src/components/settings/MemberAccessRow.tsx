import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Switch } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Grants, Role } from '../../../convex/lib/capabilities'

export type Member = {
  _id: Id<'memberships'>
  name: string
  email: string
  role: Role
  grants: Grants
  canViewOtherAccounts: boolean
  canManage: boolean
  parentMembershipId?: Id<'memberships'> | null
  licenceNumber?: string
  colour: string
  status: string
}

export function MemberAccessRow({
  businessId,
  member,
  others = [],
}: {
  businessId: Id<'businesses'>
  member: Member
  /** Active members who could take over this person's booked work. */
  others?: Array<Member>
}) {
  const convexSetViewOthers = useConvexMutation(
    api.memberships.setCanViewOtherAccounts,
  )
  const setViewOthers = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      canViewOtherAccounts: boolean
    }) => convexSetViewOthers(args),
  })

  const convexSetRole = useConvexMutation(api.memberships.setRole)
  const setRole = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      role: 'subcontractor' | 'contractor'
    }) => convexSetRole(args),
  })

  const convexAssignTo = useConvexMutation(api.team.assignTo)
  const assignTo = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      parentMembershipId: Id<'memberships'> | null
    }) => convexAssignTo(args),
  })

  const contractors = others.filter(
    (m) => m.role === 'contractor' && m.status === 'active',
  )

  const convexSetGrants = useConvexMutation(api.memberships.setGrants)
  const setGrants = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      grants: Grants
    }) => convexSetGrants(args),
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
          <p className="truncate text-caption capitalize text-muted">
            {member.role}
            {member.licenceNumber ? ` · Licence ${member.licenceNumber}` : ''}
          </p>
        </div>
      </div>

      {!isOwner && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline-2 pt-3">
          <label className="flex items-center gap-2">
            <span className="text-caption text-muted">Role</span>
            <select
              value={member.role}
              disabled={setRole.isPending}
              onChange={(e) =>
                setRole.mutate({
                  businessId,
                  membershipId: member._id,
                  role: e.target.value as 'subcontractor' | 'contractor',
                })
              }
              className="h-9 rounded-xl bg-surface-3 px-2.5 text-body text-ink outline-none focus:ring-2 focus:ring-blue disabled:opacity-50"
            >
              <option value="subcontractor">Subcontractor</option>
              <option value="contractor">Contractor</option>
            </select>
          </label>

          {/* Only a subcontractor belongs to a team — a contractor's place is
              beside the owner, and the model is one level deep. */}
          {member.role === 'subcontractor' && contractors.length > 0 && (
            <label className="flex items-center gap-2">
              <span className="text-caption text-muted">Works under</span>
              <select
                value={member.parentMembershipId ?? ''}
                disabled={assignTo.isPending}
                onChange={(e) =>
                  assignTo.mutate({
                    businessId,
                    membershipId: member._id,
                    parentMembershipId:
                      e.target.value === ''
                        ? null
                        : (e.target.value as Id<'memberships'>),
                  })
                }
                className="h-9 rounded-xl bg-surface-3 px-2.5 text-body text-ink outline-none focus:ring-2 focus:ring-blue disabled:opacity-50"
              >
                <option value="">Nobody — answers to you</option>
                {contractors.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.name || c.email}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Owners already see everything, so offering the toggle would imply it
          could be turned off. */}
      {!isOwner && (
        <label className="mt-3 flex items-start justify-between gap-3 border-t border-hairline-2 pt-3">
          <span className="min-w-0">
            <span className="block text-body text-ink">Can view all jobs</span>
            <span className="block text-caption text-muted">
              Read-only visibility of the whole schedule and property history.
              Never the right to edit someone else's booking.
            </span>
          </span>
          <Switch.Root
            checked={member.grants.otherSchedules}
            disabled={setGrants.isPending}
            onCheckedChange={(checked) =>
              setGrants.mutate({
                businessId,
                membershipId: member._id,
                grants: { ...member.grants, otherSchedules: checked },
              })
            }
            className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full bg-fill-track transition data-[state=checked]:bg-green disabled:opacity-50"
          >
            <Switch.Thumb className="block size-[27px] translate-x-0.5 rounded-full bg-white shadow-elevation transition-transform will-change-transform data-[state=checked]:translate-x-[22px]" />
          </Switch.Root>
        </label>
      )}

      {!isOwner && (
        <label className="mt-3 flex items-start justify-between gap-3 border-t border-hairline-2 pt-3">
          <span className="min-w-0">
            <span className="block text-body text-ink">Can see job prices</span>
            <span className="block text-caption text-muted">
              Prices on jobs, and the revenue figures on the dashboard and
              analytics. With this off they see the work, not what it is worth.
            </span>
          </span>
          <Switch.Root
            checked={member.grants.prices}
            disabled={setGrants.isPending}
            onCheckedChange={(checked) =>
              // The whole object with one field changed. Sending only the
              // change would make every other toggle false the first time a
              // legacy row gets a `grants` object written to it.
              setGrants.mutate({
                businessId,
                membershipId: member._id,
                grants: { ...member.grants, prices: checked },
              })
            }
            className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full bg-fill-track transition data-[state=checked]:bg-green disabled:opacity-50"
          >
            <Switch.Thumb className="block size-[27px] translate-x-0.5 rounded-full bg-white shadow-elevation transition-transform will-change-transform data-[state=checked]:translate-x-[22px]" />
          </Switch.Root>
        </label>
      )}

      {!isOwner && (
        <label className="mt-3 flex items-start justify-between gap-3 border-t border-hairline-2 pt-3">
          <span className="min-w-0">
            <span className="block text-body text-ink">
              Can view other accounts
            </span>
            <span className="block text-caption text-muted">
              Lets them switch their own view to see other subcontractors'
              schedules and clients from the header account menu — never the
              owner's, even with this on.
            </span>
          </span>
          <Switch.Root
            checked={member.canViewOtherAccounts}
            disabled={setViewOthers.isPending}
            onCheckedChange={(checked) =>
              setViewOthers.mutate({
                businessId,
                membershipId: member._id,
                canViewOtherAccounts: checked,
              })
            }
            className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full bg-fill-track transition data-[state=checked]:bg-green disabled:opacity-50"
          >
            <Switch.Thumb className="block size-[27px] translate-x-0.5 rounded-full bg-white shadow-elevation transition-transform will-change-transform data-[state=checked]:translate-x-[22px]" />
          </Switch.Root>
        </label>
      )}

      {!isOwner && (
        <RemoveMember businessId={businessId} member={member} others={others} />
      )}
    </div>
  )
}

/**
 * Removing someone is the part that was missing entirely: there was no button
 * and no mutation, so a subcontractor who left kept their access until someone
 * edited the database by hand.
 *
 * It asks first, and the asking is specific — "Kevin has 12 jobs booked" is the
 * difference between an informed decision and an accident.
 */
function RemoveMember({
  businessId,
  member,
  others,
}: {
  businessId: Id<'businesses'>
  member: Member
  others: Array<Member>
}) {
  const [confirming, setConfirming] = useState(false)
  const [reassignTo, setReassignTo] = useState<Id<'memberships'> | ''>('')

  const preview = useQuery({
    ...convexQuery(api.team.removalPreview, {
      businessId,
      membershipId: member._id,
    }),
    enabled: confirming,
  })

  const convexRemove = useConvexMutation(api.team.remove)
  const remove = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      reassignTo?: Id<'memberships'>
    }) => convexRemove(args),
    onSuccess: () => setConfirming(false),
  })

  const handover =
    (preview.data?.futureJobs ?? 0) + (preview.data?.activeRecurrences ?? 0) > 0

  if (!confirming) {
    return (
      <div className="mt-3 border-t border-hairline-2 pt-3">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-caption font-semibold text-red"
        >
          Remove from team
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3 border-t border-hairline-2 pt-3">
      <p className="text-body text-ink">
        Remove {member.name || member.email}?
      </p>
      <p className="mt-1 text-caption text-muted">
        {preview.isPending
          ? 'Checking what they have on…'
          : describeWork(preview.data)}
      </p>

      {handover && (
        <label className="mt-3 flex flex-col gap-1.5">
          <span className="section-label">Hand their work to</span>
          <select
            value={reassignTo}
            onChange={(e) =>
              setReassignTo(e.target.value as Id<'memberships'> | '')
            }
            className="h-11 rounded-xl bg-surface-3 px-3 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            <option value="">Choose someone…</option>
            {others.map((other) => (
              <option key={other._id} value={other._id}>
                {other.name || other.email}
              </option>
            ))}
          </select>
        </label>
      )}

      {remove.isError && (
        <p
          role="alert"
          className="mt-2 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          {removeError(remove.error)}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="h-11 flex-1 rounded-xl bg-surface-2 text-body font-semibold text-ink transition active:scale-[.975]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={remove.isPending || (handover && !reassignTo)}
          onClick={() =>
            remove.mutate({
              businessId,
              membershipId: member._id,
              reassignTo: reassignTo === '' ? undefined : reassignTo,
            })
          }
          className="h-11 flex-1 rounded-xl bg-red text-body font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {remove.isPending ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

function describeWork(
  preview:
    | { futureJobs: number; activeRecurrences: number; openDrafts: number }
    | undefined,
) {
  if (!preview) return 'They lose access straight away.'
  const parts: Array<string> = []
  if (preview.futureJobs > 0) {
    parts.push(
      `${preview.futureJobs} job${preview.futureJobs === 1 ? '' : 's'} booked`,
    )
  }
  if (preview.activeRecurrences > 0) {
    parts.push(
      `${preview.activeRecurrences} repeating service${preview.activeRecurrences === 1 ? '' : 's'}`,
    )
  }
  if (preview.openDrafts > 0) {
    parts.push(
      `${preview.openDrafts} unfinished report${preview.openDrafts === 1 ? '' : 's'}, which move${preview.openDrafts === 1 ? 's' : ''} to you`,
    )
  }
  if (parts.length === 0) return 'They lose access straight away.'
  return `They have ${parts.join(' and ')}. They lose access straight away.`
}

function removeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('NEEDS_REASSIGNMENT')) {
    return 'Choose who takes over their booked work first.'
  }
  if (message.includes('INVALID_ASSIGNEE')) {
    return 'That person cannot take over the work. Pick an active member.'
  }
  if (message.includes('LAST_OWNER')) return 'The owner cannot be removed.'
  return 'Could not remove them. Check your connection and try again.'
}
