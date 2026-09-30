import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { JobTypesSection } from '#/components/settings/JobTypesSection'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { useActing, useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/job-types')({
  // The list with its counts, for whoever may change it: `jobTypes.manage` is
  // business.manage only, and `access.me` is already in the cache (the
  // layout's beforeLoad warms it), so nobody warms a query the server would
  // refuse. Never waited on past LOADER_WAIT_MS — with no signal a Convex
  // query never answers, and the page has its own placeholder for a late one.
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    return settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        ...(access?.caps['business.manage'] === true
          ? [rq.jobTypesManage(business._id)]
          : []),
      ),
    )
  },
  component: JobTypesPage,
})

/**
 * Settings → Job types: the services New Job offers, as the business's own
 * list — added, renamed, deleted and tidied here (convex/jobTypes.ts).
 */
function JobTypesPage() {
  const { business } = Route.useRouteContext()
  const canManageBusiness = useCan('business.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Job types"
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
        {canManageBusiness ? (
          <JobTypesSection businessId={business._id} />
        ) : (
          // Opened by URL, or an owner working inside someone else's account
          // (the server drops their business capabilities for the length of
          // the switch): a plain answer, not a list that refuses every tap.
          <EmptyState
            title="Owners only"
            body={
              isSwitched
                ? 'Only the business owner can change the job types. Switch back to your own account to change them.'
                : 'Only the business owner can change the job types.'
            }
          />
        )}
      </SettingsBody>
    </>
  )
}
