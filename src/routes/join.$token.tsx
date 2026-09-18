import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useConvexAction } from '@convex-dev/react-query'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../convex/_generated/api'
import { authClient } from '#/lib/auth-client'
import { useHydrated } from '#/lib/useHydrated'

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

type Mode = 'signUp' | 'signIn'

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

  const redeem = useMutation({
    mutationFn: () => convexRedeem({ token }),
    onSuccess: async ({ slug }) => {
      await router.invalidate()
      await router.navigate({
        to: '/$businessSlug/schedule',
        params: { businessSlug: slug },
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
      redeem.mutate()
    }
  }, [justAuthed, signedInEmail, redeem])

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
  const emailHint = invite.data?.emailHint ?? ''

  return (
    <Shell title={`Join ${businessName}`}>
      <p className="mt-2 text-body text-muted">
        You've been invited as a {roleLabel}. This link works once, and only for{' '}
        <span className="text-ink">{emailHint}</span>.
      </p>

      {redeem.isError && (
        <Alert>{redeemMessage(redeem.error, emailHint)}</Alert>
      )}

      {signedInEmail ? (
        <div className="mt-6">
          <p className="text-body text-ink-2">
            Signed in as <span className="text-ink">{signedInEmail}</span>
          </p>
          <button
            type="button"
            disabled={redeem.isPending || !hydrated}
            onClick={() => redeem.mutate()}
            className="mt-3 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
          >
            {redeem.isPending ? 'Joining…' : `Join ${businessName}`}
          </button>
          <button
            type="button"
            onClick={() => authClient.signOut().then(() => router.invalidate())}
            className="mt-4 w-full text-body text-blue"
          >
            Not you? Sign out
          </button>
        </div>
      ) : (
        <JoinForm
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
    return `This invitation was sent to ${emailHint}. Sign out and sign in with that address.`
  }
  if (message.includes('ALREADY_MEMBER')) return "You're already on this team."
  if (message.includes('INVITE_ALREADY_USED')) {
    return 'This link has already been used.'
  }
  if (message.includes('INVITE_EXPIRED')) return 'This link has expired.'
  if (message.includes('INVITE_REVOKED')) return 'This link was withdrawn.'
  return 'Could not join. Check your connection and try again.'
}

function JoinForm({
  emailHint,
  token,
  onAuthed,
  disabled,
}: {
  emailHint: string
  /** Sent with sign-up: on an invite-only deployment it is what permits the
   * account to be created at all. */
  token: string
  onAuthed: () => void
  disabled: boolean
}) {
  const [mode, setMode] = useState<Mode>('signUp')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      const result =
        mode === 'signUp'
          ? await authClient.signUp.email(
              // The invite token travels in the body rather than a header, so
              // it stays out of request logs. Better Auth's sign-up schema is
              // an intersection with a record and accepts unknown keys; the
              // client's types don't model that, hence the cast.
              {
                name,
                email,
                password,
                inviteToken: token,
              } as Parameters<typeof authClient.signUp.email>[0],
            )
          : await authClient.signIn.email({ email, password })

      if (result.error) {
        // "User already exists" is a dead end on an invite page, so it becomes
        // an offer to sign in instead.
        if (result.error.code === 'USER_ALREADY_EXISTS') {
          setMode('signIn')
          setError('That address already has an account — sign in to accept.')
        } else {
          setError(result.error.message ?? 'Something went wrong.')
        }
        return
      }
      onAuthed()
    } catch {
      setError("Couldn't reach PestM8. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
      {mode === 'signUp' && (
        <Field
          label="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
          autoCapitalize="words"
        />
      )}
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        hint={`Use ${emailHint} — the address this invitation was sent to.`}
      />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
        minLength={mode === 'signUp' ? 8 : undefined}
        hint={mode === 'signUp' ? 'At least 8 characters.' : undefined}
      />

      {error && <Alert>{error}</Alert>}

      <button
        type="submit"
        disabled={pending || disabled}
        className="mt-2 h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
      >
        {pending
          ? 'Just a moment…'
          : mode === 'signUp'
            ? 'Create account & join'
            : 'Sign in & join'}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signUp' ? 'signIn' : 'signUp')
          setError(null)
        }}
        className="mt-1 text-body text-blue"
      >
        {mode === 'signUp'
          ? 'Already have an account? Sign in'
          : 'Need an account? Create one'}
      </button>
    </form>
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
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
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
      className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
    >
      {children}
    </p>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  autoCapitalize,
  minLength,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  autoComplete?: string
  autoCapitalize?: string
  minLength?: number
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      <input
        type={type}
        value={value}
        required
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        minLength={minLength}
        enterKeyHint="go"
        onChange={(e) => onChange(e.target.value)}
        className="h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
      />
      {hint && <span className="text-caption text-muted">{hint}</span>}
    </label>
  )
}
