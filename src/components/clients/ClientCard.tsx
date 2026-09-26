import { Building2, User } from 'lucide-react'
import {
  ClientStatusPill,
  TagChips,
  clientNumberLabel,
} from '#/components/clients/ClientRecordBits'
import type { ClientKind } from '#/lib/clientFilters'
import type { ClientStatus } from '../../../convex/lib/clientRecord'

export type ClientRow = {
  _id: string
  name: string
  kind: ClientKind
  clientNumber?: number
  status?: ClientStatus
  tags?: Array<string>
}

export type ClientPropertyRow = {
  addressLine: string
  suburb: string
}

const KIND_STYLE: Record<ClientKind, { label: string; className: string; Icon: typeof Building2 }> = {
  business: { label: 'Business', className: 'bg-surface-2 text-ink-2', Icon: Building2 },
  person: { label: 'Person', className: 'bg-surface-2 text-ink-2', Icon: User },
}

/** Business/person, in the exact slot `StatusPill` occupies on a job card —
 * the closest thing a client has to a job's status: the one categorical
 * fact that's always true and worth a glance. */
export function ClientKindPill({ kind }: { kind: ClientKind }) {
  const { label, className } = KIND_STYLE[kind]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${className}`}
    >
      {label}
    </span>
  )
}

/** "12 Wattle Street, Bayswater" for one property, a suburb summary for
 * several, or an explicit "no properties", split across a primary and a
 * secondary line. */
function propertySummary(properties: Array<ClientPropertyRow>): {
  primary: string
  secondary: string
} {
  if (properties.length === 0) return { primary: 'No properties yet', secondary: '' }
  if (properties.length === 1) {
    return { primary: properties[0].addressLine, secondary: properties[0].suburb }
  }
  const suburbs = [...new Set(properties.map((p) => p.suburb).filter(Boolean))]
  const shown = suburbs.slice(0, 2).join(', ')
  const rest = suburbs.length > 2 ? ` +${suburbs.length - 2}` : ''
  return {
    primary: `${properties.length} properties`,
    secondary: `${shown}${rest}`,
  }
}

/**
 * A client, as the Clients page shows it: the one way that page reads (its
 * List and Table views were retired). No colour rail, unlike JobCard — a
 * client has no per-row identity dimension the way a job's assignee does.
 */
export function ClientCard({
  client,
  properties,
  onOpen,
}: {
  client: ClientRow
  properties: Array<ClientPropertyRow>
  onOpen: (clientId: string) => void
}) {
  const shell =
    'flex w-full rounded-2xl border border-hairline bg-surface text-left shadow-elevation transition active:scale-[.99]'
  const { Icon } = KIND_STYLE[client.kind]
  const { primary, secondary } = propertySummary(properties)

  return (
    <button
      type="button"
      onClick={() => onOpen(client._id)}
      className={`${shell} h-full flex-col gap-3 p-4`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ClientKindPill kind={client.kind} />
          <ClientStatusPill status={client.status} />
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {client.clientNumber !== undefined && (
            <span className="text-caption font-semibold tabular-nums text-muted">
              {clientNumberLabel(client.clientNumber)}
            </span>
          )}
          <Icon size={17} strokeWidth={2} aria-hidden className="shrink-0 text-muted" />
        </span>
      </span>

      <span className="block min-w-0">
        <span className="block truncate text-sheet-title text-ink">
          {client.name}
        </span>
        <span className="mt-0.5 block truncate text-caption text-muted">
          {primary}
        </span>
        {client.tags && client.tags.length > 0 && (
          <span className="mt-2 block">
            <TagChips tags={client.tags} max={3} />
          </span>
        )}
      </span>

      <span className="mt-auto flex items-end justify-between gap-2 border-t border-hairline-2 pt-3">
        <span className="min-w-0 truncate text-caption text-muted">
          {secondary}
        </span>
        <span className="shrink-0 text-row-title text-ink">
          {properties.length === 1
            ? '1 property'
            : `${properties.length} properties`}
        </span>
      </span>
    </button>
  )
}
