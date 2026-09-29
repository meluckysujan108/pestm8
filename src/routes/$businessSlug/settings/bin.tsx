import { Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import { EmptyState } from '#/components/primitives/EmptyState'
import { RecycleBinList } from '#/components/settings/RecycleBin'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { useActing, useCan } from '#/lib/access'

export const Route = createFileRoute('/$businessSlug/settings/bin')({
  component: BinPage,
})

/**
 * Settings → Recycle bin: the clients, properties, jobs and recurring
 * services someone deleted, and the way to bring each back (convex/bin.ts).
 *
 * The owner's, like the server's `bin.list`: read live, so an owner working
 * inside someone else's account sees "Owners only" the moment the server
 * stops answering them here.
 */
function BinPage() {
  const { business } = Route.useRouteContext()
  const canManageBusiness = useCan('business.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Recycle bin"
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
          <Suspense fallback={<SectionPending />}>
            <RecycleBinList
              businessId={business._id}
              timezone={business.timezone}
            />
          </Suspense>
        ) : (
          <EmptyState
            title="Owners only"
            body={
              isSwitched
                ? 'Only the business owner can see what has been deleted and restore it. Switch back to your own account to open the Recycle bin.'
                : 'Only the business owner can see what has been deleted and restore it.'
            }
          />
        )}
      </SettingsBody>
    </>
  )
}
