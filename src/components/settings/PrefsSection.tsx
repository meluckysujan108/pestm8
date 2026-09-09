import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { AU_STATES, TIMEZONE_BY_STATE } from '#/lib/au'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'

export function PrefsSection({
  businessId,
  business,
  canEdit,
}: {
  businessId: Id<'businesses'>
  business: { name: string; state: string; timezone: string; abn?: string }
  /** Business identity is a policy-level change, like branding — owner only. */
  canEdit: boolean
}) {
  if (!canEdit) return <ReadOnlyBusiness business={business} />

  return <EditableBusiness businessId={businessId} business={business} />
}

function ReadOnlyBusiness({
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

      <p className="mt-2 text-caption text-muted">
        State determines your timezone and how licence fields are labelled.
        Ask a business owner to change these details.
      </p>
    </>
  )
}

function EditableBusiness({
  businessId,
  business,
}: {
  businessId: Id<'businesses'>
  business: { name: string; state: string; timezone: string; abn?: string }
}) {
  const hydrated = useHydrated()
  const [name, setName] = useState(business.name)
  const [state, setState] = useState(business.state)
  const [abn, setAbn] = useState(business.abn ?? '')

  const convexUpdate = useConvexMutation(api.businesses.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      name: string
      state: string
      timezone: string
      abn?: string
    }) => convexUpdate(args),
  })

  return (
    <>
      <h2 className="section-label mb-2">Business</h2>
      <form
        className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({
            businessId,
            name,
            state,
            timezone: TIMEZONE_BY_STATE[state],
            abn: abn.trim() || undefined,
          })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="section-label">State</span>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            {AU_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="section-label">ABN (optional)</span>
          <input
            value={abn}
            onChange={(e) => setAbn(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        <p className="text-caption text-muted">
          State determines your timezone ({TIMEZONE_BY_STATE[state]}) and how
          licence fields are labelled.
        </p>

        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save'}
        </button>
      </form>
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
