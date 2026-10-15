import { convexQuery } from '@convex-dev/react-query'
import { getFunctionName } from 'convex/server'
import { api } from '../../../../convex/_generated/api'
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
 * The queries over a business's clients and sites that each batch of an
 * import re-runs: the whole lists (the directory, and the two older lists
 * until nothing reads them), the counts behind the Clients header and
 * filters, and the Clients page's first page. Matched by function rather
 * than by key, because the keys vary: the first page's carries its page
 * size, and a key added later would otherwise be missed here.
 */
const CLIENT_LISTS: ReadonlySet<string> = new Set([
  getFunctionName(api.clients.list),
  getFunctionName(api.properties.list),
  getFunctionName(api.clients.directory),
  getFunctionName(api.clients.page),
  getFunctionName(api.clients.overview),
])

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
  queryClient.removeQueries({
    predicate: (query) => {
      const [kind, name, args] = query.queryKey
      return (
        kind === 'convexQuery' &&
        typeof name === 'string' &&
        CLIENT_LISTS.has(name) &&
        typeof args === 'object' &&
        args !== null &&
        (args as { businessId?: unknown }).businessId === businessId &&
        // Not one a screen is showing: pulled from under it, it would only
        // be asked for again.
        query.getObserversCount() === 0
      )
    },
  })
}
