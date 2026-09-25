import { useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { ShieldCheck } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { RecoveryCodes } from '#/components/auth/RecoveryCodes'
import { authClient } from '#/lib/auth-client'
import { rq } from '#/lib/routeQueries'
import { describeTwoFactorError } from '#/lib/twoStep'
import {
  markRecoveryCodesUnsaved,
  recoveryCodesUnsaved,
} from '#/lib/twoStepReminders'
import { useHydrated } from '#/lib/useHydrated'

/**
 * Two-step sign-in, in the person's own settings.
 *
 * Optional (convex/lib/mfa.ts): off, it offers to set it up; on, it offers new
 * recovery codes — for someone who has used a few, or who is not sure where
 * they put the first lot — and a way to turn it off again. Making new codes
 * cancels the old ones, so a set someone else found stops working. Both ask
 * for the password again, because a phone left unlocked on a bench should not
 * be enough to change how its owner signs in. Where a deployment makes it
 * compulsory (`AUTH_MFA_REQUIRED=on`), Turn off is not offered and the server
 * refuses it anyway.
 *
 * Lost phone AND codes is not handled here — they cannot sign in to see this.
 * That is the owner's reset, in Settings → Team.
 */
export function TwoStepSection() {
  // Already in the cache: the Profile section above reads the same query.
  const { data: user } = useSuspenseQuery(rq.currentUser())
  const on = user.twoFactorEnabled === true
  // Not suspended on: until it answers, Turn off shows, and the server has
  // the last word if the deployment makes two-step sign-in compulsory.
  const required =
    useQuery(convexQuery(api.auth.twoFactorStatus, {})).data?.required === true

  const hydrated = useHydrated()
  // Back to this page once set up.
  const here = useRouterState({ select: (state) => state.location.href })
  // Which password form is open, if any.
  const [open, setOpen] = useState<'codes' | 'off' | null>(null)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [codes, setCodes] = useState<Array<string> | null>(null)
  // Codes shown at set-up but never confirmed saved — a reload between the
  // code and "I've saved these" — or never made at all, when set-up could
  // not make them after the code, or never heard that its code was accepted
  // (lib/twoStepReminders). Read after hydration: the server has no browser
  // storage to agree with.
  const [unsaved, setUnsaved] = useState(false)
  useEffect(() => {
    if (on) setUnsaved(recoveryCodesUnsaved(user._id))
  }, [on, user._id])

  function close() {
    setOpen(null)
    setPassword('')
    setError(null)
    // Done on a fresh set means they have been saved.
    if (codes !== null) {
      markRecoveryCodesUnsaved(user._id, false)
      setUnsaved(false)
    }
    setCodes(null)
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (open === 'off') return turnOff()
    setError(null)
    setPending(true)
    const result = await authClient.twoFactor
      .generateBackupCodes({ password })
      .catch(() => ({
        data: null,
        error: { message: 'Could not reach PestM8. Try again.' },
      }))
    setPending(false)
    if (result.error) {
      setError(describeTwoFactorError(result.error).message)
      return
    }
    setPassword('')
    setCodes(result.data.backupCodes)
  }

  /**
   * Better Auth replaces the session when two-step sign-in is switched off,
   * and the Convex client holds a token for the old one until a page load —
   * so a reload, as set-up ends with one, rather than a page whose every
   * query is refused.
   */
  async function turnOff() {
    setError(null)
    setPending(true)
    const result = await authClient.twoFactor
      .disable({ password })
      .catch(() => ({
        data: null,
        error: { message: 'Could not reach PestM8. Try again.' },
      }))
    if (result.error) {
      setPending(false)
      setError(describeTwoFactorError(result.error).message)
      return
    }
    markRecoveryCodesUnsaved(user._id, false)
    // The PestM8 entry in their authenticator is dead now, and the form above
    // told them to delete it. Turned on again, set-up says the same on its
    // key (`scanStepNotice` in lib/twoStep.ts) — on any device, where this
    // used to be a flag in this phone's storage.
    window.location.reload()
  }

  return (
    <>
      <h2 className="section-label mb-2">Two-step sign-in</h2>
      <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={22}
            strokeWidth={1.7}
            className={on ? 'shrink-0 text-green' : 'shrink-0 text-muted'}
          />
          <div className="min-w-0">
            <p className="text-body font-semibold text-ink">
              {on ? 'On' : 'Off'}
            </p>
            <p className="mt-0.5 text-caption text-muted">
              {on
                ? 'Every sign-in asks for a code from your authenticator app. Lost your phone? Sign in with one of your recovery codes.'
                : 'Optional. Turn it on and signing in also asks for a 6-digit code from an app on your phone, so a password that gets out is not enough on its own.'}
            </p>
          </div>
        </div>

        {!on && (
          <Link
            to="/two-step"
            search={{ next: here }}
            className="mt-3 flex h-11 w-full items-center justify-center rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975]"
          >
            Turn on two-step sign-in
          </Link>
        )}

        {on && open === null && unsaved && (
          <p
            role="status"
            className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-orange-ink"
          >
            Your recovery codes were never confirmed as saved. Make new ones now
            and keep them somewhere other than this phone — without them, a lost
            phone means waiting for the business owner.
          </p>
        )}

        {on && open === null && (
          <button
            type="button"
            onClick={() => setOpen('codes')}
            className="mt-3 h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975]"
          >
            Get new recovery codes
          </button>
        )}

        {on && open === null && !required && (
          <button
            type="button"
            onClick={() => setOpen('off')}
            className="mt-2 inline-flex min-h-11 w-full items-center justify-center text-caption font-semibold text-red"
          >
            Turn off two-step sign-in
          </button>
        )}

        {on && open !== null && codes === null && (
          <form
            onSubmit={onSubmit}
            className="mt-3 flex flex-col gap-3 border-t border-hairline-2 pt-3"
          >
            <p className="text-caption text-muted">
              {open === 'off'
                ? 'Signing in will only ask for your password again, and your recovery codes stop working. Delete PestM8 from your authenticator app afterwards — its codes will not work again. Enter your password to turn it off.'
                : 'Your old recovery codes stop working as soon as the new ones are made. Enter your password to continue.'}
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="section-label">Password</span>
              <input
                type="password"
                value={password}
                required
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
              />
            </label>
            {error && (
              <p
                role="alert"
                className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-orange-ink"
              >
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                className="h-11 flex-1 rounded-xl bg-surface-2 text-body font-semibold text-ink transition active:scale-[.975]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || !hydrated}
                className="h-11 flex-1 rounded-xl bg-red text-body font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
              >
                {open === 'off'
                  ? pending
                    ? 'Turning off…'
                    : 'Turn off'
                  : pending
                    ? 'Making codes…'
                    : 'Make new codes'}
              </button>
            </div>
          </form>
        )}

        {on && codes !== null && (
          <div className="mt-3 border-t border-hairline-2 pt-3">
            <RecoveryCodes codes={codes} onDone={close} doneLabel="Done" />
          </div>
        )}
      </div>
    </>
  )
}
