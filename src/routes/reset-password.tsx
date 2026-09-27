import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { authClient } from '#/lib/auth-client'
import { useHydrated } from '#/lib/useHydrated'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'

export const Route = createFileRoute('/reset-password')({
  validateSearch: z.object({ token: z.string().optional() }),
  component: ResetPasswordPage,
})

/** Better Auth's refusals, in this app's words. */
function describeResetError(error: {
  code?: string
  status?: number
  message?: string
}): { text: string; linkGone?: boolean } {
  switch (error.code) {
    case 'INVALID_TOKEN':
      return {
        text: 'This link has expired or has already been used.',
        linkGone: true,
      }
    case 'PASSWORD_COMPROMISED':
      return {
        text: 'That password has turned up in a data breach, so it isn’t safe to use. Choose a different one.',
      }
    case 'PASSWORD_TOO_SHORT':
      return { text: 'Use at least 10 characters.' }
    case 'PASSWORD_TOO_LONG':
      return { text: 'That password is too long. Use a shorter one.' }
  }
  if (error.status === 429) {
    return {
      text: 'Too many tries from this device. Wait a few minutes, then try again.',
    }
  }
  return {
    text: 'Could not change your password. Check your signal and try again.',
  }
}

/**
 * Where a reset email's link lands (`/reset-password?token=…`, built in
 * convex/accountEmails.ts). Choosing a new password here signs the account
 * out everywhere (`revokeSessionsOnPasswordReset`), so it ends at sign-in —
 * where two-step sign-in, if the account has it, still asks for a code.
 */
function ResetPasswordPage() {
  const hydrated = useHydrated()
  const { token } = Route.useSearch()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [linkGone, setLinkGone] = useState(!token)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!token) return
    setError(null)
    if (password !== confirm) {
      setError('The two passwords don’t match.')
      return
    }
    setPending(true)
    const result = await authClient
      .resetPassword({ newPassword: password, token })
      .catch(() => ({
        error: { status: 0, code: undefined, message: undefined },
      }))
    setPending(false)
    if (result.error) {
      const said = describeResetError(result.error)
      if (said.linkGone) setLinkGone(true)
      else setError(said.text)
      return
    }
    setDone(true)
  }

  const heading = done
    ? 'Password changed'
    : linkGone
      ? 'This link can’t be used'
      : 'Choose a new password'
  const lead = done
    ? 'Every device was signed out. Sign in with your new password.'
    : linkGone
      ? token
        ? 'Reset links work once, for 1 hour. Ask for a new one and use the newest email.'
        : 'This link is missing part of its address. Ask for a new one.'
      : 'At least 10 characters. A few words together is easy to remember and hard to guess.'

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <div className="mb-8">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">{heading}</h1>
        <p className="mt-2 text-body text-muted">{lead}</p>
      </div>

      {done ? (
        <Link to="/login" className={PRIMARY_BUTTON}>
          Sign in
        </Link>
      ) : linkGone ? (
        <Link to="/forgot-password" className={PRIMARY_BUTTON}>
          Send a new link
        </Link>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="New password" value={password} onChange={setPassword} />
          <Field
            label="New password again"
            value={confirm}
            onChange={setConfirm}
          />

          {error && <FormAlert>{error}</FormAlert>}

          <button
            type="submit"
            disabled={pending || !hydrated}
            className={`${PRIMARY_BUTTON} mt-2`}
          >
            {pending ? 'Saving…' : 'Save new password'}
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
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      <input
        type="password"
        value={value}
        required
        minLength={10}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
        className={FIELD}
      />
    </label>
  )
}
