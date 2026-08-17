import { useEffect, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Mail, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { MemberAccessRow } from './MemberAccessRow'
import type { Id } from '../../../convex/_generated/dataModel'

export function TeamSection({ businessId }: { businessId: Id<'businesses'> }) {
  const { data: members } = useSuspenseQuery(
    convexQuery(api.memberships.listForBusiness, { businessId }),
  )
  const { data: invitations } = useSuspenseQuery(
    convexQuery(api.memberships.listInvitations, { businessId }),
  )

  const [email, setEmail] = useState('')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  const convexInvite = useConvexMutation(api.memberships.inviteByEmail)
  const invite = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      email: string
      role: 'owner' | 'subcontractor'
    }) => convexInvite(args),
    onSuccess: () => setEmail(''),
  })

  const convexRevoke = useConvexMutation(api.memberships.revokeInvitation)
  const revoke = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      invitationId: Id<'invitations'>
    }) => convexRevoke(args),
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
          />
        ))}
      </div>

      <h2 className="section-label mb-2 mt-6">Invite a subcontractor</h2>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          invite.mutate({ businessId, email, role: 'subcontractor' })
        }}
      >
        <label className="flex-1">
          <span className="sr-only">Email address</span>
          <input
            type="email"
            value={email}
            required
            placeholder="kevin@example.com"
            onChange={(e) => setEmail(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>
        <button
          type="submit"
          disabled={invite.isPending || !hydrated}
          className="h-12 shrink-0 rounded-xl bg-red px-4 text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {invite.isPending ? 'Sending…' : 'Invite'}
        </button>
      </form>

      <p className="mt-2 text-caption text-muted">
        They join by signing in with this address. New members start with access
        to their own jobs only.
      </p>

      {invitations.length > 0 && (
        <>
          <h3 className="section-label mb-2 mt-6">Pending</h3>
          <div className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <div
                key={invitation._id}
                className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
              >
                <Mail size={17} strokeWidth={1.7} className="text-muted" />
                <span className="min-w-0 flex-1 truncate text-body text-ink">
                  {invitation.email}
                </span>
                <button
                  type="button"
                  aria-label={`Revoke invitation for ${invitation.email}`}
                  onClick={() =>
                    revoke.mutate({ businessId, invitationId: invitation._id })
                  }
                  className="flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted transition active:scale-[.95]"
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
          sham-contracting law penalises, so those features are absent by
          design — not missing.
        </p>
      </div>
    </>
  )
}
