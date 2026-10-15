import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { MatchReview } from '#/components/xero/MatchReview'
import { searchParam, warmMatch } from '#/lib/routeQueries'

export const Route = createFileRoute('/$businessSlug/settings/xero/match')({
  // Which list is showing, in the address so a reload or a shared link
  // opens it. Lenient: a stale or mistyped one opens To check, not an error.
  validateSearch: z.object({
    filter: z.enum(['matched', 'new', 'separate']).optional().catch(undefined),
  }),
  loader: ({ context: { queryClient, business }, location }) =>
    warmMatch(
      queryClient,
      business._id,
      'business',
      searchParam(location, 'filter'),
    ),
  component: XeroMatchPage,
})

/** Settings → Xero → Match your clients: the business's organisation, the
 * owner's to check. */
function XeroMatchPage() {
  const { business } = Route.useRouteContext()
  const { filter } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <MatchReview
      kind="business"
      business={business}
      filter={filter ?? 'review'}
      // Replaced, as the Reports library's segments are: Back leaves the
      // page rather than stepping back through every list looked at.
      onFilter={(next) =>
        void navigate({
          search: { filter: next === 'review' ? undefined : next },
          replace: true,
        })
      }
    />
  )
}
