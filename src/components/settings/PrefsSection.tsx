import { AU_STATES } from '#/lib/au'

export function PrefsSection({
  business,
}: {
  business: { name: string; state: string; timezone: string }
}) {
  const stateName =
    AU_STATES.find((s) => s.code === business.state)?.name ?? business.state

  return (
    <>
      <h2 className="section-label mb-2">Business</h2>
      <dl className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        <Row label="Name" value={business.name} />
        <Row label="State" value={stateName} />
        <Row label="Timezone" value={business.timezone} />
      </dl>

      <p className="mt-2 text-secondary text-muted">
        State determines your timezone and how licence fields are labelled.
      </p>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3.5 py-3">
      <dt className="section-label">{label}</dt>
      <dd className="text-body text-ink">{value}</dd>
    </div>
  )
}
