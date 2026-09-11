import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/** Persistent banner while the caller's own view is filtered through another
 * member's eyes — read-only, so there is nothing to warn about beyond "this
 * isn't your own view right now" and a way back. */
export function ViewingAsBanner({
  businessId,
}: {
  businessId: Id<'businesses'>
}) {
  const { data } = useQuery(
    convexQuery(api.viewAs.getViewScope, { businessId }),
  )

  const convexSetViewingAs = useConvexMutation(api.memberships.setViewingAs)
  const exit = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> }) =>
      convexSetViewingAs(args),
  })

  if (!data?.viewingAs) return null

  return (
    <div className="flex items-center justify-between gap-2 bg-blue px-4 py-2 text-white">
      <p className="text-caption font-semibold">
        Viewing as {data.viewingAs.name}
      </p>
      <button
        type="button"
        disabled={exit.isPending}
        onClick={() => exit.mutate({ businessId })}
        className="shrink-0 rounded-full bg-white/20 px-3 py-1 text-caption font-semibold transition active:scale-[.95] disabled:opacity-50"
      >
        Exit
      </button>
    </div>
  )
}
