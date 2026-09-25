import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Switch } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { useAccess } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import { ColourPicker } from './ColourPicker'
import { ResetTwoStepButton } from './ResetTwoStepButton'
import { MemberLicenceButton } from './MemberLicenceButton'
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
 * A licence number is the owner's to set for anyone, or a person's own
 * (`memberships.setLicence`).
 */
export function MemberSettings({
  businessId,
  member,
  others = [],
  onRemoved,
}: {
  businessId: Id<'businesses'>
  member: Member
  /** Active members who could take over this person's booked work. */
  others?: Array<Member>
  /** After they have been removed, so the page can go back to the list. */
  onRemoved: () => void
}) {
  const access = useAccess()
  const isOwner = member.role === 'owner'
  const manages = !isOwner && member.canManage
  const canSetLicence =
    access.role === 'owner' || member._id === access.membershipId

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
        canEdit={canSetLicence}
      />

      {manages && (
        <RoleGroup businessId={businessId} member={member} others={others} />
      )}

      {manages && <AccessGroup businessId={businessId} member={member} />}

      {manages && (
        <DangerGroup>
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
}: {
  businessId: Id<'businesses'>
  member: Member
  canEdit: boolean
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

  const missing = !member.licenceNumber

  return (
    <SettingsGroup
      title="Licence"
      footer={
        missing ? (
          // orange-ink, not amber-ink: on the canvas amber-ink is 3.6:1,
          // under the 4.5 small text needs (FormAlert has the same rule).
          <span className="text-orange-ink">
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
                  className="h-12 shrink-0 rounded-xl bg-red px-4 text-[16px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
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

      {/* Phase 8.1: the licence document they uploaded, read-only. */}
      {member.hasLicenceFile && (
        <MemberLicenceButton
          businessId={businessId}
          membershipId={member._id}
          name={member.name || member.email || 'This person'}
        />
      )}
    </SettingsGroup>
  )
}

function RoleGroup({
  businessId,
  member,
  others,
}: {
  businessId: Id<'businesses'>
  member: Member
  others: Array<Member>
}) {
  const hydrated = useHydrated()
  const access = useAccess()
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

  const contractors = others.filter(
    (m) => m.role === 'contractor' && m.status === 'active',
  )

  const failed = setRole.isError
    ? setRole.error
    : assignTo.isError
      ? assignTo.error
      : null

  return (
    <SettingsGroup title="Role">
      {/* Each saves as it changes: there is nothing to type, so nothing to
          hold back for a Save. Disabled until the page has hydrated — a
          change before then lands on a select with no handler, and is
          lost. */}
      <FieldRow id={roleId} label="Role">
        <select
          id={roleId}
          value={member.role}
          disabled={setRole.isPending || !hydrated}
          onChange={(e) =>
            setRole.mutate({
              businessId,
              membershipId: member._id,
              role: e.target.value as 'subcontractor' | 'contractor',
            })
          }
          className={`${fieldInputClass()} disabled:opacity-50`}
        >
          <option value="subcontractor">Subcontractor</option>
          <option value="contractor">Contractor</option>
        </select>
      </FieldRow>

      {/* Only a subcontractor belongs to a team — a contractor's place is
          beside the owner, and the model is one level deep. */}
      {member.role === 'subcontractor' && contractors.length > 0 && (
        <FieldRow id={parentId} label="Works under">
          <select
            id={parentId}
            value={member.parentMembershipId ?? ''}
            disabled={assignTo.isPending || !hydrated}
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
            className={`${fieldInputClass()} disabled:opacity-50`}
          >
            {/* `null` is the owner (team.assignTo), whoever is looking: to
                a contractor moving one of their own crew, "you" would read
                as themselves. */}
            <option value="">
              {access.role === 'owner'
                ? 'Nobody — answers to you'
                : 'Nobody — answers to the owner'}
            </option>
            {contractors.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name || c.email}
              </option>
            ))}
          </select>
        </FieldRow>
      )}

      {failed !== null && (
        <div className="px-3.5 py-3">
          <FormAlert error={failed} />
        </div>
      )}
    </SettingsGroup>
  )
}

// Owners already see everything, so the page offers them none of these: a
// toggle would imply it could be turned off.
function AccessGroup({
  businessId,
  member,
}: {
  businessId: Id<'businesses'>
  member: Member
}) {
  const hydrated = useHydrated()

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
      <SwitchRow
        label="Can view other accounts"
        description="Switch to other subcontractors' views — never the owner's."
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
  onRemoved,
}: {
  businessId: Id<'businesses'>
  member: Member
  others: Array<Member>
  onRemoved: () => void
}) {
  const hydrated = useHydrated()
  const reassignId = useId()
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
    // On the mutation, not on the call: by the time it resolves the roster
    // has already dropped them, and the page may have unmounted this.
    onSuccess: () => {
      setConfirming(false)
      onRemoved()
    },
  })

  const handover =
    (preview.data?.futureJobs ?? 0) + (preview.data?.activeRecurrences ?? 0) > 0

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
            {others.map((other) => (
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
