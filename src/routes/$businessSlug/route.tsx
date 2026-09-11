import {
  createFileRoute,
  notFound,
  redirect,
  Outlet,
} from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { AppShell } from '#/components/shell/AppShell'
import { ViewingAsBanner } from '#/components/shell/ViewingAsBanner'

export const Route = createFileRoute('/$businessSlug')({
  beforeLoad: async ({ context, params }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    const business = await context.queryClient.ensureQueryData(
      convexQuery(api.businesses.getBySlug, { slug: params.businessSlug }),
    )

    // getBySlug returns null both for a missing business and for one the
    // caller isn't a member of, so this 404 leaks no existence information.
    if (!business) throw notFound()

    return { business, membership: business.membership }
  },
  component: BusinessLayout,
})

function BusinessLayout() {
  const { business, membership } = Route.useRouteContext()

  return (
    <>
      <ViewingAsBanner businessId={business._id} />
      <AppShell business={business} membership={membership}>
        <Outlet />
      </AppShell>
    </>
  )
}
