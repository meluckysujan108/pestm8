import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { MatchReview } from '#/components/xero/MatchReview'
import { searchParam, warmMatch } from '#/lib/routeQueries'

export const Route = createFileRoute('/$businessSlug/settings/my-xero/match')({
  // As Settings → Xero → Match your clients: which list is showing.
  validateSearch: z.object({
    filter: z.enum(['matched', 'new', 'separate']).optional().catch(undefined),
  }),
  loader: ({ context: { queryClient, business }, location }) =>
    warmMatch(
      queryClient,
      business._id,
      'member',
      searchParam(location, 'filter'),
    ),
  component: MyXeroMatchPage,
})

/** Settings → My Xero → Match your clients: a member's own organisation,
 * theirs alone to check. */
function MyXeroMatchPage() {
  const { business } = Route.useRouteContext()
  const { filter } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <MatchReview
      kind="member"
      business={business}
      filter={filter ?? 'review'}
      // Replaced: Back leaves the page.
      onFilter={(next) =>
        void navigate({
          search: { filter: next === 'review' ? undefined : next },
          replace: true,
        })
      }
    />
  )
}
