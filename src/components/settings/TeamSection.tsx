import { useId, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useConvexAction, useConvexMutation } from '@convex-dev/react-query'
import { Check, Copy, Mail, RefreshCw, Share2, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { Sheet } from '#/components/primitives/Sheet'
import { ROLE_LABEL, memberName } from './MemberAccessRow'
import {
  FIELD_LABEL,
  RowBadge,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
} from './ui'
import type { Member } from './MemberAccessRow'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Role } from '../../../convex/lib/capabilities'
import { useHydrated } from '#/lib/useHydrated'
import { rq } from '#/lib/routeQueries'

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
  const { data: invitations } = useSuspenseQuery(rq.invitations(businessId))

  const [email, setEmail] = useState('')
  const [freshLink, setFreshLink] = useState<{
    email: string
    url: string
  } | null>(null)

  const hydrated = useHydrated()
  const emailId = useId()
  const warnings = useSaveWarnings()

  const convexCreate = useConvexAction(api.invitations.create)
  const invite = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      email: string
      role: Role
    }) => convexCreate(args),
    onSuccess: ({ url }, variables) => {
      setFreshLink({ email: variables.email, url })
      setEmail('')
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
            subtitle={`${ROLE_LABEL[member.role]}${member.licenceNumber ? ` · Licence ${member.licenceNumber}` : ''}`}
            // Only for something that needs doing: without a number they
            // cannot finalise a regulated report, and nobody finds that out
            // until a certificate will not sign.
            badge={
              member.licenceNumber ? undefined : (
                <RowBadge tone="amber">No licence</RowBadge>
              )
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
          {invitations.map((invitation) => (
            <SettingsRow
              key={invitation._id}
              icon={Mail}
              tint="grey"
              title={invitation.email}
              subtitle={expiryLabel(invitation.expiresAt, invitation.state)}
            >
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
              <button
                type="button"
                aria-label={`Cancel invitation for ${invitation.email}`}
                disabled={revoke.isPending || !hydrated}
                onClick={() =>
                  revoke.mutate({ businessId, invitationId: invitation._id })
                }
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted transition active:scale-[.95] disabled:opacity-50"
              >
                <X size={15} strokeWidth={2} />
              </button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      <Sheet
        open={inviteOpen}
        onClose={closeSheet}
        title="Invite a subcontractor"
      >
        {/* Clear of the home indicator: this sheet has no footer, because
            the form's own submit has to be inside it — a fix in the
            warnings list hands focus back to the form's submit button. */}
        <div className="pb-[calc(8px+env(safe-area-inset-bottom))] pt-1">
          {freshLink ? (
            <>
              <InviteLinkCard email={freshLink.email} url={freshLink.url} />
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
                      role: 'subcontractor',
                    }),
                  )
                }
              >
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
 * Shown once, immediately after the link is minted. There is no "copy it
 * later": the server keeps only a hash, so a lost link is replaced rather
 * than looked up. Done, under it, closes it for good.
 */
function InviteLinkCard({ email, url }: { email: string; url: string }) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator

  const smsBody = `Here's your PestM8 invite: ${url}`

  return (
    <div>
      <p className="text-body font-semibold text-ink">Send this to {email}</p>
      <p className="mt-0.5 text-caption text-muted">
        Shown once. Works for 3 days, for that address only.
      </p>

      <p className="mt-3 truncate rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-caption text-ink-2">
        {url}
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-body font-semibold text-ink transition active:scale-[.975]"
        >
          {copied ? (
            <Check size={16} strokeWidth={2} />
          ) : (
            <Copy size={16} strokeWidth={1.7} />
          )}
          {copied ? 'Copied' : 'Copy link'}
        </button>

        {canShare ? (
          <button
            type="button"
            onClick={() => {
              void navigator.share({ text: smsBody }).catch(() => {})
            }}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-blue text-body font-semibold text-white transition active:scale-[.975]"
          >
            <Share2 size={16} strokeWidth={1.7} />
            Share
          </button>
        ) : (
          <a
            href={`sms:?&body=${encodeURIComponent(smsBody)}`}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-blue text-body font-semibold text-white transition active:scale-[.975]"
          >
            <Share2 size={16} strokeWidth={1.7} />
            Text it
          </a>
        )}
      </div>
    </div>
  )
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
