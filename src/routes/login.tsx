import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SecondStepForm } from '#/components/auth/SecondStepForm'
import { authClient, needsSecondStep } from '#/lib/auth-client'
import { forgetCachedPages } from '#/lib/rootState'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/login')({ component: LoginPage })

/**
 * Sign in only. There is deliberately no "create an account" here.
 *
 * PestM8 serves one business and is invite-only: accounts are created by
 * opening an invitation link, which is what `/join/$token` is for — it carries
 * the token the server requires. This page offered a sign-up toggle that called
 * `authClient.signUp.email` with no token, so with `AUTH_INVITE_ONLY=on` every
 * attempt came back "You need an invitation link to create an account." It was
 * an invitation to fail, sitting on the first screen anyone sees.
 *
 * Removing it changes no behaviour — the door it knocked on was already shut,
 * server-side, in `convex/auth.ts`. If a sign-up path ever belongs on this page
 * again, it needs a token to send, not just a form.
 */
function LoginPage() {
  const hydrated = useHydrated()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // The password was right and the account has two-step sign-in: the code
  // step replaces the form in place (see src/lib/auth-client.ts for why this
  // is not a redirect).
  const [secondStep, setSecondStep] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const result = await authClient.signIn.email({ email, password }).catch(
      // A dropped connection rejects rather than answering, and without this
      // the button sits on "Just a moment…" for good.
      () => ({ error: { message: 'Could not reach PestM8. Try again.' } }),
    )

    if (result.error) {
      setPending(false)
      setError(result.error.message ?? 'Something went wrong.')
      return
    }

    if (needsSecondStep(result.data)) {
      setPending(false)
      setPassword('')
      setSecondStep(true)
      return
    }

    await enterApp()
  }

  async function enterApp() {
    // A full load, not a client navigation. This page can be opened over
    // someone else's live session — a shared tablet — and the Convex client
    // keeps the token it was handed for that page load until a refresh swaps
    // it, so the next person's first queries would run as the last one's and
    // put their business in the shell. A document load starts the client, the
    // query cache and the cached sign-in (src/lib/rootState.ts) over for
    // whoever holds the cookie now. `replace`, so Back does not return to a
    // form they have already used. The button stays pending until it lands.
    await forgetCachedPages()
    window.location.replace('/')
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <div className="mb-8">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">
          {secondStep ? 'Two-step sign-in' : 'Sign in'}
        </h1>
        <p className="mt-2 text-body text-muted">
          Scheduling and compliance reporting for Australian pest control.
        </p>
      </div>

      {secondStep ? (
        <SecondStepForm
          disabled={!hydrated}
          onVerified={enterApp}
          onRestart={(message) => {
            setSecondStep(false)
            setError(message)
          }}
        />
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />

          {error && (
            <p
              role="alert"
              className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending || !hydrated}
            className="mt-2 h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
          >
            {pending ? 'Just a moment…' : 'Sign in'}
          </button>
        </form>
      )}
    </main>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  autoComplete?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      <input
        type={type}
        value={value}
        required
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
      />
    </label>
  )
}
