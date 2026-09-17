import {
  createFileRoute,
  notFound,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { AppShell } from '#/components/shell/AppShell'
import { SwitchBanner } from '#/components/shell/SwitchBanner'
import { AccessProvider } from '#/lib/access'

export const Route = createFileRoute('/$businessSlug')({
  beforeLoad: async ({ context, params }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    const business = await context.queryClient.ensureQueryData(
      convexQuery(api.businesses.getBySlug, { slug: params.businessSlug }),
    )

    // getBySlug returns null both for a missing business and for one the
    // caller isn't a member of, so this 404 leaks no existence information.
    if (!business) throw notFound()

    // Warmed here so the shell renders without a suspense flash. It is NOT
    // read from this context: `access.me` follows a switch and a snapshot
    // taken here could not, because `ensureQueryData` returns the cache
    // rather than refetching. Gates read it live, through `useAccess`.
    await context.queryClient.ensureQueryData(
      convexQuery(api.access.me, { businessId: business._id }),
    )

    return { business, membership: business.membership }
  },
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
