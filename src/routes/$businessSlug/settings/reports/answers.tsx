import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { OptionLibrariesSection } from '#/components/settings/OptionLibrariesSection'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { useActing, useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/reports/answers')(
  {
    // The lists, for whoever may edit them: `optionSets.editable` is
    // templates.manage only, and `access.me` is already in the cache (the
    // layout's beforeLoad warms it), so asking costs nothing and nobody warms
    // a query the server would refuse. Never waited on past LOADER_WAIT_MS —
    // with no signal a Convex query never answers, and the page has its own
    // placeholder for a late one.
    loader: ({ context: { queryClient, business } }) => {
      const access = queryClient.getQueryData<Access>(
        rq.access(business._id).queryKey,
      )
      return settleWithin(
        LOADER_WAIT_MS,
        warm(
          queryClient,
          ...(access?.caps['templates.manage'] === true
            ? [rq.answerLists(business._id)]
            : []),
        ),
      )
    },
    component: AnswerListsPage,
  },
)

function AnswerListsPage() {
  const { business } = Route.useRouteContext()
  // The lists of answers the forms offer are form content, so they answer
  // to the capability the forms do.
  const canManageTemplates = useCan('templates.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Answer lists"
        back={
          <BackLink
            to="/$businessSlug/settings/reports"
            params={{ businessSlug: business.slug }}
          >
            Report settings
          </BackLink>
        }
      />

      <SettingsBody>
        {canManageTemplates ? (
          <OptionLibrariesSection businessId={business._id} />
        ) : (
          // Opened by URL, or an owner working inside someone else's account
          // (the server drops their business capabilities for the length of
          // the switch): a plain answer, not a list that refuses every tap.
          <EmptyState
            title="Only the business owner can change these."
            body={
              isSwitched
                ? 'Switch back to your own account to change them.'
                : undefined
            }
          />
        )}
      </SettingsBody>
    </>
  )
}
