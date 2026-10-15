import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'

/**
 * `clients.directory` — every client and site in slim rows — shaped for the
 * screens that used to read `properties.list` and `clients.list`.
 *
 * Type-only imports: the route loaders import routeQueries, which must stay
 * light, and these helpers ride along with the screens that use them.
 */
export type Directory = FunctionReturnType<typeof api.clients.directory>
export type DirectoryClient = Directory['clients'][number]
export type DirectorySite = Directory['sites'][number]

/** A site with its client beside it, as a `properties.list` row carried it. */
export type DirectorySiteWithClient = DirectorySite & {
  client: DirectoryClient
}

/**
 * Every site with its client, oldest first — what the booking pickers
 * (`propertyOptions`, `clientOptions`), New report and the client import
 * read. Archived clients' sites are kept (`client.archivedAt`): the pickers
 * list them last, labelled.
 */
export function sitesWithClients(
  directory: Directory,
): Array<DirectorySiteWithClient> {
  const clients = new Map(directory.clients.map((c) => [c._id, c]))
  return directory.sites.flatMap((site) => {
    const client = clients.get(site.clientId)
    return client ? [{ ...site, client }] : []
  })
}

/**
 * The Clients page's rows for search, A–Z and the filters: each client the
 * page lists — not archived, as `clients.list` left them out — with its
 * sites, oldest first, as the page built them from the two whole lists.
 */
export function clientRows(directory: Directory): Array<{
  client: DirectoryClient
  properties: Array<DirectorySite>
}> {
  const sitesOf = new Map<string, Array<DirectorySite>>()
  for (const site of directory.sites) {
    const list = sitesOf.get(site.clientId)
    if (list) list.push(site)
    else sitesOf.set(site.clientId, [site])
  }
  return directory.clients
    .filter((client) => client.archivedAt === undefined)
    .map((client) => ({ client, properties: sitesOf.get(client._id) ?? [] }))
}
