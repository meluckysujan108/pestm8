import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Projected visits that came due and nobody actioned.
 *
 * A badge in the nav, because this is the one number that has to reach
 * somebody who is not looking for it. Showing an overdue visit on today's
 * schedule helps whoever opens the schedule; a business that has stopped
 * opening it is exactly the business quietly failing to treat a customer.
 *
 * Its own module, not AppShell's: the Job tab reads it too, and a route
 * importing the shell split the shell into a chunk of its own that every
 * page then waited on before it could hydrate.
 */
export function useOverdueRecurring(businessId: Id<'businesses'>): number {
  const { data } = useQuery(
    convexQuery(api.jobs.overdueRecurringCount, { businessId }),
  )
  return data ?? 0
}
