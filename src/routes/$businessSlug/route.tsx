import {
  createFileRoute,
  notFound,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../../convex/_generated/api'
import { AppShell } from '#/components/shell/AppShell'
import { SwitchBanner } from '#/components/shell/SwitchBanner'
import { AccessProvider } from '#/lib/access'
import { signedInToken, signedOutAfterAll } from '#/lib/rootState'
import { isMfaEnrolmentError } from '#/lib/twoStep'

export const Route = createFileRoute('/$businessSlug')({
  beforeLoad: async ({ context, params, location }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    // Signed in without two-step sign-in set up: the server refuses every
    // query below (MFA_ENROLMENT_REQUIRED), so send them to set it up and
    // bring them back here after. Read off the refusal rather than asked for
    // up front, so an enrolled person — everyone, after the first day — pays
    // nothing for it on the way into the schedule.
    const enrol = (error: unknown): never => {
      if (isMfaEnrolmentError(error)) {
        throw redirect({ to: '/two-step', search: { next: location.href } })
      }
      throw error
    }

    const bySlug = convexQuery(api.businesses.getBySlug, {
      slug: params.businessSlug,
    })
    let business = await context.queryClient
      .ensureQueryData(bySlug)
      .catch(enrol)

    // getBySlug returns null both for a missing business and for one the
    // caller isn't a member of, so this 404 leaks no existence information.
    // It also returns null once the caller's session is gone — it resolves
    // through the session, so offboarding re-pushes it as null — and with the
    // sign-in cached in the browser nothing above would have noticed. Ask
    // before calling it a missing business, or an offboarded technician's
    // next tap is a dead end instead of the sign-in screen.
    //
    // Still signed in is not the end of it. The null in the cache is the live
    // socket's answer, and the socket can answer as nobody while someone is
    // signed in: while one token hands over to the next, or after a token
    // refresh fails. So the lookup is asked again with the server's own
    // token, over HTTP (`businessOverHttp`), and only its null is a missing
    // business. Without that, a signed-in tap in such a moment was "Not
    // found" (e2e/socketSignIn.spec.ts).
    if (!business) {
      if (await signedOutAfterAll()) throw redirect({ to: '/login' })
      business = await businessOverHttp(
        context.convexQueryClient.convexClient.url,
        params.businessSlug,
      ).catch((error: unknown) =>
        isMfaEnrolmentError(error) ? enrol(error) : null,
      )
      if (!business) throw notFound()
      // So the next tap reads it rather than doubting the same null again.
      // The socket's own answer replaces it once it has one.
      context.queryClient.setQueryData(bySlug.queryKey, business)
    }

    // Warmed here, together, so the shell renders without a suspense flash.
    // `access.me` is NOT read from this context: it follows a switch and a
    // snapshot taken here could not, because `ensureQueryData` returns the
    // cache rather than refetching. Gates read it live, through `useAccess`.
    // The business list is the sidebar switcher's; unwarmed, it suspended the
    // layout, and a streamed page's first paint was a placeholder with no
    // shell around it.
    await Promise.all([
      context.queryClient.ensureQueryData(
        convexQuery(api.access.me, { businessId: business._id }),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.businesses.listForUser, {}),
      ),
    ]).catch(enrol)

    return { business, membership: business.membership }
  },
  // Entering a business — from sign-in, or through the switcher — keeps the
  // screen you came from, with the progress bar, until the lookups above
  // resolve. A placeholder here would stand in for the whole shell, so the
  // dock and sidebar would vanish and come back; inside the business, each
  // page still gets the default one.
  pendingMs: Infinity,
  component: BusinessLayout,
})

function BusinessLayout() {
  const { business, membership } = Route.useRouteContext()

  return (
    <AccessProvider businessId={business._id}>
      <AppShell
        business={business}
        membership={membership}
        banner={<SwitchBanner businessId={business._id} />}
      >
        <Outlet />
      </AppShell>
    </AccessProvider>
  )
}

/**
 * `businesses.getBySlug` asked over plain HTTP, with the token of the server's
 * last "who is signed in" answer — which `signedOutAfterAll` has just
 * refreshed, unless it asked a moment ago. The socket plays no part, so an
 * answer it gave as nobody cannot come back this way. Null when there is no
 * such token to ask with: on the server, whose lookup already went out with
 * the request's own.
 */
async function businessOverHttp(convexUrl: string, slug: string) {
  const token = signedInToken()
  if (!token) return null
  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(token)
  return client.query(api.businesses.getBySlug, { slug })
}
