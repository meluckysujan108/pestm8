import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Plus, Search } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { NewPropertySheet } from '#/components/clients/NewPropertySheet'
import { ClientSheet } from '#/components/clients/ClientSheet'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/$businessSlug/clients/')({
  validateSearch: z.object({ q: z.string().optional() }),
  component: ClientsPage,
})

function ClientsPage() {
  const { business, membership } = Route.useRouteContext()
  const { q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const hydrated = useHydrated()

  // Both lists are per-business and small (matches the same precedent the
  // Reports dashboard already established) — fetched once, unpaginated, and
  // filtered client-side, which is what lets search match name OR address in
  // one pass rather than needing two Convex search indexes merged.
  const { data: clients } = useSuspenseQuery(
    convexQuery(api.clients.list, { businessId: business._id }),
  )
  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.list, { businessId: business._id }),
  )

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

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={`${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
        title="Clients"
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

      <div className="px-4 pt-3">
        <label className="flex items-center gap-2 rounded-xl bg-surface-3 px-3">
          <Search size={17} strokeWidth={1.7} className="text-muted" />
          <span className="sr-only">Search by name or address</span>
          <input
            value={q ?? ''}
            onChange={(e) =>
              navigate({
                search: { q: e.target.value || undefined },
                replace: true,
              })
            }
            placeholder="Search by name or address"
            className="h-11 flex-1 bg-transparent text-[16px] text-ink outline-none"
          />
        </label>
      </div>

      <section className="px-4 pt-4 pb-6">
        {rows.length === 0 ? (
          <EmptyState
            title={q ? 'No matches' : 'No clients yet'}
            body={
              q
                ? 'Try a different name or address.'
                : 'Add a client to start booking work for them.'
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map(({ client, properties: owned }) => (
              <button
                key={client._id}
                type="button"
                onClick={() => setOpenId(client._id)}
                className="w-full rounded-2xl border border-hairline bg-surface p-3.5 text-left shadow-elevation transition active:scale-[.99]"
              >
                <p className="text-row-title text-ink">{client.name}</p>
                {owned.length === 1 ? (
                  <>
                    <p className="mt-0.5 truncate text-body text-ink-2">
                      {owned[0].addressLine}
                    </p>
                    <p className="mt-0.5 text-caption text-muted">
                      {owned[0].suburb}
                    </p>
                  </>
                ) : (
                  <p className="mt-0.5 text-caption text-muted">
                    {owned.length === 0
                      ? 'No properties yet'
                      : `${owned.length} properties`}
                  </p>
                )}
              </button>
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
        isOwner={membership.role === 'owner'}
        clientId={openId}
        onClose={() => setOpenId(null)}
      />
    </>
  )
}
