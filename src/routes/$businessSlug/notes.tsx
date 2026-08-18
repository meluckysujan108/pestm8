import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Trash2 } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/$businessSlug/notes')({
  component: NotesPage,
})

function NotesPage() {
  const { business } = Route.useRouteContext()
  const [text, setText] = useState('')
  const [propertyId, setPropertyId] = useState('')

  const { data: notes } = useSuspenseQuery(
    convexQuery(api.notes.list, { businessId: business._id }),
  )
  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.list, { businessId: business._id }),
  )

  const hydrated = useHydrated()

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      text: string
      propertyId?: Id<'properties'>
    }) => convexCreate(args),
    onSuccess: () => setText(''),
  })

  const convexRemove = useConvexMutation(api.notes.remove)
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; noteId: Id<'notes'> }) =>
      convexRemove(args),
  })

  return (
    <>
      <PageHeader kicker={business.name} title="Notes" />

      <form
        className="px-4 pt-4"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate({
            businessId: business._id,
            text,
            propertyId: propertyId
              ? (propertyId as Id<'properties'>)
              : undefined,
          })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">Note</span>
          <textarea
            value={text}
            rows={3}
            placeholder="Gate code, dog on site, where the key lives…"
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-xl bg-surface-3 p-3.5 text-[16px] leading-relaxed text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        {properties.length > 0 && (
          <label className="mt-2 flex flex-col gap-1.5">
            <span className="section-label">Attach to a property</span>
            <select
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            >
              <option value="">No property</option>
              {properties.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.clientName} — {p.suburb}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="submit"
          disabled={create.isPending || !hydrated || text.trim() === ''}
          className="mt-3 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {create.isPending ? 'Saving…' : 'Add note'}
        </button>
      </form>

      <section className="px-4 pt-6 pb-6">
        {notes.length === 0 ? (
          <EmptyState
            title="No notes yet"
            body="Anything the team should know before turning up."
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {notes.map((note) => (
              <article
                key={note._id}
                className="flex gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
              >
                <span
                  aria-hidden
                  className="w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: note.authorColour }}
                />
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-body text-ink">
                    {note.text}
                  </p>
                  <p className="mt-1.5 text-caption text-muted">
                    {note.clientName && (
                      <span className="text-blue">
                        {note.clientName}
                        {note.suburb ? ` · ${note.suburb}` : ''}
                        {' · '}
                      </span>
                    )}
                    {new Intl.DateTimeFormat('en-AU', {
                      timeZone: business.timezone,
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(note.createdAt))}
                  </p>
                </div>
                {note.mine && (
                  <button
                    type="button"
                    aria-label="Delete note"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate({
                        businessId: business._id,
                        noteId: note._id,
                      })
                    }
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-50"
                  >
                    <Trash2 size={15} strokeWidth={1.7} />
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
