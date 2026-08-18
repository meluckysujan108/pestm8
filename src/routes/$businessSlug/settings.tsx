import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { Segmented } from '#/components/primitives/Segmented'
import { TeamSection } from '#/components/settings/TeamSection'
import { ProfileSection } from '#/components/settings/ProfileSection'
import { PrefsSection } from '#/components/settings/PrefsSection'

const SEGMENTS = [
  { value: 'profile' as const, label: 'Profile' },
  { value: 'team' as const, label: 'Team' },
  { value: 'prefs' as const, label: 'Preferences' },
]

export const Route = createFileRoute('/$businessSlug/settings')({
  validateSearch: z.object({
    seg: z.enum(['profile', 'team', 'prefs']).optional(),
  }),
  component: SettingsPage,
})

function SettingsPage() {
  const { business, membership } = Route.useRouteContext()
  const { seg } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const active = seg ?? 'profile'

  return (
    <>
      <PageHeader kicker={business.name} title="Settings" />

      <div className="px-4 pt-4">
        <Segmented
          label="Settings section"
          value={active}
          options={
            // Team management is an owner concern; a subcontractor has no
            // roster to manage and shouldn't see a tab that rejects them.
            membership.role === 'owner'
              ? SEGMENTS
              : SEGMENTS.filter((s) => s.value !== 'team')
          }
          onChange={(value) =>
            navigate({ search: { seg: value }, replace: true })
          }
        />
      </div>

      <div className="px-4 pt-5 pb-6">
        {active === 'profile' && (
          <ProfileSection
            businessId={business._id}
            membershipId={membership._id}
            licenceNumber={membership.licenceNumber}
            state={business.state}
          />
        )}
        {active === 'team' && membership.role === 'owner' && (
          <TeamSection businessId={business._id} />
        )}
        {active === 'prefs' && <PrefsSection business={business} />}
      </div>
    </>
  )
}
