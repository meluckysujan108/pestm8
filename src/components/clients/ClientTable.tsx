import { ClientKindPill } from './ClientCard'
import type { ClientPropertyRow, ClientRow } from './ClientCard'

/**
 * Dense alternative to the client card grid — same rows, same click target,
 * laid out for scanning many clients at once. Mirrors `JobTable` exactly
 * (same wrapper, same no-library reasoning: a business's client list is
 * never big enough to need sorting/pagination machinery); columns are the
 * client-correct set rather than a copy of the job columns.
 */
export function ClientTable({
  rows,
  onOpenClient,
}: {
  rows: Array<{ client: ClientRow; properties: Array<ClientPropertyRow> }>
  onOpenClient: (clientId: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface shadow-elevation">
      <table className="w-full min-w-[640px] text-left">
        <thead>
          <tr className="border-b border-hairline text-section-label text-muted">
            <th className="px-4 py-2.5 font-bold">Name</th>
            <th className="px-2 py-2.5 font-bold">Type</th>
            <th className="px-2 py-2.5 font-bold">Address</th>
            <th className="px-2 py-2.5 font-bold">Suburb</th>
            <th className="px-4 py-2.5 text-right font-bold">Properties</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map(({ client, properties }) => (
            <tr
              key={client._id}
              onClick={() => onOpenClient(client._id)}
              className="cursor-pointer transition hover:bg-surface-2"
            >
              <td className="px-4 py-2.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenClient(client._id)
                  }}
                  className="text-left text-row-title text-ink"
                >
                  {client.name}
                </button>
              </td>
              <td className="px-2 py-2.5">
                <ClientKindPill kind={client.kind} />
              </td>
              <td className="px-2 py-2.5 text-body text-ink-2">
                {properties.length === 1 ? properties[0].addressLine : '—'}
              </td>
              <td className="px-2 py-2.5 text-caption text-muted">
                {properties.length === 1
                  ? properties[0].suburb
                  : [...new Set(properties.map((p) => p.suburb).filter(Boolean))].join(', ') || '—'}
              </td>
              <td className="px-4 py-2.5 text-right text-caption tabular-nums text-muted">
                {properties.length}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
