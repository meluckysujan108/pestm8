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
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { MemberAccessRow } from './MemberAccessRow'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Role } from '../../../convex/lib/capabilities'
import { useHydrated } from '#/lib/useHydrated'
import { rq } from '#/lib/routeQueries'

/**
 * Inviting used to mean recording an email address and hoping. The button said
 * "Sending…", nothing was ever sent, and whoever registered that address first
 * — invitee or not — was let into the business.
 *
 * Now inviting mints a single-use link. The owner shares it themselves, by the
 * channel they already use with their crew: a text message. The link is shown
 * exactly once, because only its hash is stored.
 */
export function TeamSection({ businessId }: { businessId: Id<'businesses'> }) {
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
    },
  })

  return (
    <>
      <h2 className="section-label mb-2">Team</h2>
      <div className="flex flex-col gap-2">
        {members.map((member) => (
          <MemberAccessRow
            key={member._id}
            businessId={businessId}
            member={member}
            others={members.filter(
              (m) => m._id !== member._id && m.status === 'active',
            )}
          />
        ))}
      </div>

      <h2 className="section-label mb-2 mt-6">Invite a subcontractor</h2>
      {/* The link only works for this exact address, so a slip here ("gmial")
          mints a link nobody can use. A near miss, or a domain that takes no
          mail, asks once, with the fix; the second press creates it as
          typed. */}
      <SaveWarningsProvider value={warnings}>
        <form
          onSubmit={(e) =>
            warnings.guard(e, () =>
              invite.mutateAsync({ businessId, email, role: 'subcontractor' }),
            )
          }
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={emailId} className="sr-only">
                Email address
              </label>
              <EmailInput
                id={emailId}
                value={email}
                onChange={setEmail}
                required
                placeholder="kevin@example.com"
              />
            </div>
            <button
              type="submit"
              disabled={invite.isPending || !hydrated}
              className="h-12 shrink-0 rounded-xl bg-red px-4 text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
            >
              {/* "Save anyway" when warned, not "Create anyway": it is
                  what the list above tells them to press. */}
              {invite.isPending
                ? 'Creating…'
                : warnings.saveLabel('Create link')}
            </button>
          </div>
          <SaveWarningsPanel className="mt-2" />
        </form>
      </SaveWarningsProvider>

      <FormAlert
        error={invite.isError ? invite.error : null}
        copy={INVITE_COPY}
        className="mt-2"
      />

      {freshLink ? (
        <InviteLinkCard
          email={freshLink.email}
          url={freshLink.url}
          onDone={() => setFreshLink(null)}
        />
      ) : (
        <p className="mt-2 text-caption text-muted">
          You'll get a link to text them. It works once, expires in 3 days, and
          only that email address can use it.
        </p>
      )}

      {invitations.length > 0 && (
        <>
          <h3 className="section-label mb-2 mt-6">Waiting to join</h3>
          <div className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <div
                key={invitation._id}
                className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
              >
                <Mail size={17} strokeWidth={1.7} className="text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">
                    {invitation.email}
                  </span>
                  <span className="block text-caption text-muted">
                    {expiryLabel(invitation.expiresAt, invitation.state)}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`New link for ${invitation.email}`}
                  disabled={regenerate.isPending}
                  onClick={() =>
                    regenerate.mutate({
                      businessId,
                      invitationId: invitation._id,
                      email: invitation.email,
                    })
                  }
                  className="flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted transition active:scale-[.95] disabled:opacity-50"
                >
                  <RefreshCw size={15} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  aria-label={`Cancel invitation for ${invitation.email}`}
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate({ businessId, invitationId: invitation._id })
                  }
                  className="flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted transition active:scale-[.95] disabled:opacity-50"
                >
                  <X size={15} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Stated in the product, not just the marketing: their absence is a
          designed property, and the reason is worth the owner knowing (§1.4). */}
      <div className="mt-6 rounded-2xl bg-surface-2 p-3.5">
        <p className="text-caption leading-relaxed text-ink-2">
          PestM8 deliberately has no timesheets, rosters or hour tracking.
          Treating an independent contractor like a rostered employee is what
          sham-contracting law penalises, so those features are absent by design
          — not missing.
        </p>
      </div>
    </>
  )
}

/**
 * Shown once, immediately after the link is minted. There is no "copy it
 * later": the server keeps only a hash, so a lost link is replaced rather
 * than looked up.
 */
function InviteLinkCard({
  email,
  url,
  onDone,
}: {
  email: string
  url: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator

  const smsBody = `Here's your PestM8 invite: ${url}`

  return (
    <div className="mt-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <p className="text-row-title text-ink">Send this to {email}</p>
      <p className="mt-1 text-caption text-muted">
        Shown once. Works for 3 days, for that address only.
      </p>

      <p className="mt-3 truncate rounded-xl bg-surface-2 px-3 py-2 font-mono text-caption text-ink-2">
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

      <button
        type="button"
        onClick={onDone}
        className="mt-3 h-9 w-full text-caption font-semibold text-blue"
      >
        Done
      </button>
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

function expiryLabel(expiresAt: number | undefined, state: string) {
  if (state === 'legacy') return 'Old invitation — create a new link'
  if (expiresAt === undefined) return 'No expiry recorded'
  const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'Expires today'
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}
