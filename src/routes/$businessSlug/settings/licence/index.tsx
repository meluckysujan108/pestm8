import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { MyLicenceNumber } from '#/components/settings/MyLicence'
import { MyLicencesList } from '#/components/settings/MyLicencesList'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { rq, settleWithin, warm } from '#/lib/routeQueries'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/licence/')({
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and this is a page a technician on site opens to
  // show an inspector the licences kept on their phone. The list has its own
  // answer for late data (it falls back to the kept copy), so the loader
  // must not hold it back.
  loader: ({ context: { queryClient, business, membership } }) =>
    settleWithin(
      LOADER_WAIT_MS,
      warm(queryClient, rq.memberLicences(business._id, membership._id)),
    ),
  component: LicencesPage,
})

/**
 * Licences: the number printed on your reports, and every licence you hold —
 * each with its own page for its files.
 *
 * Nothing here waits for the signed-in user. With no signal that query never
 * answers (a Convex query waits rather than fails), and the copy of the
 * licences kept on this phone is for exactly that — a technician on site
 * showing an inspector their card. So the whole page renders straight from
 * what the route already has: the number from the membership, the label
 * from the business's state.
 */
function LicencesPage() {
  const { business, membership } = Route.useRouteContext()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Licences"
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
          <MyLicencesList
            businessId={business._id}
            businessSlug={business.slug}
            membershipId={membership._id}
            timezone={business.timezone}
          />
        </MyLicenceNumber>
      </SettingsBody>
    </>
  )
}
