import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { Mail, Phone, X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { HoldButton } from '#/components/primitives/HoldButton'
import { StatusPill } from '#/components/primitives/StatusPill'
import { formatMoney } from '#/lib/format'
import type { Id } from '../../../convex/_generated/dataModel'

export function ClientSheet({
  businessId,
  timezone,
  propertyId,
  onClose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  propertyId: string | null
  onClose: () => void
}) {
  return (
    <Drawer.Root open={propertyId !== null} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          {propertyId !== null && (
            <ClientBody
              businessId={businessId}
              timezone={timezone}
              propertyId={propertyId as Id<'properties'>}
            />
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function ClientBody({
  businessId,
  timezone,
  propertyId,
}: {
  businessId: Id<'businesses'>
  timezone: string
  propertyId: Id<'properties'>
}) {
  const { data: property } = useQuery(
    convexQuery(api.properties.get, { businessId, propertyId }),
  )
  const { data: history } = useQuery(
    convexQuery(api.properties.jobHistory, { businessId, propertyId }),
  )

  if (!property) {
    return (
      <div className="px-4 py-10">
        <Drawer.Title className="sr-only">Property</Drawer.Title>
        <p className="text-body text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
      <Drawer.Title className="text-sheet-title text-ink">
        {property.clientName}
      </Drawer.Title>
      <p className="mt-1 text-body text-ink-2">{property.addressLine}</p>
      <p className="text-body text-muted">
        {property.suburb} {property.state} {property.postcode}
      </p>

      {(property.phone || property.email) && (
        <div className="mt-4 flex gap-2">
          {property.phone && (
            <HoldButton
              ariaLabel={`Call ${property.clientName}`}
              onComplete={() => {
                window.location.href = `tel:${property.phone}`
              }}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 py-3 text-body font-semibold text-blue"
            >
              <Phone size={17} strokeWidth={1.7} />
              Hold to call
            </HoldButton>
          )}
          {property.email && (
            <HoldButton
              ariaLabel={`Email ${property.clientName}`}
              onComplete={() => {
                window.location.href = `mailto:${property.email}`
              }}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 py-3 text-body font-semibold text-blue"
            >
              <Mail size={17} strokeWidth={1.7} />
              Hold to email
            </HoldButton>
          )}
        </div>
      )}

      <h3 className="section-label mb-2 mt-6">Job history</h3>
      {!history || history.length === 0 ? (
        <p className="rounded-2xl border border-hairline bg-surface px-3.5 py-6 text-center text-body text-muted shadow-elevation">
          No visits recorded yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {history.map((job) => (
            <div
              key={job._id}
              className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-row-title text-ink">{job.jobType}</span>
                <span className="text-body text-ink">
                  {formatMoney(job.price)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-secondary text-muted">
                  {new Intl.DateTimeFormat('en-AU', {
                    timeZone: timezone,
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  }).format(new Date(job.scheduledAt))}
                </span>
                <StatusPill status={job.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
