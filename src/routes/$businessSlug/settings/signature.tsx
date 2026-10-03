import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { MySignature } from '#/components/settings/MySignature'
import { BackLink } from '#/components/settings/ui'

export const Route = createFileRoute('/$businessSlug/settings/signature')({
  component: MySignaturePage,
})

/** Settings → My signature (`MySignature`). */
function MySignaturePage() {
  const { business } = Route.useRouteContext()
  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="My signature"
        back={
          <BackLink
            to="/$businessSlug/settings"
            params={{ businessSlug: business.slug }}
          >
            Settings
          </BackLink>
        }
      />
      <MySignature businessId={business._id} />
    </>
  )
}
