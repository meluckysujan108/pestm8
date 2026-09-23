import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { NotesLibrary } from '#/components/notes/NotesLibrary'
import { notesFirstPage, rq, searchParam, warm } from '#/lib/routeQueries'
import type { Id } from '../../../convex/_generated/dataModel'
import type { LibraryFilter } from '#/components/notes/NoteList'

const searchSchema = z.object({
  // Which "folder" is open, the open note and the search term all live in
  // the URL, as the schedule's day and job do: a refresh lands you back on
  // the same note, and a mention can link straight to one.
  filter: z.enum(['all', 'mentions', 'jobs', 'sites', 'team', 'trash']).optional(),
  noteId: z.string().optional(),
  q: z.string().optional(),
})

export const Route = createFileRoute('/$businessSlug/notes')({
  validateSearch: searchSchema,
  // The roster the library suspends on, the folder's first page, and whatever
  // that folder draws above it.
  loader: ({ context: { queryClient, business }, location }) => {
    const filter = (searchParam(location, 'filter') ?? 'all') as LibraryFilter
    const searching = (searchParam(location, 'q') ?? '') !== ''
    const paged = !searching && filter !== 'mentions'
    return warm(
      queryClient,
      rq.roster(business._id),
      ...(paged ? [notesFirstPage(business._id, filter)] : []),
      ...(paged && filter === 'all' ? [rq.notesPinned(business._id)] : []),
      ...(!searching && filter === 'mentions'
        ? [rq.notesMentions(business._id)]
        : []),
    )
  },
  component: NotesPage,
})

function NotesPage() {
  const { business } = Route.useRouteContext()
  const { filter, noteId, q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <NotesLibrary
      business={business}
      filter={filter ?? 'all'}
      noteId={(noteId as Id<'notes'> | undefined) ?? null}
      query={q ?? ''}
      onFilter={(next) =>
        navigate({
          search: (prev) => ({ ...prev, filter: next === 'all' ? undefined : next, noteId: undefined }),
          replace: true,
        })
      }
      onOpen={(id) =>
        navigate({ search: (prev) => ({ ...prev, noteId: id ?? undefined }), replace: id === null })
      }
      onCreated={(id, keepFolder) =>
        navigate({
          search: (prev) => ({
            ...prev,
            filter: keepFolder ? prev.filter : undefined,
            q: undefined,
            noteId: id,
          }),
        })
      }
      onQuery={(next) =>
        navigate({ search: (prev) => ({ ...prev, q: next || undefined }), replace: true })
      }
    />
  )
}
