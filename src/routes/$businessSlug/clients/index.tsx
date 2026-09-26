import { useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Plus, Upload } from 'lucide-react'
import { z } from 'zod'
import { PageHeader } from '#/components/shell/PageHeader'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
  EmptyStateButton,
} from '#/components/primitives/EmptyState'
import { SearchBox } from '#/components/primitives/SearchBox'
import { NewPropertySheet } from '#/components/clients/NewPropertySheet'
import { ClientSheet } from '#/components/clients/ClientSheet'
import { ClientCard } from '#/components/clients/ClientCard'
import { ClientFilterBar } from '#/components/clients/ClientFilterBar'
import { useHydrated } from '#/lib/useHydrated'
import { matchesClientSearch, useClientFilters } from '#/lib/clientFilters'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'

export const Route = createFileRoute('/$businessSlug/clients/')({
  // One way to read clients: the cards. The List and Table views were
  // retired, and `view` with them — the key is gone rather than narrowed, so
  // an old `?view=list` or `?view=table` link passes validation and opens the
  // cards. The stale key stays in the address bar until the first search.
  validateSearch: z.object({
    q: z.string().optional(),
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
  const { q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const hydrated = useHydrated()

  // Both lists are per-business and small (matches the same precedent the
  // Reports dashboard already established) — fetched once, unpaginated, and
  // filtered client-side, which is what lets search match name, address, ABN
  // or site contact in one pass rather than needing Convex search indexes
  // merged.
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

    const term = q ?? ''
    if (term.trim() === '') return withProperties
    return withProperties.filter((row) => matchesClientSearch(row, term))
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
        title="Clients"
        action={
          <>
            {/* Beside the +, quieter than it: most days a client is added
                one at a time, and a list is brought across once. A link,
                so it works before the page has hydrated. Only for those
                who may import — the server refuses anyone else. */}
            {canManageClients && (
              <Link
                to="/$businessSlug/clients/import"
                params={{ businessSlug: business.slug }}
                aria-label="Import clients"
                className="relative tap-target flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-[15px] font-semibold text-blue transition active:scale-[.97]"
              >
                <Upload aria-hidden size={16} strokeWidth={2.2} />
                Import
              </Link>
            )}
            <button
              type="button"
              aria-label="New client"
              disabled={!hydrated}
              onClick={() => setNewOpen(true)}
              className="relative tap-target flex size-9 items-center justify-center rounded-full bg-red-fill text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </>
        }
      />

      <div className="flex px-4 pt-3">
        {/* The shared box, not a bare input bound to the URL: that navigated
            on every keystroke and, while a navigation was in flight, put the
            committed term back over whatever had been typed since. The
            search is `q` alone now — the only thing this page keeps in the
            URL — which also drops a retired `?view=` an old link brought in,
            since the router carries unknown keys along otherwise. */}
        <SearchBox
          value={q ?? ''}
          onChange={(term) =>
            navigate({ search: { q: term || undefined }, replace: true })
          }
          label="Search by name or address"
          placeholder="Search by name or address"
        />
      </div>

      <section className="px-4 pt-4 pb-6">
        <div className="mb-3">
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
            action={
              !(q || filtersActive) && (
                <div className="flex flex-wrap justify-center gap-2">
                  <EmptyStateButton
                    onClick={() => setNewOpen(true)}
                    disabled={!hydrated}
                  >
                    Add a client
                  </EmptyStateButton>
                  {/* A business moving from another app has hundreds, not
                      one: the list is where most of them start. */}
                  {canManageClients && (
                    <Link
                      to="/$businessSlug/clients/import"
                      params={{ businessSlug: business.slug }}
                      className={EMPTY_ACTION_CLASS}
                    >
                      Import a list
                    </Link>
                  )}
                </div>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch">
            {filteredRows.map(({ client, properties: owned }) => (
              <ClientCard
                key={client._id}
                client={client}
                properties={owned}
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
        businessState={business.state}
        isOwner={canManageClients}
        clientId={openId}
        onClose={() => setOpenId(null)}
      />
    </>
  )
}
