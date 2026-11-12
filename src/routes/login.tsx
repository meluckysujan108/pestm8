import { useId, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { OutboxOnPhoneLine } from '#/components/auth/OutboxOnPhoneLine'
import { SecondStepForm } from '#/components/auth/SecondStepForm'
import { InstallLink } from '#/components/install/InstallLink'
import { authClient, needsSecondStep } from '#/lib/auth-client'
import { useOnPhoneLine } from '#/lib/outbox/useOnPhone'
import { forgetCachedPages } from '#/lib/rootState'
import { safeNext } from '#/lib/twoStep'
import { useHydrated } from '#/lib/useHydrated'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'

export const Route = createFileRoute('/login')({
  // Where to go once signed in: the page that sent them here
  // (`$businessSlug/route.tsx`), so a link into the app survives a sign-in.
  validateSearch: z.object({ next: z.string().optional() }),
  component: LoginPage,
})

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
  const { next } = Route.useSearch()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // The password was right and the account has two-step sign-in: the code
  // step replaces the form in place (see src/lib/auth-client.ts for why this
  // is not a redirect).
  const [secondStep, setSecondStep] = useState(false)
  // Whose jobs not sent yet are on this phone (`OutboxOnPhoneLine`), which
  // the button names for a screen reader while it shows.
  const onPhone = useOnPhoneLine()
  const onPhoneId = useId()

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const result = await authClient.signIn.email({ email, password }).catch(
      // A dropped connection rejects rather than answering, and without this
      // the button sits on "Signing in…" for good.
      () => ({ error: { message: 'Could not reach PestM8. Try again.' } }),
    )

    if (result.error) {
      setPending(false)
      setError(
        result.error.message ??
          'Could not sign in. Check your signal and try again.',
      )
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
    //
    // To `next` when the app sent them here from a page, and only ever a
    // path on this site (`safeNext`): a sign-in form is exactly where an
    // open redirect gets used for phishing. Otherwise `/`, which finds their
    // business.
    await forgetCachedPages()
    window.location.replace(safeNext(next))
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <div className="mb-8">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">
          {secondStep ? 'Two-step sign-in' : 'Sign in'}
        </h1>
        {/* Whose jobs not sent yet are on this phone, if any: signing in as
            anyone else discards them. Under the title, where it is seen
            on the smallest phone, over the line saying what PestM8 is,
            which gives way to it, keeping its room, so nothing moves. */}
        <div className="relative mt-2">
          <p
            className={
              onPhone === null
                ? 'text-body text-muted'
                : 'invisible text-body text-muted'
            }
          >
            Scheduling and compliance reporting for Australian pest control.
          </p>
          <OutboxOnPhoneLine line={onPhone} id={onPhoneId} over />
        </div>
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

          {error && <FormAlert>{error}</FormAlert>}

          <button
            type="submit"
            disabled={pending || !hydrated}
            aria-describedby={onPhone === null ? undefined : onPhoneId}
            className={`${PRIMARY_BUTTON} mt-2`}
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
          <Link
            to="/forgot-password"
            search={{ email: email.trim() || undefined }}
            className="flex min-h-11 items-center justify-center text-body text-blue"
          >
            Forgot password?
          </Link>
          <InstallLink />
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
        className={FIELD}
      />
    </label>
  )
}
