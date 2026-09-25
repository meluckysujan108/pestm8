import { Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import { MyDetailsForm } from '#/components/settings/MyDetails'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { rq, settleWithin, warm } from '#/lib/routeQueries'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/details')({
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and the form has its own placeholder for late data.
  loader: ({ context: { queryClient } }) =>
    settleWithin(LOADER_WAIT_MS, warm(queryClient, rq.currentUser())),
  component: MyDetailsPage,
})

function MyDetailsPage() {
  const { business, membership } = Route.useRouteContext()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="My details"
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
        {/* The header stays put while the form waits for the signed-in
            user. */}
        <Suspense fallback={<SectionPending />}>
          <MyDetailsForm
            businessId={business._id}
            membershipId={membership._id}
            phone={membership.phone}
            state={business.state}
          />
        </Suspense>
      </SettingsBody>
    </>
  )
}
