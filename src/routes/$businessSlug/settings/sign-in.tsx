import { Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import { TwoStepSection } from '#/components/settings/TwoStepSection'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { rq, settleWithin, warm } from '#/lib/routeQueries'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/sign-in')({
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and the section has its own placeholder for it.
  loader: ({ context: { queryClient } }) =>
    settleWithin(LOADER_WAIT_MS, warm(queryClient, rq.currentUser())),
  component: SignInPage,
})

function SignInPage() {
  const { business } = Route.useRouteContext()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Two-step sign-in"
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
        {/* The header stays put while the section waits for the signed-in
            user. */}
        <Suspense fallback={<SectionPending />}>
          <TwoStepSection />
        </Suspense>
      </SettingsBody>
    </>
  )
}
