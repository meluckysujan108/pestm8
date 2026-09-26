import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
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
