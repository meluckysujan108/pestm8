import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useConvexAction } from '@convex-dev/react-query'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Building2, IdCard, Palette, Users } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { InviteAuthForm } from '#/components/auth/InviteAuthForm'
import { authClient } from '#/lib/auth-client'
import { beginSignOut, forgetCachedPages } from '#/lib/rootState'
import { isMfaEnrolmentError } from '#/lib/twoStep'
import { useHydrated } from '#/lib/useHydrated'
import type { LucideIcon } from 'lucide-react'

/**
 * Starting a business on PestM8, from the link its owner was sent
 * (convex/businessInvites.ts).
 *
 * Reachable signed out — the link is the credential — and, like the team
 * invitation page, it shows almost nothing before anyone proves who they
 * are: whether the link is alive, and a masked address. Creating the account
 * (or signing in to one) then claims the link for that account, and set-up
 * begins. A link already claimed by the account opening it carries on
 * instead of calling itself used, so reopening it on another device works.
 */

export const Route = createFileRoute('/start/$token')({ component: StartPage })

function StartPage() {
  const { token } = Route.useParams()
  const router = useRouter()
  const hydrated = useHydrated()

  const preview = useConvexAction(api.businessInvites.preview)
  const convexClaim = useConvexAction(api.businessInvites.claim)

  const link = useQuery({
    queryKey: ['businessInvitePreview', token],
    queryFn: () => preview({ token }),
    retry: false,
  })

  const { data: session } = authClient.useSession()
  const signedInEmail = session?.user.email ?? null

  const claim = useMutation({
    mutationFn: () => convexClaim({ token }),
    // Set-up comes after two-step sign-in where that is compulsory, as
    // joining does; the set-up screen comes back here when it is done.
    onError: async (error) => {
      if (!isMfaEnrolmentError(error)) return
      await router.navigate({
        to: '/two-step',
        search: { next: `/start/${token}` },
        replace: true,
      })
    },
    onSuccess: async ({ slug }) => {
      await router.invalidate()
      // A business already made with this link: `/` carries on set-up where
      // it was left (on whichever device), or opens the schedule once done.
      await router.navigate({ to: slug ? '/' : '/onboarding', replace: true })
    },
  })

  // Signing up or in is only ever a step towards set-up, so the claim
  // follows by itself rather than leaving a page that seems to do nothing.
  const [justAuthed, setJustAuthed] = useState(false)
  useEffect(() => {
    if (justAuthed && signedInEmail && !claim.isPending && !claim.isSuccess) {
      setJustAuthed(false)
      claim.mutate()
    }
  }, [justAuthed, signedInEmail, claim])

  if (link.isPending) return <Shell title="Checking your link…" />

  const state = link.data?.state ?? 'invalid'
  const emailHint = link.data?.emailHint ?? ''
  // Claimed or used: dead to anyone else, but its own account carries on —
  // which only signing in can tell.
  const taken = state === 'claimed' || state === 'used'

  if (state !== 'valid' && !taken) {
    return (
      <Shell title={DEAD_TITLE[state] ?? DEAD_TITLE.invalid}>
        <p className="mt-2 text-body text-muted">
          Ask whoever sent it for a new link.
        </p>
      </Shell>
    )
  }

  return (
    <Shell title="Set up your business on PestM8">
      <p className="mt-2 text-body text-muted">
        {taken ? (
          emailHint ? (
            <>
              This link has been used. If it was you, sign in with{' '}
              <span className="text-ink">{emailHint}</span> to carry on.
            </>
          ) : (
            'This link has been used. If it was you, sign in to carry on.'
          )
        ) : (
          <>
            Scheduling, service reports and certificates for your pest control
            business. This link works once, and only for{' '}
            <span className="text-ink">{emailHint}</span>.
          </>
        )}
      </p>

      {claim.isError && !isMfaEnrolmentError(claim.error) && (
        <Alert>{claimMessage(claim.error, emailHint)}</Alert>
      )}

      {signedInEmail ? (
        <div className="mt-6">
          <p className="text-body text-ink-2">
            Signed in as <span className="text-ink">{signedInEmail}</span>
          </p>
          <button
            type="button"
            disabled={claim.isPending || !hydrated}
            onClick={() => claim.mutate()}
            className="mt-3 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
          >
            {claim.isPending ? 'Just a moment…' : 'Set up my business'}
          </button>
          <button
            type="button"
            // A reload, as the join page's: the next account must not see
            // this one's cached answers.
            onClick={() => {
              beginSignOut()
              void authClient
                .signOut()
                .then(forgetCachedPages)
                .then(() => window.location.reload())
            }}
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
          initialMode={taken ? 'signIn' : 'signUp'}
          submitLabels={{ signUp: 'Create account', signIn: 'Sign in' }}
        />
      )}

      {!taken && (
        <section className="mt-10">
          <p className="section-label mb-3">About two minutes to set up</p>
          <ul className="space-y-3">
            <Ahead icon={Building2} text="Your business name and ABN" />
            <Ahead icon={Palette} text="Your logo and contact details" />
            <Ahead icon={IdCard} text="Your licence number" />
            <Ahead icon={Users} text="Your team, if you have one" />
          </ul>
        </section>
      )}
    </Shell>
  )
}

const DEAD_TITLE: Record<string, string> = {
  expired: 'This link has expired',
  revoked: 'This link was withdrawn',
  invalid: 'This link is not valid',
}

function claimMessage(error: unknown, emailHint: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('INVITE_EMAIL_MISMATCH')) {
    return `This link was sent to ${emailHint}. Sign out and sign in with that address.`
  }
  if (message.includes('INVITE_ALREADY_USED')) {
    return 'This link has already been used by another account.'
  }
  if (message.includes('INVITE_EXPIRED')) return 'This link has expired.'
  if (message.includes('INVITE_REVOKED')) return 'This link was withdrawn.'
  return 'Could not continue. Check your connection and try again.'
}

function Ahead({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <li className="flex items-center gap-3 text-body text-ink-2">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-2"
      >
        <Icon size={16} strokeWidth={1.9} />
      </span>
      {text}
    </li>
  )
}

function Shell({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6 py-10">
      <p className="section-label mb-2">PestM8</p>
      <h1 className="text-page-title text-ink">{title}</h1>
      {children}
    </main>
  )
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-orange-ink"
    >
      {children}
    </p>
  )
}
