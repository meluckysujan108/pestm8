import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { ReportSettingsForm } from '#/components/settings/ReportSettingsForm'
import {
  BackLink,
  SettingsBody,
  SettingsGroup,
  SettingsLinkRow,
} from '#/components/settings/ui'
import { useActing, useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its query, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/reports/')({
  // The report settings, for whoever may read them. `access.me` is already
  // in the cache (the layout's beforeLoad warms it), so reading the
  // capability here costs nothing and keeps anyone without business.manage
  // from asking for a query the server refuses them.
  //
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and the page has its own answer for late data (the
  // fields stay locked until it lands).
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    return settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        ...(access?.caps['business.manage'] === true
          ? [rq.reportSettings(business._id)]
          : []),
      ),
    )
  },
  component: ReportSettingsPage,
})

function ReportSettingsPage() {
  const { business } = Route.useRouteContext()
  // Two capabilities, two halves of the page: how reports look, go out and
  // hold up a job is business policy (business.manage); the forms and the
  // answers they offer are form content (templates.manage). Each group asks
  // for its own, so nobody is offered what the server would refuse.
  const canManageBusiness = useCan('business.manage')
  const canManageTemplates = useCan('templates.manage')
  const { isSwitched } = useActing()

  const forms = canManageTemplates ? (
    <SettingsGroup title="Forms">
      <SettingsLinkRow
        to="/$businessSlug/reports/templates"
        params={{ businessSlug: business.slug }}
        title="Forms"
        subtitle="Cover, form name and who signs"
      />
      <SettingsLinkRow
        to="/$businessSlug/settings/reports/answers"
        params={{ businessSlug: business.slug }}
        title="Answer lists"
        subtitle="Products and treatments your forms offer"
      />
    </SettingsGroup>
  ) : null

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Report settings"
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
          <ReportSettingsForm
            businessId={business._id}
            businessSlug={business.slug}
            businessName={business.name}
            forms={forms}
          />
        ) : canManageTemplates ? (
          forms
        ) : (
          // Opened by URL, or an owner working inside someone else's account
          // (the server drops their business capabilities for the length of
          // the switch): a plain answer, not a page of refusals.
          <EmptyState
            title="Only the business owner can change these."
            body={
              isSwitched
                ? 'Switch back to your own account to change them.'
                : undefined
            }
          />
        )}
      </SettingsBody>
    </>
  )
}
