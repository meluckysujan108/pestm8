import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'

export const Route = createFileRoute('/$businessSlug/leads')({
  component: LeadsPage,
})

/**
 * Not built yet. It has a route and a place in the More menu so the navigation
 * is the one the app is growing into, and so the section lands here later
 * rather than forcing the nav to be rearranged around it.
 */
function LeadsPage() {
  const { business } = Route.useRouteContext()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={business.name}
        title="Leads"
      />
      <section className="px-4 pt-4 pb-6">
        <EmptyState
          title="Leads are coming"
          body="Enquiries that have not become clients yet will be tracked here."
        />
      </section>
    </>
  )
}
