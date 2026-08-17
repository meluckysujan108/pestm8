import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'

export const Route = createFileRoute('/$businessSlug/reports/')({
  component: ReportsPage,
})

function ReportsPage() {
  return <PageHeader title="Reports" />
}
