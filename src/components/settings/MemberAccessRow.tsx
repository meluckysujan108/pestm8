import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Switch } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { useAccess, useCan } from '#/lib/access'
import { useAssigneeOptions } from '#/lib/assignees'
import { useHydrated } from '#/lib/useHydrated'
import { ColourPicker } from './ColourPicker'
import { ResetTwoStepButton } from './ResetTwoStepButton'
import { MemberLicences } from './MemberLicences'
import { canSetLicence, needsLicence } from './needsLicence'
import { useSavedFlash } from './useJustSaved'
import {
  DANGER_ROW_CLASS,
  DangerGroup,
  FIELD_LABEL,
  FieldRow,
  ROW_CLASS,
  SettingsGroup,
  SettingsRow,
} from './ui'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Grants, Role } from '../../../convex/lib/capabilities'
import {
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'

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
  /** From the roster: how many licences they hold — for the owner, and on
   * one's own row. Absent from an older backend, and for anyone else. */
  licenceCount?: number
}

/** How a person is named wherever the team lists them. */
export function memberName(member: Pick<Member, 'name' | 'email'>): string {
  return member.name || member.email || 'Team member'
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  contractor: 'Contractor',
  subcontractor: 'Subcontractor',
}

/**
 * One person's settings, as the groups of their page under Settings → Team:
 * colour, licence, role, access, and — last, in red — the two things that
 * take something away from them.
 *
 * Each control is offered only where the server will take it. `canManage`
 * is the roster's own answer (`canManageMember`): an owner manages everyone
 * but themselves, a contractor only their own team, and nobody the owner.
 * A role is the owner's alone to change (`canSetRole`), and a licence number
 * is the owner's to set for anyone, or a person's own
 * (`memberships.setLicence`).
 */
export function MemberSettings({
  businessId,
  timezone,
  member,
  others = [],
  sentInvitations = 0,
  onRemoved,
}: {
  businessId: Id<'businesses'>
  /** The business's, which a licence's expiry is counted in. */
  timezone: string
  member: Member
  /** Active members who could take over this person's booked work. */
  others?: Array<Member>
  /** How many unused invitation links this person sent. */
  sentInvitations?: number
  /** After they have been removed, so the page can go back to the list. */
  onRemoved: () => void
}) {
  // Everything below is gated on what the server will accept from THIS
  // viewer, not on who the person is. A contractor holds `team.manage` for
  // their own team only, and was being shown role, team, access, reset and
  // remove controls on everyone — each of which the server refuses.
  const access = useAccess()
  const viewerIsOwner = access.role === 'owner'
  const canManage = member.canManage
  // An older backend sends no `canSetRole`. Its rule was never narrower than
  // this — the owner, on anyone they manage — so this is safe on either.
  const roleEditable = member.canSetRole ?? (viewerIsOwner && canManage)

  // Where this person may be put (`canAssignTo`). The owner places anyone under
  // any contractor. A contractor may keep their own people or let them go back
  // to the owner, never hand them to another contractor.
  const contractors = others.filter(
    (m) => m.role === 'contractor' && m.status === 'active',
  )
  const parents = viewerIsOwner
    ? contractors
    : contractors.filter((c) => c._id === access.membershipId)
  // Only a subcontractor belongs to a team — a contractor's place is beside
  // the owner, and the model is one level deep.
  const showTeam =
    canManage && member.role === 'subcontractor' && parents.length > 0

  return (
    <>
      {member.canSetColour && (
        <SettingsGroup
          title="Colour"
          footer="Marks their jobs on every schedule the team shares."
        >
          <ColourPicker
            businessId={businessId}
            membershipId={member._id}
            name={member.name || member.email || 'this person'}
            colour={member.colour}
            others={others}
          />
        </SettingsGroup>
      )}

      <LicenceGroup
        businessId={businessId}
        member={member}
        canEdit={canSetLicence(member, access)}
        // Worth knowing on their own team even where the contractor cannot
        // type it in for them: it is the reason a certificate will not sign.
        // The rule the Team page's badge and the hub's count use.
        missing={needsLicence(member, access)}
      />

      {/* The licences they hold, read-only — the owner's alone to see. Apart
          from the number above, which prints on their reports. */}
      <MemberLicences
        businessId={businessId}
        membershipId={member._id}
        name={memberName(member)}
        licenceCount={member.licenceCount}
        active={member.status === 'active'}
        timezone={timezone}
      />

      {(roleEditable || showTeam) && (
        <RoleGroup
          businessId={businessId}
          member={member}
          roleEditable={roleEditable}
          parents={showTeam ? parents : []}
          team={teamOf(member, others)}
          sentInvitations={sentInvitations}
        />
      )}

      {/* Only on people this viewer manages — never the owner's page (owners
          already see everything, so a toggle would imply it could be turned
          off), never their own, and for a contractor only their own team. */}
      {canManage && <AccessGroup businessId={businessId} member={member} />}

      {canManage && (
        <DangerGroup>
          {/* The button checks the rest itself: the owner, as themselves. */}
          <ResetTwoStepButton
            businessId={businessId}
            membershipId={member._id}
            name={member.name || member.email}
            twoStepOn={member.twoStepOn}
          />
          <RemoveMember
            businessId={businessId}
            member={member}
            others={others}
            sentInvitations={sentInvitations}
            onRemoved={onRemoved}
          />
        </DangerGroup>
      )}
    </>
  )
}

/*
  Here, and not only on each person's own Licence page.
  A regulated report cannot be finalised without a licence number on the
  account it belongs to, and the owner is the one who knows those numbers
  and the one who gets the phone call when a certificate will not sign.
  Leaving it self-service meant the only way to prepare a team for that
  rule was to ask every technician to go and type it in themselves.
*/
function LicenceGroup({
  businessId,
  member,
  canEdit,
  missing,
}: {
  businessId: Id<'businesses'>
  member: Member
  /** Whether this viewer may type the number in (`canSetLicence`). */
  canEdit: boolean
  /** Whether its absence is this viewer's to act on (`needsLicence`). */
  missing: boolean
}) {
  const inputId = useId()
  const convexSetLicence = useConvexMutation(api.memberships.setLicence)
  const saveLicence = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      licenceNumber: string
    }) => convexSetLicence(args),
  })
  // What has been typed, or null for "as saved": the field shows the live
  // number until someone types, so one set meanwhile elsewhere (by the person
  // on their own Licence page) shows through rather than reading as a change
  // here — a Save appearing by itself, and pressing it writing the old
  // number back over the new one.
  const [typed, setTyped] = useState<string | null>(null)
  const licence = typed ?? member.licenceNumber ?? ''
  // The server trims what it stores, so "1234 " is not a change from "1234".
  const dirty = typed !== null && typed.trim() !== (member.licenceNumber ?? '')
  const saved = useSavedFlash()

  return (
    <SettingsGroup
      title="Licence"
      footer={
        missing ? (
          // Warning text: amber-ink, which clears 4.5 on the canvas.
          <span className="text-amber-ink">
            Without this they cannot finalise a termite certificate, timber pest
            inspection or treatment record.
          </span>
        ) : canEdit ? undefined : (
          'Only the business owner can change this.'
        )
      }
    >
      {canEdit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            // Enter in an untouched field submits too; it has nothing to send.
            if (!dirty || saveLicence.isPending) return
            const sent = licence
            saveLicence.mutate(
              {
                businessId,
                membershipId: member._id,
                licenceNumber: sent,
              },
              {
                onSuccess: () => {
                  saved.mark()
                  // Back to the saved number, unless more was typed meanwhile.
                  setTyped((now) => (now === sent ? null : now))
                },
              },
            )
          }}
        >
          <FieldRow id={inputId} label="Licence number">
            <div className="flex gap-2">
              <input
                id={inputId}
                value={licence}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Not set"
                autoComplete="off"
                className={`${fieldInputClass()} min-w-0 flex-1`}
              />
              {/* This page has several controls that each save on their
                  own, so the licence gets its own small Save rather than the
                  page's bar — and only while there is something to save, or
                  a moment after, so "Saved" is seen. */}
              {(dirty || saveLicence.isPending || saved.recently) && (
                <button
                  type="submit"
                  disabled={saveLicence.isPending || !dirty}
                  className={`${PRIMARY_BUTTON} shrink-0 px-4`}
                >
                  {saveLicence.isPending
                    ? 'Saving…'
                    : !dirty && saved.recently
                      ? 'Saved'
                      : 'Save'}
                </button>
              )}
            </div>
            {/* A failed save used to leave only the button saying "Save"
                again. */}
            <FormAlert
              error={saveLicence.isError ? saveLicence.error : null}
              className="mt-2"
            />
          </FieldRow>
        </form>
      ) : (
        <SettingsRow
          title="Licence number"
          value={member.licenceNumber || 'Not set'}
        />
      )}
    </SettingsGroup>
  )
}

/**
 * Their role, and whose team they are on. Shown to whoever may change either:
 * the owner, on anyone they manage; a contractor, on their own crew — whose
 * team they may keep them on or let go of, but whose role is not theirs to
 * change.
 */
function RoleGroup({
  businessId,
  member,
  roleEditable,
  parents,
  team,
  sentInvitations,
}: {
  businessId: Id<'businesses'>
  member: Member
  /** The owner's call alone (`canSetRole`). */
  roleEditable: boolean
  /** Whom they may be put under (`canAssignTo`); none hides "Works under". */
  parents: Array<Member>
  /** Who works under them — only ever a contractor's people. */
  team: Array<Member>
  /** Their unused invitation links, which a demotion withdraws. */
  sentInvitations: number
}) {
  const hydrated = useHydrated()
  const access = useAccess()
  const viewerIsOwner = access.role === 'owner'
  const roleId = useId()
  const parentId = useId()

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

  // Letting someone go is one-way for a contractor: once they answer to the
  // owner, they are off this contractor's team and only the owner can put
  // them back. So it asks first. The owner's moves are all reversible.
  const [releasing, setReleasing] = useState(false)

  // Demoting a contractor who has people under them hands those people to the
  // owner (`releaseTeam`), which the select alone gives no hint of — so it
  // says who, and asks. With nobody under them it is a plain change.
  const [demoting, setDemoting] = useState(false)

  // A change the server refused used to just snap the select back.
  const failed = setRole.isError
    ? setRole.error
    : assignTo.isError
      ? assignTo.error
      : null

  return (
    <SettingsGroup
      title="Role"
      footer={
        roleEditable ? undefined : 'Only the business owner can change a role.'
      }
    >
      {/* Each saves as it changes: there is nothing to type, so nothing to
          hold back for a Save. Disabled until the page has hydrated — a
          change before then lands on a select with no handler, and is
          lost. */}
      {/* The owner's call alone: a role decides who has a team, so a
          contractor promoting one of their own would be minting a peer. */}
      {roleEditable ? (
        <FieldRow id={roleId} label="Role">
          <select
            id={roleId}
            value={member.role}
            disabled={setRole.isPending || demoting || !hydrated}
            onChange={(e) => {
              const role = e.target.value as 'subcontractor' | 'contractor'
              if (
                member.role === 'contractor' &&
                role === 'subcontractor' &&
                (team.length > 0 || sentInvitations > 0)
              ) {
                setDemoting(true)
                return
              }
              setRole.mutate({ businessId, membershipId: member._id, role })
            }}
            className={`${fieldInputClass()} disabled:opacity-50`}
          >
            <option value="subcontractor">Subcontractor</option>
            <option value="contractor">Contractor</option>
          </select>
        </FieldRow>
      ) : (
        <SettingsRow title="Role" value={ROLE_LABEL[member.role]} />
      )}

      {parents.length > 0 && (
        <FieldRow id={parentId} label="Works under">
          <select
            id={parentId}
            value={member.parentMembershipId ?? ''}
            disabled={assignTo.isPending || releasing || !hydrated}
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
            className={`${fieldInputClass()} disabled:opacity-50`}
          >
            {/* `null` is the owner (team.assignTo), whoever is looking: to
                a contractor moving one of their own crew, "you" would read
                as themselves. */}
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
        </FieldRow>
      )}

      {demoting && (
        <div className="px-3.5 py-3">
          <p className="text-body text-ink">
            Make {memberName(member)} a subcontractor?
          </p>
          {team.length > 0 && (
            <p className="mt-1 text-caption text-muted">
              {listNames(team)} {team.length === 1 ? 'answers' : 'answer'} to{' '}
              {memberName(member)} now, and will answer to you instead, keeping
              what they can see today.
            </p>
          )}
          <WithdrawnLinks count={sentInvitations} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setDemoting(false)}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              Keep as contractor
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
              className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
            >
              {setRole.isPending ? 'Changing…' : 'Make subcontractor'}
            </button>
          </div>
        </div>
      )}

      {releasing && (
        <div className="px-3.5 py-3">
          <p className="text-body text-ink">
            Hand {memberName(member)} back to the owner?
          </p>
          <p className="mt-1 text-caption text-muted">
            They leave your team straight away, and only the owner can put them
            back on it.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setReleasing(false)}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              Keep on your team
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
              className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
            >
              {assignTo.isPending ? 'Handing back…' : 'Hand back'}
            </button>
          </div>
        </div>
      )}

      {failed !== null && (
        <div className="px-3.5 py-3">
          <FormAlert error={failed} />
        </div>
      )}
    </SettingsGroup>
  )
}

function AccessGroup({
  businessId,
  member,
}: {
  businessId: Id<'businesses'>
  member: Member
}) {
  const hydrated = useHydrated()
  // A contractor can only give away what they hold (`grantCeiling`); the
  // server clamps anything more to off, so the switch would only flip back.
  const canGrantSchedules = useCan('schedules.seeOthers')
  const canGrantPrices = useCan('prices.see')

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

  const convexSetGrants = useConvexMutation(api.memberships.setGrants)
  const setGrants = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      grants: Grants
    }) => convexSetGrants(args),
  })

  const failed = setGrants.isError
    ? setGrants.error
    : setViewOthers.isError
      ? setViewOthers.error
      : null

  return (
    <SettingsGroup title="Access">
      {canGrantSchedules && (
        <SwitchRow
          label="Can view all jobs"
          description="Read-only view of every schedule and property history."
          checked={member.grants.otherSchedules}
          disabled={setGrants.isPending || !hydrated}
          onChange={(checked) =>
            setGrants.mutate({
              businessId,
              membershipId: member._id,
              grants: { ...member.grants, otherSchedules: checked },
            })
          }
        />
      )}
      {canGrantPrices && (
        <SwitchRow
          label="Can see job prices"
          description="Prices on jobs and revenue on the dashboard."
          checked={member.grants.prices}
          disabled={setGrants.isPending || !hydrated}
          onChange={(checked) =>
            // The whole object with one field changed. Sending only the
            // change would make every other toggle false the first time a
            // legacy row gets a `grants` object written to it.
            setGrants.mutate({
              businessId,
              membershipId: member._id,
              grants: { ...member.grants, prices: checked },
            })
          }
        />
      )}
      <SwitchRow
        label="Can view other accounts"
        description="Switch to other subcontractors’ views — never the owner’s."
        checked={member.canViewOtherAccounts}
        disabled={setViewOthers.isPending || !hydrated}
        onChange={(checked) =>
          setViewOthers.mutate({
            businessId,
            membershipId: member._id,
            canViewOtherAccounts: checked,
          })
        }
      />
      {failed !== null && (
        <div className="px-3.5 py-3">
          <FormAlert error={failed} />
        </div>
      )}
    </SettingsGroup>
  )
}

/**
 * A switch as a row. The whole row is its <label>, so a gloved tap anywhere
 * on the words flips it; the switch's own name is just the title, which is
 * what a screen reader (and the e2e suite) calls it. The line under it wraps
 * rather than truncating like a link row's subtitle: it is what the switch
 * does, and half of it is no use.
 */
function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: ReactNode
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const descriptionId = useId()
  return (
    <label className={ROW_CLASS}>
      <span className="min-w-0 flex-1">
        <span className="block text-body text-ink">{label}</span>
        <span id={descriptionId} className="block text-caption text-muted">
          {description}
        </span>
      </span>
      <Switch.Root
        aria-label={label}
        aria-describedby={descriptionId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="relative h-[31px] w-[51px] shrink-0 rounded-full bg-fill-track transition data-[state=checked]:bg-green disabled:opacity-50"
      >
        <Switch.Thumb className="block size-[27px] translate-x-0.5 rounded-full bg-white shadow-elevation transition-transform will-change-transform data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
    </label>
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
  sentInvitations,
  onRemoved,
}: {
  businessId: Id<'businesses'>
  member: Member
  others: Array<Member>
  sentInvitations: number
  onRemoved: () => void
}) {
  const hydrated = useHydrated()
  const reassignId = useId()
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
    // On the mutation, not on the call: by the time it resolves the roster
    // has already dropped them, and the page may have unmounted this.
    onSuccess: () => {
      setConfirming(false)
      onRemoved()
    },
  })

  const handover =
    (preview.data?.futureJobs ?? 0) + (preview.data?.activeRecurrences ?? 0) > 0

  // Their work goes only where the remover could have booked it
  // (`canDispatchTo`, which `team.remove` checks): the owner, onto anyone; a
  // contractor, onto themselves or their own team.
  const { options: successors } = useAssigneeOptions(others)

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => setConfirming(true)}
        className={DANGER_ROW_CLASS}
      >
        Remove from team
      </button>
    )
  }

  return (
    <div className="px-3.5 py-3">
      <p className="text-body text-ink">Remove {memberName(member)}?</p>
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
      <WithdrawnLinks count={sentInvitations} />

      {handover && (
        <div className="mt-3 flex flex-col gap-1.5">
          <label htmlFor={reassignId} className={FIELD_LABEL}>
            Hand their work to
          </label>
          <select
            id={reassignId}
            value={reassignTo}
            onChange={(e) =>
              setReassignTo(e.target.value as Id<'memberships'> | '')
            }
            className={fieldInputClass()}
          >
            <option value="">Choose someone…</option>
            {successors.map((other) => (
              <option key={other._id} value={other._id}>
                {other.name || other.email}
              </option>
            ))}
          </select>
        </div>
      )}

      {remove.isError && (
        <FormAlert className="mt-2">{removeError(remove.error)}</FormAlert>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
        >
          Keep them
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
          className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
        >
          {remove.isPending ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

/**
 * Their unused invitation links go when they stop being able to send them
 * (`revokeInvitationsFrom`). Said up front, because the pending list will
 * simply lose them.
 */
function WithdrawnLinks({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <p className="mt-1 text-caption text-muted">
      {count === 1
        ? 'The invitation link they sent and nobody has used yet will stop working.'
        : `The ${count} invitation links they sent and nobody has used yet will stop working.`}{' '}
      You can invite anyone you still want yourself.
    </p>
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
  return 'Could not remove them. Check your signal and try again.'
}
