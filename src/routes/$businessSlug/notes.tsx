import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/shell/PageHeader'

export const Route = createFileRoute('/$businessSlug/notes')({
  component: NotesPage,
})

function NotesPage() {
  return <PageHeader title="Notes" />
}
