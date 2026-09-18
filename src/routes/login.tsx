import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { authClient } from '#/lib/auth-client'
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

  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const result = await authClient.signIn.email({ email, password })

    setPending(false)

    if (result.error) {
      setError(result.error.message ?? 'Something went wrong.')
      return
    }

    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <div className="mb-8">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">Sign in</h1>
        <p className="mt-2 text-body text-muted">
          Scheduling and compliance reporting for Australian pest control.
        </p>
      </div>

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
