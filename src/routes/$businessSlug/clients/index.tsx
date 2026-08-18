import { useState } from 'react'
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
  const { business } = Route.useRouteContext()
  const { q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const hydrated = useHydrated()

  const { data: properties } = useSuspenseQuery(
    convexQuery(api.properties.search, {
      businessId: business._id,
      q: q ?? '',
    }),
  )

  return (
    <>
      <PageHeader
        kicker={`${properties.length} ${properties.length === 1 ? 'property' : 'properties'}`}
        title="Clients"
        action={
          <button
            type="button"
            aria-label="New property"
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
          <span className="sr-only">Search by address</span>
          <input
            value={q ?? ''}
            onChange={(e) =>
              navigate({
                search: { q: e.target.value || undefined },
                replace: true,
              })
            }
            placeholder="Search by address"
            className="h-11 flex-1 bg-transparent text-[16px] text-ink outline-none"
          />
        </label>
      </div>

      <section className="px-4 pt-4 pb-6">
        {properties.length === 0 ? (
          <EmptyState
            title={q ? 'No matches' : 'No properties yet'}
            body={
              q
                ? 'Try a different street or suburb.'
                : 'Add a property to start booking work against it.'
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {properties.map((p) => (
              <button
                key={p._id}
                type="button"
                onClick={() => setOpenId(p._id)}
                className="w-full rounded-2xl border border-hairline bg-surface p-3.5 text-left shadow-elevation transition active:scale-[.99]"
              >
                <p className="text-row-title text-ink">{p.clientName}</p>
                <p className="mt-0.5 truncate text-body text-ink-2">
                  {p.addressLine}
                </p>
                {/* Suburb on the row; the full address lives in the detail. */}
                <p className="mt-0.5 text-caption text-muted">{p.suburb}</p>
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
        propertyId={openId}
        onClose={() => setOpenId(null)}
      />
    </>
  )
}
