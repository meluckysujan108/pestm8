import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { Segmented } from '#/components/primitives/Segmented'
import { TeamSection } from '#/components/settings/TeamSection'
import { ProfileSection } from '#/components/settings/ProfileSection'
import { PrefsSection } from '#/components/settings/PrefsSection'
import { BrandingSection } from '#/components/settings/BrandingSection'
import { OptionLibrariesSection } from '#/components/settings/OptionLibrariesSection'
import { ReportPolicySection } from '#/components/settings/ReportPolicySection'
import { useCan } from '#/lib/access'

const SEGMENTS = [
  { value: 'profile' as const, label: 'Profile' },
  { value: 'team' as const, label: 'Team' },
  { value: 'prefs' as const, label: 'Preferences' },
  { value: 'reports' as const, label: 'Reports' },
]

export const Route = createFileRoute('/$businessSlug/settings')({
  validateSearch: z.object({
    seg: z.enum(['profile', 'team', 'prefs', 'reports']).optional(),
  }),
  component: SettingsPage,
})

function SettingsPage() {
  const { business, membership } = Route.useRouteContext()
  const canManageTeam = useCan('team.manage')
  const canManageBusiness = useCan('business.manage')
  const canManageTemplates = useCan('templates.manage')
  const { seg } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const active = seg ?? 'profile'

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={business.name}
        title="Settings"
      />

      <div className="px-4 pt-4">
        <Segmented
          label="Settings section"
          value={active}
          options={
            // Each tab on the capability its contents need, not on a role: a
            // contractor manages their own team but not the business's forms
            // or policy, so they get Team and not Reports. A tab whose every
            // section refuses the person looking at it is worse than no tab.
            SEGMENTS.filter(
              (s) =>
                (s.value !== 'team' || canManageTeam) &&
                (s.value !== 'reports' || canManageTemplates || canManageBusiness),
            )
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
            phone={membership.phone}
            state={business.state}
          />
        )}
        {active === 'team' && canManageTeam && (
          <TeamSection businessId={business._id} />
        )}
        {active === 'reports' && (
          <>
            {/* The lists of answers the forms offer are form content. */}
            {canManageTemplates && (
              <OptionLibrariesSection businessId={business._id} />
            )}
            {/* Whether a job may close without a report is business policy. */}
            {canManageBusiness && (
              <div className={canManageTemplates ? 'mt-6' : undefined}>
                <ReportPolicySection businessId={business._id} />
              </div>
            )}
          </>
        )}
        {active === 'prefs' && (
          <>
            <PrefsSection
              businessId={business._id}
              business={business}
              canEdit={canManageBusiness}
            />
            {canManageBusiness && (
              <div className="mt-6">
                <BrandingSection businessId={business._id} business={business} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
