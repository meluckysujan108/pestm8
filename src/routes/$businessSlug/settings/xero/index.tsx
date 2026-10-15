import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { XeroPage } from '#/components/xero/XeroPage'
import { rq, settleWithin, warm } from '#/lib/routeQueries'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/xero/')({
  // Where Xero's callback sends the browser back to: `finish` when the
  // organisation was accepted, `xero` with a reason when it wasn't
  // (convex/xeroCallback.ts). Either may be missing; neither is checked
  // here beyond being text — the page and the server decide what they mean.
  validateSearch: z.object({
    finish: z.string().optional(),
    xero: z.string().optional(),
  }),
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and the page has its own placeholder for it.
  loader: ({ context: { queryClient, business } }) =>
    settleWithin(
      LOADER_WAIT_MS,
      warm(queryClient, rq.xeroStatus(business._id)),
    ),
  component: XeroSettingsPage,
})

/** Settings → Xero: the business's own organisation, the owner's to connect. */
function XeroSettingsPage() {
  const { business } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <XeroPage
      kind="business"
      business={business}
      search={search}
      // Replaced, not pushed: a used finish token must not be one Back away.
      onSearchDone={() => void navigate({ search: {}, replace: true })}
    />
  )
}
