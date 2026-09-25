import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Switch } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { useAccess, useCan } from '#/lib/access'
import { useAssigneeOptions } from '#/lib/assignees'
import { ColourPicker } from './ColourPicker'
import { ResetTwoStepButton } from './ResetTwoStepButton'
import { MemberLicenceButton } from './MemberLicenceButton'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Grants, Role } from '../../../convex/lib/capabilities'

export type Member = {
  _id: Id<'memberships'>
  name: string
  email: string
  role: Role
  grants: Grants
  canViewOtherAccounts: boolean
  /** From the roster: whether this viewer may change this person's access at
   * all (`canManageMember`) — the owner, anyone but themselves; a contractor,
   * their own team. Every control below the licence sits behind it. */
  canManage: boolean
  /** From the roster: whether this viewer may change this person's role — the
   * owner only (`canSetRole`). Absent from an older backend; see `roleEditable`
   * below for what that means. */
  canSetRole?: boolean
  /** From the roster: whether this viewer may hand work to this person
   * (`canDispatchTo`) — who may take over a departing member's bookings.
   * Absent from an older backend; `useAssigneeOptions` falls back. */
  bookable?: boolean
  parentMembershipId?: Id<'memberships'> | null
  licenceNumber?: string
  colour: string
  status: string
  /** From the roster: whether this viewer may set this person's colour. Absent
   * from an older backend, which means no picker. */
  canSetColour?: boolean
  /** From the roster: whether they have two-step sign-in set up. Absent from
   * an older backend, which means no reset is offered. */
  twoStepOn?: boolean
  /** From the roster: a licence document this viewer (the owner) may open.
   * Absent from an older backend, which means no button. */
  hasLicenceFile?: boolean
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

  const convexSetLicence = useConvexMutation(api.memberships.setLicence)
  const saveLicence = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      licenceNumber: string
    }) => convexSetLicence(args),
  })
  const [licence, setLicence] = useState(member.licenceNumber ?? '')

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

  // Everything below is gated on what the server will accept from THIS
  // viewer, not on who the row is. A contractor holds `team.manage` for their
  // own team only, and was being shown role, team, access, reset and remove
  // controls on everyone — each of which the server refuses.
  const access = useAccess()
  const viewerIsOwner = access.role === 'owner'
  const isMe = member._id === access.membershipId
  const canManage = member.canManage
  // An older backend sends no `canSetRole`. Its rule was never narrower than
  // this — the owner, on anyone they manage — so this is safe on either.
  const roleEditable = member.canSetRole ?? (viewerIsOwner && canManage)
  // `memberships.setLicence`: the owner sets anyone's, everyone else only
  // their own.
  const licenceEditable = viewerIsOwner || isMe
  // A contractor can only give away what they hold (`grantCeiling`); the
  // server clamps anything more to off, so the switch would only flip back.
  const canGrantSchedules = useCan('schedules.seeOthers')
  const canGrantPrices = useCan('prices.see')

  // Where this person may be put (`canAssignTo`). The owner places anyone under
  // any contractor. A contractor may keep their own people or let them go back
  // to the owner, never hand them to another contractor.
  const parents = viewerIsOwner
    ? contractors
    : contractors.filter((c) => c._id === access.membershipId)
  const showTeam =
    canManage && member.role === 'subcontractor' && parents.length > 0
  // Letting someone go is one-way for a contractor: once they answer to the
  // owner, they are off this contractor's team and only the owner can put
  // them back. So it asks first. The owner's moves are all reversible.
  const [releasing, setReleasing] = useState(false)
  const displayName = member.name || member.email || 'this person'

  // Demoting a contractor who has people under them hands those people to the
  // owner (`releaseTeam`), which the select alone gives no hint of — so it
  // says who, and asks. With nobody under them it is a plain change.
  const team = teamOf(member, others)
  const [demoting, setDemoting] = useState(false)

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
            {/* Why some rows have controls and others do not, for a
                contractor: these are the people they run. */}
            {!viewerIsOwner &&
              member.parentMembershipId === access.membershipId && (
                <span className="normal-case"> · Your team</span>
              )}
          </p>
        </div>
      </div>

      {member.canSetColour && (
        <div className="mt-3 border-t border-hairline-2 pt-3">
          <ColourPicker
            businessId={businessId}
            membershipId={member._id}
            name={member.name || member.email || 'this person'}
            colour={member.colour}
            others={others}
          />
        </div>
      )}

      {/*
        Here, and not only on each person's own Profile page.
        A regulated report cannot be finalised without a licence number on the
        account it belongs to, and the owner is the one who knows those numbers
        and the one who gets the phone call when a certificate will not sign.
        Leaving it self-service meant the only way to prepare a team for that
        rule was to ask every technician to go and type it in themselves.
      */}
      {licenceEditable && (
        <form
          className="mt-3 flex items-end gap-2 border-t border-hairline-2 pt-3"
          onSubmit={(e) => {
            e.preventDefault()
            saveLicence.mutate({
              businessId,
              membershipId: member._id,
              licenceNumber: licence,
            })
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="section-label">Licence number</span>
            <input
              value={licence}
              onChange={(e) => setLicence(e.target.value)}
              placeholder="Not set"
              className="mt-1 h-11 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </label>
          <button
            type="submit"
            disabled={
              saveLicence.isPending || licence === (member.licenceNumber ?? '')
            }
            className="h-11 shrink-0 rounded-xl bg-surface-2 px-4 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
          >
            {saveLicence.isPending
              ? 'Saving…'
              : saveLicence.isSuccess
                ? 'Saved'
                : 'Save'}
          </button>
        </form>
      )}
      {/* A failed save used to leave only the button saying "Save" again. */}
      <FormAlert
        error={saveLicence.isError ? saveLicence.error : null}
        className="mt-2"
      />
      {/* Worth knowing on their own team even where the contractor cannot
          type it in for them: it is the reason a certificate will not sign. */}
      {!member.licenceNumber && (licenceEditable || canManage) && (
        <p className="mt-1.5 text-caption text-amber-ink">
          Without this they cannot finalise a termite certificate, timber pest
          inspection or treatment record.
        </p>
      )}

      {/* Phase 8.1: the licence document they uploaded, read-only. */}
      {member.hasLicenceFile && (
        <div className="mt-2 flex flex-wrap items-center">
          <MemberLicenceButton
            businessId={businessId}
            membershipId={member._id}
            name={member.name || member.email || 'This person'}
          />
        </div>
      )}

      {(roleEditable || showTeam) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline-2 pt-3">
          {/* The owner's call alone: a role decides who has a team, so a
              contractor promoting one of their own would be minting a peer. */}
          {roleEditable && (
            <label className="flex items-center gap-2">
              <span className="text-caption text-muted">Role</span>
              <select
                value={member.role}
                disabled={setRole.isPending || demoting}
                onChange={(e) => {
                  const role = e.target.value as 'subcontractor' | 'contractor'
                  if (
                    member.role === 'contractor' &&
                    role === 'subcontractor' &&
                    team.length > 0
                  ) {
                    setDemoting(true)
                    return
                  }
                  setRole.mutate({
                    businessId,
                    membershipId: member._id,
                    role,
                  })
                }}
                className="h-9 rounded-xl bg-surface-3 px-2.5 text-body text-ink outline-none focus:ring-2 focus:ring-blue disabled:opacity-50"
              >
                <option value="subcontractor">Subcontractor</option>
                <option value="contractor">Contractor</option>
              </select>
            </label>
          )}

          {/* Only a subcontractor belongs to a team — a contractor's place is
              beside the owner, and the model is one level deep. */}
          {showTeam && (
            <label className="flex items-center gap-2">
              <span className="text-caption text-muted">Works under</span>
              <select
                value={member.parentMembershipId ?? ''}
                disabled={assignTo.isPending || releasing}
                onChange={(e) => {
                  if (e.target.value === '' && !viewerIsOwner) {
                    setReleasing(true)
                    return
                  }
                  assignTo.mutate({
                    businessId,
                    membershipId: member._id,
                    parentMembershipId:
                      e.target.value === ''
                        ? null
                        : (e.target.value as Id<'memberships'>),
                  })
                }}
                className="h-9 rounded-xl bg-surface-3 px-2.5 text-body text-ink outline-none focus:ring-2 focus:ring-blue disabled:opacity-50"
              >
                <option value="">
                  {viewerIsOwner
                    ? 'Nobody — answers to you'
                    : 'Nobody — answers to the owner'}
                </option>
                {parents.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c._id === access.membershipId ? 'You' : c.name || c.email}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {demoting && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <p className="text-body text-ink">
            Make {displayName} a subcontractor?
          </p>
          <p className="mt-1 text-caption text-muted">
            {listNames(team)} {team.length === 1 ? 'answers' : 'answer'} to{' '}
            {displayName} now, and will answer to you instead, keeping what they
            can see today.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setDemoting(false)}
              className="h-11 flex-1 rounded-xl bg-surface text-body font-semibold text-ink transition active:scale-[.975]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={setRole.isPending}
              onClick={() =>
                setRole.mutate(
                  {
                    businessId,
                    membershipId: member._id,
                    role: 'subcontractor',
                  },
                  { onSettled: () => setDemoting(false) },
                )
              }
              className="h-11 flex-1 rounded-xl bg-blue text-body font-semibold text-white transition active:scale-[.975] disabled:opacity-50"
            >
              {setRole.isPending ? 'Changing…' : 'Make subcontractor'}
            </button>
          </div>
        </div>
      )}

      {releasing && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <p className="text-body text-ink">
            Hand {displayName} back to the owner?
          </p>
          <p className="mt-1 text-caption text-muted">
            They leave your team straight away, and only the owner can put them
            back on it.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setReleasing(false)}
              className="h-11 flex-1 rounded-xl bg-surface text-body font-semibold text-ink transition active:scale-[.975]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={assignTo.isPending}
              onClick={() =>
                assignTo.mutate(
                  {
                    businessId,
                    membershipId: member._id,
                    parentMembershipId: null,
                  },
                  { onSettled: () => setReleasing(false) },
                )
              }
              className="h-11 flex-1 rounded-xl bg-red text-body font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
            >
              {assignTo.isPending ? 'Handing back…' : 'Hand back'}
            </button>
          </div>
        </div>
      )}

      {/* A change the server refused used to just snap the select back. */}
      <FormAlert error={setRole.error ?? assignTo.error} className="mt-2" />

      {/* Only on people this viewer manages — never the owner's row (owners
          already see everything, so the toggle would imply it could be turned
          off), never their own, and for a contractor only their own team. */}
      {canManage && canGrantSchedules && (
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

      {canManage && canGrantPrices && (
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

      {canManage && (
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

      <FormAlert
        error={setGrants.error ?? setViewOthers.error}
        className="mt-2"
      />

      {/* The button checks the rest itself: the owner, as themselves. */}
      {canManage && (
        <ResetTwoStepButton
          businessId={businessId}
          membershipId={member._id}
          name={member.name || member.email}
          twoStepOn={member.twoStepOn}
        />
      )}

      {canManage && (
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
  const team = teamOf(member, others)

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

  // Their work goes only where the remover could have booked it
  // (`canDispatchTo`, which `team.remove` checks): the owner, onto anyone; a
  // contractor, onto themselves or their own team.
  const { options: successors } = useAssigneeOptions(others)

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
      {/* Only a contractor has anyone under them, and only the owner may
          remove a contractor — so "you" is always the owner here. */}
      {team.length > 0 && (
        <p className="mt-1 text-caption text-muted">
          {listNames(team)} will answer to you instead, keeping what they can
          see today.
        </p>
      )}

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
            {successors.map((other) => (
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

/** Who works under this person — only ever a contractor's people. */
function teamOf(member: Member, others: Array<Member>): Array<Member> {
  return others.filter((m) => m.parentMembershipId === member._id)
}

/** "Kevin", "Kevin and Mia", "Kevin, Mia and 3 others". */
function listNames(people: Array<Member>): string {
  const names = people.map((m) => m.name || m.email || 'Someone')
  if (names.length <= 2) return names.join(' and ')
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`
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
  if (message.includes('NO_ACCESS')) {
    return 'They are no longer yours to remove. Ask the business owner.'
  }
  return 'Could not remove them. Check your connection and try again.'
}
