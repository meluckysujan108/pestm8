import { useEffect, useRef, useState } from 'react'
import { authClient } from '#/lib/auth-client'
import {
  describeTwoFactorError,
  normaliseRecoveryCode,
  normaliseTotpCode,
} from '#/lib/twoStep'

/**
 * The second half of signing in: the six-digit code from the authenticator
 * app, or one of the recovery codes for the day the phone is at the bottom of
 * a dam.
 *
 * Shared by the sign-in page and the invitation page, which both sign people
 * in. Deliberately no "trust this device" box — the server refuses it anyway
 * (convex/auth.ts, `twoFactorPolicy`): every sign-in asks for a code.
 *
 * `onRestart` is for the two ways a code step can die — ten minutes passed,
 * or five wrong codes — both of which need the password again, not another
 * code.
 */
export function SecondStepForm({
  onVerified,
  onRestart,
  disabled = false,
}: {
  onVerified: () => Promise<void> | void
  onRestart: (message: string) => void
  disabled?: boolean
}) {
  const [mode, setMode] = useState<'app' | 'recovery'>('app')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // The auto-submit at six digits and a tap on Continue can land together;
  // state read in either would be a render stale, so the guard is a ref.
  const busy = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Any session cookie already on this device belongs to whoever signed in
   * here last — a shared tablet — and the code check trusts a live session
   * over the pending sign-in, so it would check this person's code against
   * that person's authenticator and fail. The auth proxy passes one cookie per
   * response, so the password step could not clear it and set the challenge
   * at once; it is cleared here instead, while the person is still opening
   * their authenticator. Awaited before the first check.
   */
  const cleared = useRef<Promise<unknown> | null>(null)
  useEffect(() => {
    cleared.current = authClient.signOut().catch(() => undefined)
    inputRef.current?.focus()
  }, [])

  async function submit(value: string) {
    if (busy.current) return
    busy.current = true
    setError(null)
    setPending(true)
    await cleared.current

    const result = await (
      mode === 'app'
        ? authClient.twoFactor.verifyTotp({ code: normaliseTotpCode(value) })
        : authClient.twoFactor.verifyBackupCode({
            code: normaliseRecoveryCode(value),
          })
    ).catch(() => ({
      data: null,
      error: { message: 'Could not reach PestM8. Try again.' },
    }))

    if (result.error) {
      const { message, restart } = describeTwoFactorError(result.error)
      if (restart) {
        onRestart(message)
        return
      }
      busy.current = false
      setPending(false)
      setError(message)
      setCode('')
      inputRef.current?.focus()
      return
    }

    // Stays pending: the caller reloads into the app.
    await onVerified()
  }

  const ready =
    mode === 'app'
      ? normaliseTotpCode(code).length === 6
      : normaliseRecoveryCode(code).length === 11

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit(code)
      }}
      className="flex flex-col gap-3"
    >
      <p className="text-body text-muted">
        {mode === 'app'
          ? 'Open your authenticator app and enter the 6-digit code for PestM8.'
          : 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each one works once.'}
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="section-label">
          {mode === 'app' ? 'Code' : 'Recovery code'}
        </span>
        {mode === 'app' ? (
          <input
            ref={inputRef}
            key="app"
            value={code}
            required
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            enterKeyHint="go"
            maxLength={7}
            onChange={(e) => {
              const next = normaliseTotpCode(e.target.value)
              setCode(next)
              // Six digits is the whole answer, so the keyboard's Go is one
              // tap too many — and iOS AutoFill pastes all six at once.
              if (next.length === 6) void submit(next)
            }}
            className="h-12 rounded-xl bg-surface-3 px-3.5 text-center font-mono text-[22px] tracking-[0.3em] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        ) : (
          <input
            ref={inputRef}
            key="recovery"
            value={code}
            required
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="xxxxx-xxxxx"
            onChange={(e) => setCode(e.target.value)}
            className="h-12 rounded-xl bg-surface-3 px-3.5 font-mono text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        )}
      </label>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-orange-ink"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || disabled || !ready}
        className="mt-2 h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
      >
        {pending ? 'Checking…' : 'Continue'}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'app' ? 'recovery' : 'app')
          setCode('')
          setError(null)
        }}
        // 44 px tall: the way in for someone who has lost their phone, so
        // it must not be the button a thumb misses.
        className="mt-1 min-h-11 text-body text-blue"
      >
        {mode === 'app'
          ? 'Use a recovery code instead'
          : 'Use my authenticator app instead'}
      </button>

      {mode === 'recovery' && (
        <p className="text-caption leading-relaxed text-muted">
          Lost your phone and your recovery codes? The business owner can reset
          your two-step sign-in from Settings → Team. If you are the business
          owner, or you work for more than one business on PestM8, contact
          PestM8 support instead — an owner cannot reset their own.
        </p>
      )}
    </form>
  )
}
