import { useId, useState } from 'react'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import {
  convexQuery,
  useConvexAction,
  useConvexMutation,
} from '@convex-dev/react-query'
import { Mail, RefreshCw, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { Segmented } from '#/components/primitives/Segmented'
import { Sheet } from '#/components/primitives/Sheet'
import { InviteLinkCard } from './InviteLinkCard'
import { ROLE_LABEL, memberName } from './MemberAccessRow'
import {
  FIELD_LABEL,
  RowBadge,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
} from './ui'
import type { Member } from './MemberAccessRow'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Role } from '../../../convex/lib/capabilities'
import { useAccess } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import { rq } from '#/lib/routeQueries'
import { needsLicence } from './needsLicence'

/**
 * Settings → Team: who is on the team, each a row that opens their own page,
 * and who has been invited and not yet joined.
 *
 * Inviting used to mean recording an email address and hoping. The button said
 * "Sending…", nothing was ever sent, and whoever registered that address first
 * — invitee or not — was let into the business.
 *
 * Now inviting mints a single-use link. The owner shares it themselves, by the
 * channel they already use with their crew: a text message. The link is shown
 * exactly once, because only its hash is stored. It is minted in a sheet (the
 * page header's Invite opens it), and the link is shown in that same sheet —
 * as is a pending invite's replacement link.
 */
export function TeamSection({
  businessId,
  businessSlug,
  inviteOpen,
  onInviteOpenChange,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  /** Whether the invite sheet is open. The page's header opens it. */
  inviteOpen: boolean
  onInviteOpenChange: (open: boolean) => void
}) {
  const { data: members } = useSuspenseQuery(
    // The management view, not the shared roster: grants are access
    // settings, and the roster six other screens read has no business
    // carrying them.
    rq.team(businessId),
  )
  const { data: rows } = useSuspenseQuery(rq.invitations(businessId))
  const invitations: ReadonlyArray<PendingInvitation> = rows

  const [email, setEmail] = useState('')
  const [freshLink, setFreshLink] = useState<{
    email: string
    url: string
  } | null>(null)

  const hydrated = useHydrated()
  // The real person, as every team mutation decides on: the Team screen is
  // not reachable while switched (`team.manage` drops).
  const access = useAccess()
  const viewerIsOwner = access.role === 'owner'
  // The owner chooses what someone joins as; a contractor's invitee is always
  // a subcontractor on their team (`canInviteAs`).
  const [inviteRole, setInviteRole] = useState<InviteRole>('subcontractor')
  const latestRole = useLatest(inviteRole)
  // Who is asking and for which business, named in the text the link goes
  // out in. The business is the layout's own query, already held.
  const { data: business } = useQuery(
    convexQuery(api.businesses.getBySlug, { slug: businessSlug }),
  )
  const viewer = members.find((m) => m._id === access.membershipId)
  const emailId = useId()
  const warnings = useSaveWarnings()

  // Read when a link comes back, not when it was asked for: a sheet closed
  // while Create link was still out must not reopen on that link the next
  // time Invite is pressed for somebody else. The invitation itself was made
  // and waits under "Waiting to join", where New link mints another.
  const sheetOpen = useLatest(inviteOpen)

  const convexCreate = useConvexAction(api.invitations.create)
  const invite = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      email: string
      role: Role
    }) => convexCreate(args),
    onSuccess: ({ url }, variables) => {
      setEmail('')
      // Back to the everyday choice: a contractor is a deliberate one, and
      // must never carry over to the next person by accident.
      setInviteRole('subcontractor')
      if (sheetOpen.current) setFreshLink({ email: variables.email, url })
    },
  })

  // Read when the link is minted, after the domain check has answered: the
  // link only works for this exact address, so it must be the one in the box
  // then, not the one there when Create link was pressed.
  const latestEmail = useLatest(email)

  const convexRevoke = useConvexMutation(api.invitations.revoke)
  const revoke = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      invitationId: Id<'invitations'>
    }) => convexRevoke(args),
  })

  const convexRegenerate = useConvexAction(api.invitations.regenerate)
  const regenerate = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      invitationId: Id<'invitations'>
      email: string
    }) =>
      convexRegenerate({
        businessId: args.businessId,
        invitationId: args.invitationId,
      }),
    onSuccess: ({ url }, variables) => {
      setFreshLink({ email: variables.email, url })
      onInviteOpenChange(true)
    },
  })

  // Closing forgets the link: it was shown once, and the way to another is
  // New link on the invite, not a copy kept here. What was typed and not yet
  // sent stays, in case the sheet was swiped away by mistake.
  const closeSheet = () => {
    onInviteOpenChange(false)
    setFreshLink(null)
    setInviteRole('subcontractor')
    invite.reset()
    warnings.reset()
  }

  const people = ownersFirst(members)
  const pendingError = regenerate.isError
    ? regenerate.error
    : revoke.isError
      ? revoke.error
      : null

  return (
    <>
      {/* The footer is stated in the product, not just the marketing: the
          absence of timesheets and rosters is a designed property, and the
          reason is worth the owner knowing (§1.4). Treating an independent
          contractor like a rostered employee is what sham-contracting law
          penalises, and "contractors aren't employees" is that reason in the
          owner's own words. */}
      <SettingsGroup
        title="People"
        footer="PestM8 has no timesheets or rosters by design — contractors aren't employees."
      >
        {people.map((member) => (
          <SettingsLinkRow
            key={member._id}
            to="/$businessSlug/settings/team/$memberId"
            params={{ businessSlug, memberId: member._id }}
            leading={
              <Initial name={memberName(member)} colour={member.colour} />
            }
            title={memberName(member)}
            subtitle={subtitleFor(member, access)}
            // Only for something that needs doing: without a number they
            // cannot finalise a regulated report, and nobody finds that out
            // until a certificate will not sign. Only on someone this viewer
            // can type it in for or chase (`needsLicence`), by the rule the
            // hub's count uses.
            badge={
              needsLicence(member, access) ? (
                <RowBadge tone="amber">No licence</RowBadge>
              ) : undefined
            }
          />
        ))}
      </SettingsGroup>

      {invitations.length > 0 && (
        <SettingsGroup
          title="Waiting to join"
          footer={
            pendingError !== null ? (
              <FormAlert error={pendingError} copy={PENDING_COPY} />
            ) : undefined
          }
        >
          {invitations.map((invitation) => {
            // What `revoke` and `regenerate` accept from this viewer: the
            // owner, any invitation; a contractor, the ones they sent. An
            // older backend sends neither flag, so only the owner is
            // offered them there — the one caller every backend accepts.
            const canCancel = invitation.canManage ?? viewerIsOwner
            const canReissue =
              invitation.canReissue ??
              (viewerIsOwner && invitation.role !== 'owner')
            return (
              <SettingsRow
                key={invitation._id}
                icon={Mail}
                tint="grey"
                title={invitation.email}
                // The role on offer, so a contractor link sent in error can
                // be seen, and cancelled, before it is used.
                subtitle={`${ROLE_LABEL[invitation.role]} · ${expiryLabel(invitation.expiresAt, invitation.state)}`}
              >
                {canReissue && (
                  <button
                    type="button"
                    aria-label={`New link for ${invitation.email}`}
                    disabled={regenerate.isPending || !hydrated}
                    onClick={() =>
                      regenerate.mutate({
                        businessId,
                        invitationId: invitation._id,
                        email: invitation.email,
                      })
                    }
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted transition active:scale-[.95] disabled:opacity-50"
                  >
                    <RefreshCw size={15} strokeWidth={2} />
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    aria-label={`Cancel invitation for ${invitation.email}`}
                    disabled={revoke.isPending || !hydrated}
                    onClick={() =>
                      revoke.mutate({
                        businessId,
                        invitationId: invitation._id,
                      })
                    }
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted transition active:scale-[.95] disabled:opacity-50"
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                )}
              </SettingsRow>
            )
          })}
        </SettingsGroup>
      )}

      <Sheet
        open={inviteOpen}
        onClose={closeSheet}
        // A contractor's invitee joins their team (`joinsUnder`); the
        // owner's answers to the owner.
        title={viewerIsOwner ? 'Invite someone' : 'Invite someone to your team'}
      >
        {/* Clear of the home indicator: this sheet has no footer, because
            the form's own submit has to be inside it — a fix in the
            warnings list hands focus back to the form's submit button. */}
        <div className="pb-[calc(8px+env(safe-area-inset-bottom))] pt-1">
          {freshLink ? (
            <>
              <InviteLinkCard
                email={freshLink.email}
                url={freshLink.url}
                businessName={business?.name}
                inviterName={viewer ? memberName(viewer) : undefined}
              />
              <button
                type="button"
                onClick={closeSheet}
                className="mt-4 h-12 w-full rounded-xl bg-surface-2 text-[17px] font-semibold text-ink transition active:scale-[.975]"
              >
                Done
              </button>
            </>
          ) : (
            /* The link only works for this exact address, so a slip here
               ("gmial") mints a link nobody can use. A near miss, or a
               domain that takes no mail, asks once, with the fix; the
               second press creates it as typed. */
            <SaveWarningsProvider value={warnings}>
              <form
                className="flex flex-col gap-1.5"
                onSubmit={(e) =>
                  warnings.guard(e, () =>
                    invite.mutateAsync({
                      businessId,
                      email: latestEmail.current,
                      role: viewerIsOwner
                        ? latestRole.current
                        : 'subcontractor',
                    }),
                  )
                }
              >
                {viewerIsOwner && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    <span className={FIELD_LABEL}>Joins as</span>
                    <Segmented
                      label="Joins as"
                      value={inviteRole}
                      options={INVITE_ROLE_OPTIONS}
                      onChange={setInviteRole}
                      disabled={!hydrated}
                    />
                    <p className="text-caption text-muted" aria-live="polite">
                      {INVITE_ROLE_HINT[inviteRole]}
                    </p>
                  </div>
                )}
                <label htmlFor={emailId} className={FIELD_LABEL}>
                  Email address
                </label>
                <EmailInput
                  id={emailId}
                  value={email}
                  onChange={setEmail}
                  required
                  placeholder="kevin@example.com"
                />
                <p className="text-caption text-muted">
                  You'll get a link to text them. It works once, expires in 3
                  days, and only that email address can use it.
                  {/* Redeeming a contractor's link puts the new member on
                      that contractor's team (`joinsUnder`). */}
                  {!viewerIsOwner && ' They join your team.'}
                </p>
                <SaveWarningsPanel className="mt-1" />
                <FormAlert
                  error={invite.isError ? invite.error : null}
                  copy={INVITE_COPY}
                  className="mt-1"
                />
                <button
                  type="submit"
                  disabled={invite.isPending || !hydrated}
                  className="mt-2 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
                >
                  {/* "Save anyway" when warned, not "Create anyway": it is
                      what the list above tells them to press. */}
                  {invite.isPending
                    ? 'Creating…'
                    : warnings.saveLabel('Create link')}
                </button>
              </form>
            </SaveWarningsProvider>
          )}
        </div>
      </Sheet>
    </>
  )
}

/** The owner first — the account the business is held by — then everyone
 * else in the order they joined. */
function ownersFirst(members: Array<Member>): Array<Member> {
  return [
    ...members.filter((m) => m.role === 'owner'),
    ...members.filter((m) => m.role !== 'owner'),
  ]
}

/**
 * A row's line under the name: their role, and their licence number. For a
 * contractor, "Your team" on the people they run, second so it survives the
 * truncation — it is why some rows open onto controls and others do not.
 */
function subtitleFor(
  member: Member,
  viewer: { membershipId: Id<'memberships'>; role: Role },
): string {
  const parts = [ROLE_LABEL[member.role]]
  if (
    viewer.role !== 'owner' &&
    member.parentMembershipId === viewer.membershipId
  ) {
    parts.push('Your team')
  }
  if (member.licenceNumber) parts.push(`Licence ${member.licenceNumber}`)
  return parts.join(' · ')
}

/** A person as a coloured initial — theirs, in their schedule colour, as the
 * view menu draws them. */
function Initial({ name, colour }: { name: string; colour: string }) {
  return (
    <span
      aria-hidden
      className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
      style={{ backgroundColor: colour }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * An invitation as this screen reads it. The permission flags are optional
 * because this build can meet a backend from before they existed — the two
 * deploy separately (CLAUDE.md) — and absent has to be handled, not assumed.
 */
type PendingInvitation = Omit<
  FunctionReturnType<typeof api.invitations.listForBusiness>[number],
  'canManage' | 'canReissue' | 'invitedByMembershipId'
> & {
  canManage?: boolean
  canReissue?: boolean
  invitedByMembershipId?: Id<'memberships'>
}

type InviteRole = 'subcontractor' | 'contractor'

const INVITE_ROLE_OPTIONS: Array<{ value: InviteRole; label: string }> = [
  { value: 'subcontractor', label: 'Subcontractor' },
  { value: 'contractor', label: 'Contractor' },
]

/** What each role means in practice, said where it is chosen. */
const INVITE_ROLE_HINT: Record<InviteRole, string> = {
  subcontractor: 'Sees your client list and the jobs you give them.',
  contractor:
    'Runs a team of their own under you: invites subcontractors to it, and manages your client list.',
}

/** The invite's own words for describeError: it creates, it does not save. */
const INVITE_COPY = {
  ALREADY_MEMBER: "They're already on your team.",
  INVALID_EMAIL: 'Check that email address.',
  OWNER_INVITE_FORBIDDEN: 'Owner access cannot be invited.',
  offline:
    'Could not create the invite: this device is offline. Try again when you have signal.',
  default: 'Could not create the invite. Check your connection and try again.',
}

/** A new link or a cancel on a waiting invite, when it did not go through. */
const PENDING_COPY = {
  ALREADY_MEMBER: 'They have already joined with that invitation.',
  NOT_FOUND: 'That invitation is no longer open.',
  offline:
    'Could not change the invitation: this device is offline. Try again when you have signal.',
  default:
    'Could not change the invitation. Check your connection and try again.',
}

function expiryLabel(expiresAt: number | undefined, state: string) {
  if (state === 'legacy') return 'Old invitation — create a new link'
  if (expiresAt === undefined) return 'No expiry recorded'
  const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'Expires today'
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}
