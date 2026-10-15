import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { XeroPage } from '#/components/xero/XeroPage'
import { rq, settleWithin, warm } from '#/lib/routeQueries'

/** How long the loader holds the navigation for its queries, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/my-xero/')({
  // As Settings → Xero: where Xero's callback sends a member back to.
  validateSearch: z.object({
    finish: z.string().optional(),
    xero: z.string().optional(),
  }),
  // The status, and the roster for the owner's name in what connecting
  // says. Warmed, never waited on past LOADER_WAIT_MS: with no signal a
  // Convex query never answers, and the page has its own placeholder.
  loader: ({ context: { queryClient, business } }) =>
    settleWithin(
      LOADER_WAIT_MS,
      warm(queryClient, rq.xeroStatus(business._id), rq.roster(business._id)),
    ),
  component: MyXeroPage,
})

/**
 * Settings → My Xero: a contractor's or subcontractor's own organisation, so
 * they can invoice the business's clients from their own books.
 */
function MyXeroPage() {
  const { business } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <XeroPage
      kind="member"
      business={business}
      search={search}
      // Replaced, not pushed: a used finish token must not be one Back away.
      onSearchDone={() => void navigate({ search: {}, replace: true })}
    />
  )
}
