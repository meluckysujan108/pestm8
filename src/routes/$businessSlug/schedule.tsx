import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'

export const Route = createFileRoute('/$businessSlug/schedule')({
  component: SchedulePage,
})

function SchedulePage() {
  return <PageHeader title="Schedule" />
}
