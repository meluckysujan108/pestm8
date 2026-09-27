import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { authClient } from '#/lib/auth-client'
import { useHydrated } from '#/lib/useHydrated'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'

export const Route = createFileRoute('/forgot-password')({
  // The address already typed on the sign-in page, so it isn't typed twice.
  validateSearch: z.object({ email: z.string().optional() }),
  component: ForgotPasswordPage,
})

/**
 * "Forgot password?" — asks for a reset link by email (convex/auth.ts
 * `sendResetPassword`, sent from noreply@ by convex/accountEmails.ts).
 *
 * The answer is the same whether or not the address has an account, so this
 * page never tells a stranger who uses PestM8: it always says "if an account
 * uses that address".
 */
function ForgotPasswordPage() {
  const hydrated = useHydrated()
  const search = Route.useSearch()
  const [email, setEmail] = useState(search.email ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const address = email.trim()
    const result = await authClient
      .requestPasswordReset({ email: address })
      .catch(() => ({
        error: { status: 0, message: undefined as string | undefined },
      }))
    setPending(false)
    if (result.error) {
      setError(
        result.error.status === 429
          ? 'Too many tries from this device. Wait a few minutes, then try again.'
          : 'Could not send the link. Check your signal and try again.',
      )
      return
    }
    setSentTo(address)
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <div className="mb-8">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">
          {sentTo ? 'Check your email' : 'Reset your password'}
        </h1>
        <p className="mt-2 text-body text-muted">
          {sentTo
            ? `If an account uses ${sentTo}, we’ve emailed it a link to choose a new password. The link works for 1 hour.`
            : 'Enter the email you sign in with, and we’ll email you a link to choose a new password.'}
        </p>
      </div>

      {sentTo ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-muted">
            Nothing there? Check your junk folder. You can ask for another link
            in 2 minutes.
          </p>
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="min-h-11 self-start text-body text-blue"
          >
            Send another link
          </button>
          <Link
            to="/login"
            className="flex min-h-11 items-center self-start text-body text-blue"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="section-label">Email</span>
            <input
              type="email"
              value={email}
              required
              autoComplete="email"
              enterKeyHint="send"
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD}
            />
          </label>

          {error && <FormAlert>{error}</FormAlert>}

          <button
            type="submit"
            disabled={pending || !hydrated}
            className={`${PRIMARY_BUTTON} mt-2`}
          >
            {pending ? 'Sending…' : 'Send reset link'}
          </button>
          <Link
            to="/login"
            className="flex min-h-11 items-center justify-center text-body text-blue"
          >
            Back to sign in
          </Link>
        </form>
      )}
    </main>
  )
}
