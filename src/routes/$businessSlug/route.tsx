import { useEffect } from 'react'
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
import { notAMemberOf } from '#/lib/offline/keptStore'
import { signedInToken, signedOutAfterAll } from '#/lib/rootState'
import { isMfaEnrolmentError } from '#/lib/twoStep'
import { rq, warm } from '#/lib/routeQueries'
import type { FunctionReturnType } from 'convex/server'

export const Route = createFileRoute('/$businessSlug')({
  beforeLoad: async ({ context, params, location }) => {
    // Back here after signing in, as the two-step redirect below does: a
    // link into the app (Xero's way back to Settings → Xero with its finish
    // token, a shared job) is worth more than the schedule it would
    // otherwise land on. `safeNext` on the sign-in page keeps it on this site.
    // Xero's way back is a full page load, which the server answers with the
    // cookie it has, so a lapsed session is caught here.
    if (!context.isAuthenticated) {
      throw redirect({ to: '/login', search: { next: location.href } })
    }

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
      // No `next` here: this is a session that ended under an open app —
      // offboarded, most often — and whoever signs in next, the same person
      // or someone else on that phone, may not belong in this business.
      // The front door finds the business they do belong in.
      if (await signedOutAfterAll()) throw redirect({ to: '/login' })
      const overHttp = await businessOverHttp(
        context.convexQueryClient.convexClient.url,
        params.businessSlug,
      ).catch(enrol)
      business = overHttp.business
      if (!business) {
        // The server itself answered that this person is not a member (any
        // more): over HTTP just now, or, on the server, in the lookup above,
        // which went out with the request's own token. So whatever this
        // phone kept of the business goes, wiped by the root's "Not found"
        // once it is on screen: the browser doesn't run this guard again for
        // a page the server rendered. Never on a lookup that could not be
        // asked or that failed: a phone with no signal is not someone
        // removed.
        const asked = typeof window === 'undefined' || overHttp.asked
        throw notFound(
          asked ? { data: notAMemberOf(params.businessSlug) } : undefined,
        )
      }
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
    // The job types, which New Job, the job sheet and the report buttons all
    // read (Settings → Job types): asked for now, not waited on, so they are
    // here before any of them opens. In the browser only, like every warm
    // that no page's first paint depends on.
    if (typeof window !== 'undefined') {
      void context.queryClient.prefetchQuery(rq.jobTypes(business._id))
    }

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
  const { business, membership, queryClient } = Route.useRouteContext()

  // What New Job is made of — every client and site, the team, the job
  // types — asked for as soon as the business's pages are on screen, however
  // they got there. A loader's or beforeLoad's warm runs only for a
  // navigation inside the app, so a page opened from the Home Screen
  // (rendered by the server, or a copy the service worker kept) had none of
  // it until New Job asked: down the same line that had just died on a phone
  // call, when someone is booking the caller (25 Oct 2026). Kept from then
  // for as long as the app is open (root-provider.tsx), so New Job opens at
  // once on what the phone already has.
  useEffect(() => {
    void warm(
      queryClient,
      rq.directory(business._id),
      rq.roster(business._id),
      rq.jobTypes(business._id),
    )
  }, [queryClient, business._id])

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
 * answer it gave as nobody cannot come back this way.
 *
 * `asked` says whether the server answered at all. Not when there is no such
 * token to ask with (on the server, whose lookup already went out with the
 * request's own), and not when the request failed: no signal, or a server
 * error. A null then says nothing about membership. Only a refusal to set up
 * two-step sign-in is thrown, for the guard to send them there.
 */
async function businessOverHttp(
  convexUrl: string,
  slug: string,
): Promise<{
  asked: boolean
  business: FunctionReturnType<typeof api.businesses.getBySlug>
}> {
  const token = signedInToken()
  if (!token) return { asked: false, business: null }
  try {
    const client = new ConvexHttpClient(convexUrl)
    client.setAuth(token)
    return {
      asked: true,
      business: await client.query(api.businesses.getBySlug, { slug }),
    }
  } catch (error) {
    if (isMfaEnrolmentError(error)) throw error
    return { asked: false, business: null }
  }
}
