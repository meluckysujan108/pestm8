import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { ActivityFeed } from '#/components/settings/ActivityFeed'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { useActing, useCan } from '#/lib/access'
import {
  activityFirstPage,
  rq,
  searchParam,
  settleWithin,
  warm,
} from '#/lib/routeQueries'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/activity')({
  // In the address like every list's filters (§5): whose changes, and the
  // job open over the list, as the Payments page has it.
  validateSearch: z.object({
    staff: z.string().optional().catch(undefined),
    jobId: z.string().optional().catch(undefined),
  }),
  // `jobActivity.feed` is business.manage only, and `access.me` is already in
  // the cache (the layout's beforeLoad warms it), so nobody warms a query the
  // server would refuse. Never waited on past LOADER_WAIT_MS: with no signal
  // a Convex query never answers, and the page has its own placeholder.
  loader: ({ context: { queryClient, business }, location }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    const staff = searchParam(location, 'staff')
    return settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        ...(access?.caps['business.manage'] === true
          ? [
              activityFirstPage(
                business._id,
                typeof staff === 'string' ? staff : undefined,
              ),
              // The filter's names, and the name a narrowed list says.
              rq.roster(business._id),
            ]
          : []),
      ),
    )
  },
  component: ActivityPage,
})

/**
 * Settings → Activity: who changed which job, and how, across the whole
 * business (convex/jobActivity.ts `feed`). The owner's, like the Recycle
 * bin: an owner working inside someone else's account sees "Owners only"
 * until they switch back.
 */
function ActivityPage() {
  const { business } = Route.useRouteContext()
  const { staff, jobId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const canManageBusiness = useCan('business.manage')
  const canDispatch = useCan('jobs.dispatch')
  const canManageClients = useCan('clients.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Activity"
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
          <ActivityFeed
            businessId={business._id}
            businessSlug={business.slug}
            timezone={business.timezone}
            staffId={staff}
            onStaff={(next) =>
              navigate({
                search: (prev) => ({ ...prev, staff: next }),
                replace: true,
              })
            }
          />
        ) : (
          <EmptyState
            title="Owners only"
            body={
              isSwitched
                ? 'Only the business owner can see who changed which job. Switch back to your own account to see it.'
                : 'Only the business owner can see who changed which job.'
            }
          />
        )}
      </SettingsBody>

      {canManageBusiness && (
        <JobDetailSheet
          businessId={business._id}
          businessSlug={business.slug}
          timezone={business.timezone}
          jobId={jobId ?? null}
          canReassign={canDispatch}
          canDelete={canManageClients}
          onClose={() =>
            navigate({
              search: (prev) => ({ ...prev, jobId: undefined }),
              replace: true,
              resetScroll: false,
            })
          }
        />
      )}
    </>
  )
}
