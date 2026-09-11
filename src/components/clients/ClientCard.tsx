import { Building2, User } from 'lucide-react'
import type { ClientKind } from '#/lib/clientFilters'

export type ClientRow = {
  _id: string
  name: string
  kind: ClientKind
}

export type ClientPropertyRow = {
  addressLine: string
  suburb: string
}

/**
 * `list` is the compact row for scanning many clients; `board` is the richer
 * card for reading one — same split as `JobCardVariant`, same reason: one
 * component so a field added to one variant cannot quietly go missing from
 * the other.
 */
export type ClientCardVariant = 'list' | 'board'

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
 * several, or an explicit "no properties" — mirrors the original flat
 * client card's exact branching, just split across a primary/secondary line
 * so both card variants can use it. */
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

export function ClientCard({
  client,
  properties,
  variant = 'list',
  onOpen,
}: {
  client: ClientRow
  properties: Array<ClientPropertyRow>
  variant?: ClientCardVariant
  onOpen: (clientId: string) => void
}) {
  // No colour rail (unlike JobCard) — a client has no per-row identity
  // dimension the way a job's assignee does. `items-start`/`flex-col` are set
  // per variant below rather than baked in here, since the two need
  // different flex-direction and gap values.
  const shell =
    'flex w-full rounded-2xl border border-hairline bg-surface text-left shadow-elevation transition active:scale-[.99]'
  const { Icon } = KIND_STYLE[client.kind]
  const { primary, secondary } = propertySummary(properties)

  if (variant === 'list') {
    return (
      <button
        type="button"
        onClick={() => onOpen(client._id)}
        className={`${shell} items-start gap-3 p-4`}
      >
        <Icon
          size={17}
          strokeWidth={1.7}
          aria-hidden
          className="mt-0.5 shrink-0 text-muted"
        />
        <span className="min-w-0 flex-1">
          <span className="truncate text-sheet-title text-ink">
            {client.name}
          </span>

          <span className="mt-1 block truncate text-body text-ink-2">
            {primary}
          </span>

          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-caption text-muted">
              {secondary}
            </span>
            <ClientKindPill kind={client.kind} />
          </span>
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(client._id)}
      className={`${shell} h-full flex-col gap-3 p-4`}
    >
      <span className="flex items-center justify-between gap-2">
        <ClientKindPill kind={client.kind} />
        <Icon size={17} strokeWidth={1.7} aria-hidden className="shrink-0 text-muted" />
      </span>

      <span className="block min-w-0">
        <span className="block truncate text-sheet-title text-ink">
          {client.name}
        </span>
        <span className="mt-0.5 block truncate text-caption text-muted">
          {primary}
        </span>
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
