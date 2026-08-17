import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'

export const Route = createFileRoute('/$businessSlug/invoices')({
  component: InvoicesPage,
})

function InvoicesPage() {
  return <PageHeader title="Invoices" />
}
