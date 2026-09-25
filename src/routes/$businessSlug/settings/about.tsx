import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import {
  BackLink,
  SettingsBody,
  SettingsGroup,
  SettingsRow,
} from '#/components/settings/ui'
import { APP_VERSION } from '#/lib/appVersion'

export const Route = createFileRoute('/$businessSlug/settings/about')({
  component: AboutPage,
})

/**
 * The credit the free data behind the forms and the weather asks for. They
 * used to sit at the foot of every Settings tab; here they are once, where
 * someone looking for them will look.
 *
 * The suburb line is the G-NAF licence's own attribution, word for word as
 * the tables in src/lib/localities carry it (dataCredits.test.ts holds the
 * two together): G-NAF is not under the licence the map and weather data are,
 * and a wrong licence named here is a wrong notice for someone's data. Keep
 * each credit one unbroken string, so the test can find it.
 */
const DATA_CREDITS = [
  { source: 'Address suggestions', credit: '© OpenStreetMap contributors' },
  {
    source: 'Suburb data',
    credit:
      'G-NAF © Geoscape Australia, licensed by the Commonwealth of Australia under the Open G-NAF End User Licence Agreement',
  },
  { source: 'Weather', credit: 'Open-Meteo, MET Norway' },
] as const

function AboutPage() {
  const { business } = Route.useRouteContext()
  const { businessSlug } = Route.useParams()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="About"
        back={
          <BackLink to="/$businessSlug/settings" params={{ businessSlug }}>
            Settings
          </BackLink>
        }
      />

      <SettingsBody>
        {/* Which build this is, for "what version are you on?". */}
        <SettingsGroup title="PestM8">
          <SettingsRow title="Version" value={APP_VERSION} />
        </SettingsGroup>

        <SettingsGroup title="Data sources">
          {DATA_CREDITS.map(({ source, credit }) => (
            // Wrapped, never truncated like a row's value: a licence notice
            // cut off at the edge of a phone is not the notice.
            <div key={source} className="px-3.5 py-3">
              <p className="text-body text-ink">{source}</p>
              <p className="mt-0.5 text-caption text-muted">{credit}</p>
            </div>
          ))}
        </SettingsGroup>
      </SettingsBody>
    </>
  )
}
