import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { SearchBox } from '#/components/primitives/SearchBox'
import { NewPropertySheet } from '#/components/clients/NewPropertySheet'
import { ClientSheet } from '#/components/clients/ClientSheet'
import { ClientCard } from '#/components/clients/ClientCard'
import { ClientTable } from '#/components/clients/ClientTable'
import { ClientFilterBar } from '#/components/clients/ClientFilterBar'
import { Segmented } from '#/components/primitives/Segmented'
import { useHydrated } from '#/lib/useHydrated'
import { useClientFilters } from '#/lib/clientFilters'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'

const VIEW_OPTIONS: Array<{
  value: 'list' | 'board' | 'table'
  label: string
}> = [
  { value: 'list', label: 'List' },
  { value: 'board', label: 'Board' },
  { value: 'table', label: 'Table' },
]

export const Route = createFileRoute('/$businessSlug/clients/')({
  // `view` mirrors the Schedule route exactly: the way an operator prefers
  // to read their client list should survive a refresh, same as the way
  // they prefer to read their day.
  validateSearch: z.object({
    q: z.string().optional(),
    view: z.enum(['list', 'board', 'table']).optional(),
  }),
  // Both lists together, before the page renders: read in order, the
  // properties were not asked for until the clients had come back.
  loader: ({ context: { queryClient, business } }) =>
    warm(queryClient, rq.clients(business._id), rq.properties(business._id)),
  component: ClientsPage,
})

function ClientsPage() {
  const { business } = Route.useRouteContext()
  const canManageClients = useCan('clients.manage')
  const { q, view } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const activeView = view ?? 'board'
  const setView = (next: 'list' | 'board' | 'table') =>
    navigate({ search: (prev) => ({ ...prev, view: next }), replace: true })
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const hydrated = useHydrated()

  // Both lists are per-business and small (matches the same precedent the
  // Reports dashboard already established) — fetched once, unpaginated, and
  // filtered client-side, which is what lets search match name OR address in
  // one pass rather than needing two Convex search indexes merged.
  const { data: clients } = useSuspenseQuery(rq.clients(business._id))
  const { data: properties } = useSuspenseQuery(rq.properties(business._id))

  const rows = useMemo(() => {
    const propertiesByClient = new Map<string, typeof properties>()
    for (const property of properties) {
      const list = propertiesByClient.get(property.clientId) ?? []
      list.push(property)
      propertiesByClient.set(property.clientId, list)
    }

    const withProperties = clients.map((client) => ({
      client,
      properties: propertiesByClient.get(client._id) ?? [],
    }))

    const query = (q ?? '').trim().toLowerCase()
    if (query === '') return withProperties

    return withProperties.filter(({ client, properties: owned }) => {
      const haystack = [
        client.name,
        ...owned.flatMap((p) => [p.addressLine, p.suburb]),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [clients, properties, q])

  const { kind, setKind, suburb, setSuburb, filteredRows } =
    useClientFilters(rows)
  const filtersActive = kind !== 'all' || suburb !== 'all'

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
        title="Client"
        action={
          <button
            type="button"
            aria-label="New client"
            disabled={!hydrated}
            onClick={() => setNewOpen(true)}
            className="flex size-9 items-center justify-center rounded-full bg-red text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
        }
      />

      <div className="flex px-4 pt-3">
        {/* The shared box, not a bare input bound to the URL: that navigated
            on every keystroke and, while a navigation was in flight, put the
            committed term back over whatever had been typed since. It also
            passed `{ q }` alone, which dropped `view` with every character. */}
        <SearchBox
          value={q ?? ''}
          onChange={(term) =>
            navigate({
              search: (prev) => ({ ...prev, q: term || undefined }),
              replace: true,
            })
          }
          label="Search by name or address"
          placeholder="Search by name or address"
        />
      </div>

      <section className="px-4 pt-4 pb-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented
            label="View"
            value={activeView}
            options={VIEW_OPTIONS}
            onChange={setView}
          />
          <ClientFilterBar
            rows={rows}
            kind={kind}
            setKind={setKind}
            suburb={suburb}
            setSuburb={setSuburb}
          />
        </div>

        {filteredRows.length === 0 ? (
          <EmptyState
            title={q || filtersActive ? 'No matches' : 'No clients yet'}
            body={
              q || filtersActive
                ? 'Try a different name, address, or filter.'
                : 'Add a client to start booking work for them.'
            }
          />
        ) : activeView === 'table' ? (
          <ClientTable rows={filteredRows} onOpenClient={setOpenId} />
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch">
            {filteredRows.map(({ client, properties: owned }) => (
              <ClientCard
                key={client._id}
                client={client}
                properties={owned}
                variant={activeView}
                onOpen={setOpenId}
              />
            ))}
          </div>
        )}
      </section>

      <NewPropertySheet
        businessId={business._id}
        open={newOpen}
        onClose={() => setNewOpen(false)}
      />

      <ClientSheet
        businessId={business._id}
        timezone={business.timezone}
        businessSlug={business.slug}
        isOwner={canManageClients}
        clientId={openId}
        onClose={() => setOpenId(null)}
      />
    </>
  )
}
