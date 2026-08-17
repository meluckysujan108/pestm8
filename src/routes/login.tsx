import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { authClient } from '#/lib/auth-client'

export const Route = createFileRoute('/login')({ component: LoginPage })

type Mode = 'signIn' | 'signUp'

function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signIn')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // This page is server-rendered, so the form exists before React attaches its
  // submit handler. Submitting in that window does a native GET, reloading the
  // page and clearing what was typed — so stay disabled until hydrated.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const result =
      mode === 'signUp'
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password })

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
        <h1 className="text-page-title text-ink">
          {mode === 'signIn' ? 'Sign in' : 'Create your account'}
        </h1>
        <p className="mt-2 text-body text-muted">
          Scheduling and compliance reporting for Australian pest control.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {mode === 'signUp' && (
          <Field
            label="Full name"
            value={name}
            onChange={setName}
            autoComplete="name"
          />
        )}
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
          autoComplete={
            mode === 'signUp' ? 'new-password' : 'current-password'
          }
        />

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-secondary text-amber-ink"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || !hydrated}
          className="mt-2 h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {pending
            ? 'Just a moment…'
            : mode === 'signIn'
              ? 'Sign in'
              : 'Create account'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signIn' ? 'signUp' : 'signIn')
          setError(null)
        }}
        className="mt-5 text-body text-blue"
      >
        {mode === 'signIn'
          ? 'No account yet? Create one'
          : 'Already have an account? Sign in'}
      </button>
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
