import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { dayKeyOf } from '../../../convex/lib/dates'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { formatMoney, todayKey } from '#/lib/format'
import { outstandingCaption, owingCaption, toBillCaption } from '#/lib/payments'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'

export type ClientOwed = NonNullable<
  FunctionReturnType<typeof api.payments.forClient>
>

type OwedRow = Extract<ClientOwed, { pricesHidden: false }>['rows'][number]

/** The section's name: what an owner on the phone to them wants to know. */
export const CLIENT_OWING_LABEL = 'What they owe'

/**
 * When a client's Jobs tab draws, and whether what they owe is on it. The
 * tab waits for what they owe as well as their jobs (`jobsIn`): drawn
 * first, it would otherwise arrive after them and push them down under a
 * thumb. But not while the line is down with keeping on (`waitsOut`): what
 * they owe isn't kept on the phone, so it might not come until signal does,
 * and waiting would hide their jobs and the bookings on this phone with
 * them. Which it was is decided as the tab first draws, and kept: drawn
 * without what they owe, the tab stays drawn when the line comes back
 * before the answer does, and what they owe stays off until the tab is
 * next opened, however soon it comes. Drawn with it, the tab waits as it
 * always has, keeping off (where `waitsOut` is never true) as on `main`.
 */
export function useOwedGate({
  jobsIn,
  owedIn,
  waitsOut,
}: {
  /** Their jobs, and the bookings on this phone, are in. */
  jobsIn: boolean
  /** What they owe is in: answered, or failed. */
  owedIn: boolean
  /** Keeping is on and the line is down (`useLineDown`). */
  waitsOut: boolean
}): { draws: boolean; owedShown: boolean } {
  const [late, setLate] = useState<boolean | null>(null)
  const drawsNow = jobsIn && (owedIn || waitsOut)
  if (late === null && drawsNow) setLate(!owedIn)
  // As it will be decided, in the render that decides it.
  const decided = late ?? (drawsNow ? !owedIn : null)
  return {
    draws: jobsIn && (owedIn || waitsOut || decided === true),
    owedShown: decided === false,
  }
}

/**
 * What a client owes, first on their Jobs tab: Owing and To bill as the
 * Payments page counts them (§5 The Payments page), then the jobs behind
 * them, Owing first and each oldest first, opening on the Schedule as their
 * visits do. Drawn only when something is owed, and never where prices are
 * hidden: the server says nothing then (`payments.forClient`).
 */
export function ClientOwing({
  owed,
  businessSlug,
  timezone,
}: {
  owed: ClientOwed
  businessSlug: string
  timezone: string
}) {
  if (owed.pricesHidden) return null
  const { owing, toBill, rows } = owed
  if (owing.count === 0 && toBill.count === 0) return null
  const today = todayKey(timezone)
  const cells = [
    {
      label: 'Owing',
      value: owing.value,
      sub: owingCaption(owing.count, owing.since, { timezone, today }),
    },
    { label: 'To bill', value: toBill.value, sub: toBillCaption(toBill.count) },
  ]

  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{CLIENT_OWING_LABEL}</h3>
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        <dl className="grid grid-cols-2 divide-x divide-hairline">
          {cells.map((cell) => (
            <div key={cell.label} className="min-w-0 px-3.5 py-2.5">
              <dt className="section-label">{cell.label}</dt>
              <dd className="mt-0.5">
                <span className="block text-metric-sm tabular-nums text-ink">
                  {formatMoney(cell.value)}
                </span>
                {cell.sub && (
                  <span className="block text-caption text-muted">
                    {cell.sub}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <ul className="divide-y divide-hairline-2 border-t border-hairline">
          {rows.map((row) => (
            <OwedJob
              key={row._id}
              row={row}
              businessSlug={businessSlug}
              timezone={timezone}
              today={today}
            />
          ))}
        </ul>
        {owed.more && (
          <p className="border-t border-hairline px-3.5 py-2.5 text-caption text-muted">
            Only the oldest are listed. Payments has every one.
          </p>
        )}
      </div>
    </section>
  )
}

/** The section where what they owe could not be read, with Try again. */
export function ClientOwingFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{CLIENT_OWING_LABEL}</h3>
      <LoadFailed what="what they owe" onRetry={onRetry} />
    </section>
  )
}

/** One job waiting on money, as its row on the Payments page has it, opening
 * on the Schedule as the client's visits do. */
function OwedJob({
  row,
  businessSlug,
  timezone,
  today,
}: {
  row: OwedRow
  businessSlug: string
  timezone: string
  today: string
}) {
  const caption = outstandingCaption({ ...row, leadName: null }, row.list, {
    timezone,
    today,
    showLead: false,
    pricesHidden: false,
  })
  return (
    <li>
      <Link
        to="/$businessSlug/schedule"
        params={{ businessSlug }}
        search={{ date: dayKeyOf(row.scheduledAt, timezone), jobId: row._id }}
        className="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none transition focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue active:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-ink">
            {row.jobType}
          </span>
          <span className="block text-caption text-muted">{caption}</span>
        </span>
        <span className="shrink-0 text-body font-semibold tabular-nums text-ink">
          {formatMoney(row.owed)}
        </span>
        <ChevronRight
          aria-hidden
          size={17}
          strokeWidth={2.2}
          className="-mr-1 shrink-0 text-muted-2"
        />
      </Link>
    </li>
  )
}
