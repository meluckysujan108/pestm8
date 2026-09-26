import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useConvexAction } from '@convex-dev/react-query'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../convex/_generated/api'
import { InviteAuthForm } from '#/components/auth/InviteAuthForm'
import { authClient } from '#/lib/auth-client'
import { couldBeInvitee } from '#/lib/inviteEmail'
import { beginSignOut, forgetCachedPages } from '#/lib/rootState'
import { isMfaEnrolmentError } from '#/lib/twoStep'
import { useHydrated } from '#/lib/useHydrated'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * Accepting an invitation.
 *
 * The link is the credential, so this page is reachable signed out — that is
 * the point. It deliberately shows very little before anyone proves who they
 * are: the business name and a masked address, enough for the invitee to
 * recognise their own invitation and no more, because a link shared over SMS
 * ends up in group chats and on lock screens.
 *
 * The email is not pre-filled. Only a masked hint ever leaves the server, so
 * whoever opens a forwarded link cannot learn the invited address from it.
 */

export const Route = createFileRoute('/join/$token')({ component: JoinPage })

function JoinPage() {
  const { token } = Route.useParams()
  const router = useRouter()
  const hydrated = useHydrated()

  const preview = useConvexAction(api.invitations.preview)
  const convexRedeem = useConvexAction(api.invitations.redeem)

  const invite = useQuery({
    queryKey: ['invitePreview', token],
    queryFn: () => preview({ token }),
    retry: false,
  })

  const { data: session } = authClient.useSession()
  const signedInEmail = session?.user.email ?? null
  const emailHint = invite.data?.emailHint ?? ''
  // Signed in to an account this invitation cannot be for: accepting would
  // only be refused (INVITE_EMAIL_MISMATCH), so the page says so instead.
  const wrongAccount =
    signedInEmail !== null && !couldBeInvitee(signedInEmail, emailHint)

  const redeem = useMutation({
    mutationFn: () => convexRedeem({ token }),
    // Joining comes after two-step sign-in is set up, never before (the
    // server refuses it: convex/lib/access.ts). A brand-new account lands
    // here straight from sign-up, so this is the usual first visit to the
    // set-up screen — which comes back to this link when it is done.
    onError: async (error) => {
      if (!isMfaEnrolmentError(error)) return
      await router.navigate({
        to: '/two-step',
        search: { next: `/join/${token}` },
        replace: true,
      })
    },
    // Joined: a minute of welcome — their licence number, the Home Screen —
    // then their jobs (src/routes/welcome.tsx).
    onSuccess: async ({ slug }) => {
      await router.invalidate()
      await router.navigate({
        to: '/welcome',
        search: { business: slug },
        replace: true,
      })
    },
  })

  // Signing in or signing up is only ever a step towards accepting, so the
  // accept follows automatically rather than leaving someone on a page that
  // looks like it did nothing.
  const [justAuthed, setJustAuthed] = useState(false)
  useEffect(() => {
    if (justAuthed && signedInEmail && !redeem.isPending && !redeem.isSuccess) {
      setJustAuthed(false)
      if (!wrongAccount) redeem.mutate()
    }
  }, [justAuthed, signedInEmail, wrongAccount, redeem])

  if (invite.isPending) {
    return <Shell title="Checking your invitation…" />
  }

  const state = invite.data?.state ?? 'invalid'
  if (state !== 'valid') {
    return (
      <Shell title={DEAD_TITLE[state] ?? 'This invitation is not valid'}>
        <p className="mt-2 text-body text-muted">
          Ask whoever invited you to send a new link.
        </p>
      </Shell>
    )
  }

  const businessName = invite.data?.businessName ?? 'this business'
  const roleLabel = (invite.data?.roleLabel ?? 'Team member').toLowerCase()

  return (
    <Shell title={`Join ${businessName}`}>
      <p className="mt-2 text-body text-muted">
        You’ve been invited as a {roleLabel}. This link works once, and only for{' '}
        <span className="text-ink">{emailHint}</span>.
      </p>

      {redeem.isError && !isMfaEnrolmentError(redeem.error) && (
        <FormAlert>{redeemMessage(redeem.error, emailHint)}</FormAlert>
      )}

      {signedInEmail && wrongAccount ? (
        <div className="mt-6">
          <p className="text-body text-ink-2">
            You’re signed in as{' '}
            <span className="text-ink">{signedInEmail}</span>, but this
            invitation is for <span className="text-ink">{emailHint}</span>.
            Sign out, then carry on with that address.
          </p>
          <button
            type="button"
            disabled={!hydrated}
            onClick={signOutAndReload}
            className={`${PRIMARY_BUTTON} mt-4 w-full`}
          >
            Sign out
          </button>
        </div>
      ) : signedInEmail ? (
        <div className="mt-6">
          <p className="text-body text-ink-2">
            Signed in as <span className="text-ink">{signedInEmail}</span>
          </p>
          <button
            type="button"
            disabled={redeem.isPending || !hydrated}
            onClick={() => redeem.mutate()}
            className={`${PRIMARY_BUTTON} mt-3 w-full`}
          >
            {redeem.isPending ? 'Joining…' : `Join ${businessName}`}
          </button>
          <button
            type="button"
            onClick={signOutAndReload}
            className="mt-4 w-full text-body text-blue"
          >
            Not you? Sign out
          </button>
        </div>
      ) : (
        <InviteAuthForm
          emailHint={emailHint}
          token={token}
          onAuthed={() => setJustAuthed(true)}
          disabled={!hydrated}
        />
      )}

      <p className="mt-8 text-caption leading-relaxed text-muted">
        Once you join, the business can see the jobs booked for you and the work
        recorded against them. PestM8 has no timesheets, rosters or hour
        tracking — those are absent by design.
      </p>
    </Shell>
  )
}

/**
 * A reload, as Settings' sign-out does, rather than invalidating: the query
 * cache is keyed by business, not by person, so the account signing in next
 * would otherwise be shown the previous one's cached answers until Convex
 * re-pushed them.
 */
function signOutAndReload() {
  // Before the request (rootState.ts has why).
  beginSignOut()
  void authClient
    .signOut()
    .then(forgetCachedPages)
    .then(() => window.location.reload())
}

const DEAD_TITLE: Record<string, string> = {
  claimed: 'This invitation has already been used',
  expired: 'This invitation has expired',
  revoked: 'This invitation was withdrawn',
  legacy: 'This invitation is no longer valid',
  invalid: 'This invitation is not valid',
}

function redeemMessage(error: unknown, emailHint: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('INVITE_EMAIL_MISMATCH')) {
    return `This invitation was sent to ${emailHint}. Sign out, then carry on with that address.`
  }
  if (message.includes('ALREADY_MEMBER')) return 'You’re already on this team.'
  if (message.includes('INVITE_ALREADY_USED')) {
    return 'This link has already been used.'
  }
  if (message.includes('INVITE_EXPIRED')) return 'This link has expired.'
  if (message.includes('INVITE_REVOKED')) return 'This link was withdrawn.'
  return 'Could not join. Check your signal and try again.'
}

function Shell({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <p className="section-label mb-2">PestM8</p>
      <h1 className="text-page-title text-ink">{title}</h1>
      {children}
    </main>
  )
}
