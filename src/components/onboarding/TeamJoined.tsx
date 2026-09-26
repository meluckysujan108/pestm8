import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { useCan } from '#/lib/access'
import { roleLabel } from '#/lib/assignees'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * "Kevin joined your team", on the owner's schedule — with the one thing to
 * do about it: give Kevin a job. Put away with ✕, on every device at once
 * (`teamJoins.dismiss`). Nothing for anyone but the owner.
 */
export function TeamJoinedNotices({
  businessId,
  onGiveJob,
}: {
  businessId: Id<'businesses'>
  /** New Job, starting out for this person. The notice goes once the job
   * is booked (`dismissJoined`), not when the sheet opens. */
  onGiveJob: (membershipId: Id<'memberships'>) => void
}) {
  const hydrated = useHydrated()
  const canManage = useCan('business.manage')
  // Warmed by the schedule's loader, so it is there with the day.
  // The window moves on at a UTC midnight — mid-morning in Australia — and
  // what was showing stays up while the new question is answered.
  const { data: joined } = useQuery({
    ...rq.teamJoins(businessId),
    enabled: canManage,
    placeholderData: keepPreviousData,
  })
  const dismiss = useConvexMutation(api.teamJoins.dismiss)
  const putAway = useMutation({
    mutationFn: (membershipId: Id<'memberships'>) =>
      dismiss({ businessId, membershipId }),
  })

  if (!joined || joined.length === 0) return null

  return (
    <div className="flex flex-col gap-2 px-4 pt-3 lg:pt-4">
      {joined.map((person) => (
        <div
          key={person.membershipId}
          className="rounded-2xl border border-hairline bg-surface p-3 shadow-elevation"
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full text-[16px] font-semibold text-white"
              style={{ backgroundColor: person.colour }}
            >
              {person.name.trim().charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] font-semibold text-ink">
                {person.name} joined the team
              </span>
              {/* Read against the clock, so the server's render and the
                  phone's can differ by a day around midnight. */}
              <span
                className="block truncate text-caption text-muted"
                suppressHydrationWarning
              >
                {roleLabel(person.role)} · {joinedWhen(person.joinedAt)}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Dismiss: ${person.name} joined`}
              onClick={() => putAway.mutate(person.membershipId)}
              disabled={!hydrated || putAway.isPending}
              className="-mr-1.5 -mt-1 flex size-11 shrink-0 items-center justify-center self-start rounded-full text-muted transition active:bg-surface-3 disabled:opacity-50"
            >
              <X size={17} strokeWidth={2.2} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => onGiveJob(person.membershipId)}
            disabled={!hydrated}
            aria-label={`Give ${person.name} a job`}
            className="ml-[52px] mt-2 min-h-10 rounded-xl bg-surface-2 px-3.5 text-[15px] font-semibold text-blue transition active:scale-[.98] disabled:opacity-50"
          >
            Give them a job
          </button>
        </div>
      ))}
    </div>
  )
}

/** "today", "yesterday", "3 days ago" — how news reads. */
function joinedWhen(at: number): string {
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
