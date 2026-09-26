import { useState } from 'react'
import { SecondStepForm } from '#/components/auth/SecondStepForm'
import { authClient, needsSecondStep } from '#/lib/auth-client'
import { couldBeInvitee } from '#/lib/inviteEmail'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'

type Mode = 'signUp' | 'signIn'

/**
 * Creating an account, or signing in to one, on the way to accepting an
 * invitation — to join a team (`/join/$token`) or to start a business
 * (`/start/$token`). The token travels with sign-up because on an
 * invitation-only deployment it is what permits the account at all
 * (convex/auth.ts), whichever kind of link it came from.
 *
 * `onAuthed` fires once someone is signed in, second step and all; accepting
 * is the page's to do, with its own action.
 */
export function InviteAuthForm({
  emailHint,
  token,
  onAuthed,
  disabled,
  submitLabels = { signUp: 'Create account & join', signIn: 'Sign in & join' },
  initialMode = 'signUp',
}: {
  emailHint: string
  /** Sent with sign-up: on an invite-only deployment it is what permits the
   * account to be created at all. */
  token: string
  onAuthed: () => void
  disabled: boolean
  /** What the button says in each mode: what signing up here leads to. */
  submitLabels?: { signUp: string; signIn: string }
  /** Sign in first, for a link that can only be carried on, not used anew. */
  initialMode?: Mode
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // An existing account with two-step sign-in: the code, in place.
  const [secondStep, setSecondStep] = useState(false)

  // A new account on any other address is refused by the server; a sign-in
  // to one is let through, and the page then says whose link this is.
  const wrongAddress = `This link was sent to ${emailHint || 'a different address'}. Create your account with that address.`

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (mode === 'signUp' && !couldBeInvitee(email, emailHint)) {
      setError(wrongAddress)
      return
    }
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
        } else if (result.error.code === 'INVITE_EMAIL_MISMATCH') {
          // A live link and the wrong address, which the check above missed
          // (the mask cannot tell every address apart). Not "the link is not
          // valid", which sends people after a new link.
          setError(wrongAddress)
        } else {
          setError(result.error.message ?? 'Something went wrong.')
        }
        return
      }
      if (needsSecondStep(result.data)) {
        setPassword('')
        setSecondStep(true)
        return
      }
      onAuthed()
    } catch {
      setError("Couldn't reach PestM8. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }

  if (secondStep) {
    return (
      <div className="mt-6">
        <SecondStepForm
          disabled={disabled}
          onVerified={onAuthed}
          onRestart={(message) => {
            setSecondStep(false)
            setError(message)
          }}
        />
      </div>
    )
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
        hint={
          emailHint
            ? `Use ${emailHint} — the address this invitation was sent to.`
            : undefined
        }
      />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
        minLength={mode === 'signUp' ? 10 : undefined}
        hint={mode === 'signUp' ? 'At least 10 characters.' : undefined}
      />

      {error && <Alert>{error}</Alert>}

      <button
        type="submit"
        disabled={pending || disabled}
        className={`${PRIMARY_BUTTON} mt-2`}
      >
        {pending
          ? 'Just a moment…'
          : mode === 'signUp'
            ? submitLabels.signUp
            : submitLabels.signIn}
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
        className={FIELD}
      />
      {hint && <span className="text-caption text-muted">{hint}</span>}
    </label>
  )
}
