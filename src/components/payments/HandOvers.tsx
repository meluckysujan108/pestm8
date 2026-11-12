import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Check } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { useActing } from '#/lib/access'
import { formatMoney } from '#/lib/format'
import { handOverPair } from '#/lib/payments'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ErrorCopy } from '#/components/forms/describeError'

const TICK_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not change this: only the two people it’s between, or the business owner, can.',
  default: 'Could not change this. Check your signal and try again.',
}

type Pair = {
  from: Id<'memberships'>
  to: Id<'memberships'>
  fromName: string | null
  toName: string | null
  value: number
  paymentIds: Array<Id<'payments'>>
  canTick: boolean
}

/**
 * Money someone marked as another person's and not passed on yet, one row
 * for each two people it is between. A mark, never a rule: it keeps track of
 * what they agreed, and ticking it off moves no money. Above every tab, so
 * it is seen wherever the page opens; only there when there is any.
 */
export function HandOvers({
  businessId,
  pairs,
}: {
  businessId: Id<'businesses'>
  pairs: ReadonlyArray<Pair>
}) {
  const hydrated = useHydrated()
  const viewer = useActing().membershipId
  // The pair just ticked off, to take it back while it is still on screen.
  const [ticked, setTicked] = useState<{
    title: string
    paymentIds: Array<Id<'payments'>>
  } | null>(null)
  const convexTick = useConvexMutation(api.payments.setHandOverDone)
  const tick = useMutation({
    mutationFn: (args: { paymentIds: Array<Id<'payments'>>; done: boolean }) =>
      convexTick({ businessId, ...args }),
  })

  if (pairs.length === 0 && ticked === null) return null
  const busy = !hydrated || tick.isPending

  return (
    <div className="mb-6">
      <h2 className="section-label mb-2">To hand over</h2>
      <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {pairs.map((pair) => {
          const title = handOverPair(pair, viewer)
          const count = pair.paymentIds.length
          const sending =
            tick.isPending && tick.variables.paymentIds === pair.paymentIds
          return (
            <li key={`${pair.from}:${pair.to}`} className="px-3.5 py-3">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink">
                    {title}
                  </span>
                  <span className="block text-caption text-muted">
                    {count} {count === 1 ? 'payment' : 'payments'}
                  </span>
                </span>
                <span className="shrink-0 text-body font-semibold tabular-nums text-ink">
                  {formatMoney(pair.value)}
                </span>
              </div>
              {pair.canTick && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    tick.mutate(
                      { paymentIds: pair.paymentIds, done: true },
                      {
                        onSuccess: () =>
                          setTicked({ title, paymentIds: pair.paymentIds }),
                      },
                    )
                  }
                  className={`${SECONDARY_BUTTON_COMPACT} mt-2.5 w-full`}
                >
                  {sending ? 'Marking…' : 'Mark handed over'}
                </button>
              )}
            </li>
          )
        })}
        {ticked && (
          <li className="flex min-h-[52px] items-center gap-2.5 px-3.5 py-2.5">
            <Check
              size={17}
              strokeWidth={2.2}
              aria-hidden
              className="shrink-0 text-green-ink"
            />
            <span
              role="status"
              className="min-w-0 flex-1 text-caption text-ink-2"
            >
              Marked handed over: {ticked.title}.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                tick.mutate(
                  { paymentIds: ticked.paymentIds, done: false },
                  { onSuccess: () => setTicked(null) },
                )
              }
              className="relative tap-target shrink-0 text-body font-semibold text-blue disabled:opacity-50"
            >
              Undo
            </button>
          </li>
        )}
      </ul>
      <FormAlert
        className="mt-2"
        error={tick.isError ? tick.error : null}
        copy={TICK_COPY}
      />
    </div>
  )
}
