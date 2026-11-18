import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { PaymentMethodsSection } from '#/components/settings/PaymentMethodsSection'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { useActing, useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/payments')({
  // `payments.methodSettings` is business.manage only, and `access.me` is already in
  // the cache (the layout's beforeLoad warms it), so nobody warms a query the
  // server would refuse. Never waited on past LOADER_WAIT_MS: with no signal
  // a Convex query never answers, and the page has its own placeholder.
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    return settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        ...(access?.caps['business.manage'] === true
          ? [rq.paymentMethods(business._id)]
          : []),
      ),
    )
  },
  component: PaymentSettingsPage,
})

/**
 * Settings → Payments: which ways of being paid the job sheet offers, and
 * what the card machine is called (convex/payments.ts `methodSettings`).
 */
function PaymentSettingsPage() {
  const { business } = Route.useRouteContext()
  const canManageBusiness = useCan('business.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Payments"
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
          <PaymentMethodsSection businessId={business._id} />
        ) : (
          // Opened by URL, or an owner working inside someone else's account
          // (the server drops their business capabilities for the length of
          // the switch): a plain answer, not switches that refuse every flip.
          <EmptyState
            title="Owners only"
            body={
              isSwitched
                ? 'Only the business owner can change how jobs are paid. Switch back to your own account to change it.'
                : 'Only the business owner can change how jobs are paid.'
            }
          />
        )}
      </SettingsBody>
    </>
  )
}
