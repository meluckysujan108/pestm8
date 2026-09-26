import { createFileRoute } from '@tanstack/react-router'
import { EmptyState } from '#/components/primitives/EmptyState'
import { BusinessSection } from '#/components/settings/BusinessSection'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { PageHeader } from '#/components/shell/PageHeader'
import { useActing, useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/business')({
  // The business itself is the layout's (`getBySlug`, already cached and
  // kept live). What this page adds is the trading name and website, which
  // only `reportSettings` carries, and which only an owner may read: the
  // capability comes from `access.me`, which the layout's beforeLoad has
  // already cached, so nobody warms a query that would refuse them.
  //
  // Never waited on past LOADER_WAIT_MS: with no signal a Convex query never
  // answers, and the form has its own answer for a late one (those two
  // fields wait, disabled, and everything else can be changed meanwhile).
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    if (access?.caps['business.manage'] !== true) return
    return settleWithin(
      LOADER_WAIT_MS,
      warm(queryClient, rq.reportSettings(business._id)),
    )
  },
  component: BusinessPage,
})

function BusinessPage() {
  const { business } = Route.useRouteContext()
  // The business's identity and letterhead are a policy-level change, and
  // the server refuses them to anyone without this — an owner working in
  // someone else's account included, whose business capabilities it drops
  // for the length of the switch. So nobody else is shown a form, not even
  // a read-only copy of it: what the business prints is the owner's to see
  // to.
  const canManage = useCan('business.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Business details"
        back={
          <BackLink
            to="/$businessSlug/settings"
            params={{ businessSlug: business.slug }}
          >
            Settings
          </BackLink>
        }
      />

      <SettingsBody>
        {canManage ? (
          <BusinessSection business={business} />
        ) : (
          <EmptyState
            title="Owners only"
            body={
              isSwitched
                ? 'Only the business owner can change these. Switch back to your own account to change them.'
                : 'Only the business owner can change these.'
            }
          />
        )}
      </SettingsBody>
    </>
  )
}
