import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { LicenceDocument } from '#/components/settings/LicenceDocument'
import { MyLicenceNumber } from '#/components/settings/MyLicence'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { rq, settleWithin, warm } from '#/lib/routeQueries'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/licence')({
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and this is the page a technician on site opens to
  // show an inspector the licence kept on their phone. The document group
  // has its own answer for late data (it falls back to the kept copy), so
  // the loader must not hold it back.
  loader: ({ context: { queryClient, business, membership } }) =>
    settleWithin(
      LOADER_WAIT_MS,
      warm(queryClient, rq.licenceFile(business._id, membership._id)),
    ),
  component: LicencePage,
})

/**
 * Your licence: the number printed on your reports, and the document itself.
 *
 * Nothing here waits for the signed-in user. With no signal that query never
 * answers (a Convex query waits rather than fails), and the copy of the
 * licence document kept on this phone is for exactly that — a technician on
 * site showing an inspector their card. So the whole page renders straight
 * from what the route already has: the number from the membership, the
 * label from the business's state.
 */
function LicencePage() {
  const { business, membership } = Route.useRouteContext()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Licence"
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
        <MyLicenceNumber
          businessId={business._id}
          membershipId={membership._id}
          licenceNumber={membership.licenceNumber}
          state={business.state}
        >
          <LicenceDocument
            businessId={business._id}
            membershipId={membership._id}
          />
        </MyLicenceNumber>
      </SettingsBody>
    </>
  )
}
