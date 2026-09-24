import { useRef, useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { Check, Copy } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../convex/_generated/api'
import { QrCode } from '#/components/auth/QrCode'
import { RecoveryCodes } from '#/components/auth/RecoveryCodes'
import { authClient } from '#/lib/auth-client'
import { forgetCachedPages } from '#/lib/rootState'
import {
  describeTwoFactorError,
  normaliseTotpCode,
  safeNext,
  setupKeyOf,
} from '#/lib/twoStep'
import { useHydrated } from '#/lib/useHydrated'

/**
 * Setting up two-step sign-in — compulsory for every account
 * (convex/lib/mfa.ts), so this is where the app sends anyone signed in who
 * has not done it yet: at their first sign-in after release, straight after
 * creating an account from an invitation, and after the owner has reset them.
 * The server refuses them everything else until it is done
 * (`requireAuthUser`), so there is nothing to skip to.
 *
 * Three steps: confirm the password (the server asks for it — a phone left
 * unlocked on a bench is not enough to change how its owner signs in), add
 * the account to an authenticator app and prove it with a code, then save the
 * recovery codes. `twoFactorEnabled` only flips at the code, so leaving
 * half-way leaves nothing half-done: the next visit starts again.
 *
 * `next` brings them back to where they were going — the invitation they were
 * accepting, the page they opened — through `safeNext`, so it can only ever
 * be a path on this site.
 */
export const Route = createFileRoute('/two-step')({
  validateSearch: z.object({ next: z.string().optional() }),
  beforeLoad: async ({ context, search }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.auth.twoFactorStatus, {}),
    )
    if (!status.signedIn) throw redirect({ to: '/login' })
    // Already set up: nothing to do here. (Where it is not compulsory —
    // AUTH_MFA_REQUIRED=off — the page still works for anyone who chooses to
    // set it up from Settings.)
    if (status.enabled) throw redirect({ href: safeNext(search.next) })
  },
  component: TwoStepPage,
})

type Setup = { totpURI: string; backupCodes: Array<string> }

function TwoStepPage() {
  const { next } = Route.useSearch()
  const [setup, setSetup] = useState<Setup | null>(null)
  const [verified, setVerified] = useState(false)

  /**
   * A full load into the app, as sign-in does. Checking the code replaces the
   * session (Better Auth rotates it when two-step sign-in is switched on), and
   * the Convex client holds a token for the old one until a page load — every
   * query after this would be refused until then.
   */
  async function finish() {
    await forgetCachedPages()
    window.location.replace(safeNext(next))
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6 py-10">
      <div className="mb-6">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">
          {verified ? 'Save your recovery codes' : 'Set up two-step sign-in'}
        </h1>
        {!verified && (
          <p className="mt-2 text-body text-muted">
            Every PestM8 account now signs in with a password and a 6-digit code
            from an authenticator app on your phone. It keeps client records
            safe if a password gets out. It takes about a minute.
          </p>
        )}
      </div>

      {verified && setup ? (
        <RecoveryCodes codes={setup.backupCodes} onDone={() => void finish()} />
      ) : setup ? (
        <ScanStep setup={setup} onVerified={() => setVerified(true)} />
      ) : (
        <PasswordStep onReady={setSetup} onAlreadyOn={() => void finish()} />
      )}

      {!verified && (
        <button
          type="button"
          // A reload, as Settings' sign-out does: whoever signs in next must
          // not be shown this person's cached answers.
          onClick={() =>
            authClient
              .signOut()
              .then(forgetCachedPages)
              .then(() => window.location.replace('/login'))
          }
          className="mt-8 text-body text-blue"
        >
          Sign out
        </button>
      )}
    </main>
  )
}

function PasswordStep({
  onReady,
  onAlreadyOn,
}: {
  onReady: (setup: Setup) => void
  onAlreadyOn: () => void
}) {
  const hydrated = useHydrated()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const result = await authClient.twoFactor
      .enable({ password })
      .catch(() => ({
        data: null,
        error: { message: 'Could not reach PestM8. Try again.' },
      }))
    if (result.error) {
      setPending(false)
      if (
        'code' in result.error &&
        result.error.code === 'MFA_ALREADY_ENABLED'
      ) {
        onAlreadyOn()
        return
      }
      setError(describeTwoFactorError(result.error).message)
      return
    }
    onReady({
      totpURI: result.data.totpURI,
      backupCodes: result.data.backupCodes,
    })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="section-label">Your password</span>
        <input
          type="password"
          value={password}
          required
          autoComplete="current-password"
          enterKeyHint="go"
          onChange={(e) => setPassword(e.target.value)}
          className="h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
        />
        <span className="text-caption text-muted">
          To confirm it is you before changing how you sign in.
        </span>
      </label>

      {error && <Alert>{error}</Alert>}

      <button
        type="submit"
        disabled={pending || !hydrated}
        className="mt-2 h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
      >
        {pending ? 'Just a moment…' : 'Start'}
      </button>
    </form>
  )
}

function ScanStep({
  setup,
  onVerified,
}: {
  setup: Setup
  onVerified: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  // Auto-submit at six digits and a tap on the button can land together.
  const busy = useRef(false)
  const key = setupKeyOf(setup.totpURI)

  async function verify(value: string) {
    if (busy.current) return
    busy.current = true
    setError(null)
    setPending(true)
    const result = await authClient.twoFactor
      .verifyTotp({ code: normaliseTotpCode(value) })
      .catch(() => ({
        data: null,
        error: { message: 'Could not reach PestM8. Try again.' },
      }))
    if (result.error) {
      busy.current = false
      setPending(false)
      setCode('')
      setError(describeTwoFactorError(result.error).message)
      return
    }
    onVerified()
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4">
        <p className="section-label">1 · Add PestM8 to your authenticator</p>
        <p className="text-body text-muted">
          Use Google Authenticator, Microsoft Authenticator, or the iPhone's own
          Passwords app. On this phone, tap the button — it opens the app with
          PestM8 filled in.
        </p>
        <a
          href={setup.totpURI}
          className="flex h-12 items-center justify-center rounded-xl bg-surface-2 text-[17px] font-semibold text-ink transition active:scale-[.975]"
        >
          Add to authenticator app
        </a>

        {/* A phone cannot scan its own screen; this is for setting up at a
            desk with the phone in hand. */}
        <div className="hidden flex-col items-center gap-2 pt-2 sm:flex">
          <QrCode
            value={setup.totpURI}
            label="QR code to add PestM8 to an authenticator app"
          />
          <p className="text-caption text-muted">
            Or scan this with your authenticator app.
          </p>
        </div>

        <div className="flex flex-col gap-1.5 pt-1">
          <span className="section-label">Or type this setup key</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 rounded-xl bg-surface-3 px-3.5 py-3 font-mono text-[16px] break-all text-ink select-all">
              {key}
            </code>
            <button
              type="button"
              aria-label="Copy setup key"
              onClick={() => {
                void navigator.clipboard
                  .writeText(key.replace(/\s/g, ''))
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
              }}
              className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink transition active:scale-[.975]"
            >
              {copied ? (
                <Check size={18} strokeWidth={2} />
              ) : (
                <Copy size={18} strokeWidth={1.7} />
              )}
            </button>
          </div>
        </div>
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void verify(code)
        }}
        className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4"
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">
            2 · Enter the 6-digit code it shows
          </span>
          <input
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
              if (next.length === 6) void verify(next)
            }}
            className="h-12 rounded-xl bg-surface-3 px-3.5 text-center font-mono text-[22px] tracking-[0.3em] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        {error && <Alert>{error}</Alert>}

        <button
          type="submit"
          disabled={pending || normaliseTotpCode(code).length !== 6}
          className="h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {pending ? 'Checking…' : 'Turn on two-step sign-in'}
        </button>
      </form>
    </div>
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
