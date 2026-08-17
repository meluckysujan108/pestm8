import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'

export const Route = createFileRoute('/$businessSlug/clients/')({
  component: ClientsPage,
})

function ClientsPage() {
  return <PageHeader title="Clients" />
}
