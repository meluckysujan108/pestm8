import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { BackLink } from '#/components/settings/ui'
import { InstallSettings } from '#/components/install/InstallSettings'

export const Route = createFileRoute('/$businessSlug/settings/install')({
  component: InstallPage,
})

/**
 * Settings → Install app: how to put PestM8 on this device, whatever it is.
 * It used to be offered once, at the end of set-up, so whoever deleted the
 * app had nowhere to find the way back. The steps are the ones the sign-in
 * screen and the schedule's card show (components/install/).
 */
function InstallPage() {
  const { business } = Route.useRouteContext()
  const { businessSlug } = Route.useParams()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Install app"
        back={
          <BackLink to="/$businessSlug/settings" params={{ businessSlug }}>
            Settings
          </BackLink>
        }
      />
      <InstallSettings />
    </>
  )
}
