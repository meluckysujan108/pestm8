import { useEffect, useState } from 'react'
import { ErrorComponent, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { PagePending } from '#/components/shell/Pending'
import { authClient } from '#/lib/auth-client'
import {
  SESSION_CHECK_TIMEOUT_MS,
  forgetRefusedQueries,
  signInRetries,
} from '#/lib/signInSettling'

/**
 * The router's error screen for a page Convex refused as "Unauthenticated"
 * (lib/signInSettling.ts explains why that refusal is never the answer on its
 * own). While it lasts, the page shows its placeholder inside the shell,
 * which is what a slow page already looks like.
 *
 * First it asks Better Auth, now rather than at the next focus. If the session
 * has ended, SessionWatch (__root.tsx) hears it and sends the person to sign
 * in, so the sign-in screen replaces the placeholder. Signing out stays
 * SessionWatch's job: the retry below runs either way, and when signed out it
 * re-runs the same guards SessionWatch's does. Once Better Auth has answered,
 * or has taken too long, the page is retried through `router.invalidate()`,
 * which resets this boundary and re-runs a loader that failed. A plain
 * `reset()` would only re-render, and a failed loader's match throws the same
 * error again.
 *
 * A render error takes the page's subscriptions down with it. The retry
 * starts them again, and whatever token the socket has by then answers them.
 * Queries refused before they had any data are dropped first, so they are
 * asked for again instead of being thrown straight back
 * (`forgetRefusedQueries`). After three retries in a minute the budget is
 * spent, and the router's own error screen shows as it did before.
 */
export function SignInSettling(props: ErrorComponentProps) {
  const router = useRouter()
  const { refetch } = authClient.useSession()
  const [delay] = useState(() =>
    typeof window === 'undefined' ? 0 : signInRetries.next(Date.now()),
  )
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    if (delay === null) return
    let live = true
    const answered = () => {
      if (live) setAsked(true)
    }
    const timer = setTimeout(answered, SESSION_CHECK_TIMEOUT_MS)
    void refetch().finally(answered)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [delay, refetch])

  useEffect(() => {
    if (!asked || delay === null) return
    const timer = setTimeout(() => {
      signInRetries.spend(Date.now())
      forgetRefusedQueries(router.options.context.queryClient)
      void router.invalidate()
    }, delay)
    return () => clearTimeout(timer)
  }, [asked, delay, router])

  if (delay === null) return <ErrorComponent {...props} />
  return <PagePending />
}
