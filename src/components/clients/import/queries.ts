import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { rq } from '#/lib/routeQueries'
import type { QueryClient } from '@tanstack/react-query'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * The business's recent imports, named once so the route's loader and the
 * page ask for exactly the same thing (see src/lib/routeQueries.ts). Kept
 * here, and light: the loader imports it, and loaders are not code split.
 */
export const recentImports = (businessId: Id<'businesses'>) =>
  convexQuery(api.clientImports.list, { businessId })

export type RecentImport = FunctionReturnType<
  typeof api.clientImports.list
>[number]

/**
 * Lets go of the whole client and site lists, when nothing on screen is
 * showing them, before each batch of an import (`sendJob`) and before an
 * undo writes to them. Each batch, not once: a link hovered or touched
 * mid-import — ‹ Clients, the sidebar, Schedule — preloads its page and
 * warms them again, unwatched.
 *
 * Each batch writes clients and sites, so each one re-runs every live copy
 * of those lists and sends it down whole — and the batch's own answer waits
 * for that to arrive. The Clients page leaves its copies live for a quarter
 * of an hour after it is left (react-query's gcTime; a Convex subscription
 * goes only when its entry does), so an import straight from there would
 * pull the whole directory down again for every batch: tens of megabytes
 * over a 2,000-row file. The Clients page's loader asks for them afresh on
 * the way back.
 */
export function dropIdleClientLists(
  queryClient: QueryClient,
  businessId: Id<'businesses'>,
): void {
  for (const { queryKey } of [
    rq.clients(businessId),
    rq.properties(businessId),
  ]) {
    const watched = queryClient
      .getQueryCache()
      .find({ queryKey, exact: true })
      ?.getObserversCount()
    if (watched === 0) queryClient.removeQueries({ queryKey, exact: true })
  }
}
