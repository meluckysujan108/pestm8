import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'

/**
 * `clients.directory` — every client and site in slim rows, each client's
 * email, and business clients' contact people — shaped for the screens that
 * used to read `properties.list` and `clients.list`.
 *
 * Type-only imports: the route loaders import routeQueries, which must stay
 * light, and these helpers ride along with the screens that use them.
 */
export type Directory = FunctionReturnType<typeof api.clients.directory>
export type DirectoryClient = Directory['clients'][number]
export type DirectorySite = Directory['sites'][number]
export type DirectoryContact = NonNullable<Directory['contacts']>[number]

/**
 * A directory answer as the screens read it (`normaliseDirectory`): the
 * contact people always a list, and whether the answer holds everything
 * matching reads.
 */
export type NormalisedDirectory = Omit<Directory, 'contacts'> & {
  contacts: ReadonlyArray<DirectoryContact>
  /**
   * Whether the answer carries emails and contact people at all. A copy
   * kept on the phone before they were sent (28 Oct 2026) has no
   * `contacts` key, nor does one for someone not given them
   * (`contactDetailsFor` in convex/clients.ts): then no email is evidence,
   * and nothing matched is more than Likely (lib/clientMatch.ts).
   */
  complete: boolean
}

const normalised = new WeakMap<object, NormalisedDirectory>()
const made = new WeakSet<object>()

/**
 * The directory answer as the screens read it, once per answer: the same
 * answer object gives back the same object, so a memo or a match index
 * keyed on it (`matchIndexFor`) holds across renders, and a push, a new
 * answer, makes a new one.
 *
 * A copy the phone kept before contact people were sent still serves
 * (KEPT_SHAPE was not bumped for them): it reads as having none, and as
 * incomplete. Already normalised, it is given back as it is.
 */
export function normaliseDirectory(
  answer: Directory | NormalisedDirectory,
): NormalisedDirectory {
  if (made.has(answer)) return answer as NormalisedDirectory
  const hit = normalised.get(answer)
  if (hit) return hit
  const raw = answer as Directory
  const next: NormalisedDirectory = {
    ...raw,
    contacts: raw.contacts ?? [],
    complete: raw.contacts !== undefined,
  }
  made.add(next)
  normalised.set(answer, next)
  return next
}

/** A site with its client beside it, as a `properties.list` row carried it,
 * and the client's contact people (a business client's). */
export type DirectorySiteWithClient = DirectorySite & {
  client: DirectoryClient
  contacts: ReadonlyArray<DirectoryContact>
}

const NO_CONTACTS: ReadonlyArray<DirectoryContact> = []

/** Each business client's contact people, by client. A person client's are
 * never sent, and left out here too should one arrive. */
function contactsByClient(
  directory: NormalisedDirectory,
): Map<string, Array<DirectoryContact>> {
  const business = new Set(
    directory.clients.filter((c) => c.kind === 'business').map((c) => c._id),
  )
  const byClient = new Map<string, Array<DirectoryContact>>()
  for (const contact of directory.contacts) {
    if (!business.has(contact.clientId)) continue
    const list = byClient.get(contact.clientId)
    if (list) list.push(contact)
    else byClient.set(contact.clientId, [contact])
  }
  return byClient
}

/**
 * Every site with its client, oldest first — what the booking pickers
 * (`propertyOptions`), New report and the client import read. Archived
 * clients' sites are kept (`client.archivedAt`): the pickers list them last,
 * labelled.
 */
export function sitesWithClients(
  answer: Directory | NormalisedDirectory,
): Array<DirectorySiteWithClient> {
  const directory = normaliseDirectory(answer)
  const clients = new Map(directory.clients.map((c) => [c._id, c]))
  const contacts = contactsByClient(directory)
  return directory.sites.flatMap((site) => {
    const client = clients.get(site.clientId)
    return client
      ? [{ ...site, client, contacts: contacts.get(client._id) ?? NO_CONTACTS }]
      : []
  })
}

/** A client with its sites and contact people, for the client picker. */
export type DirectoryClientWithSites = DirectoryClient & {
  sites: ReadonlyArray<DirectorySite>
  contacts: ReadonlyArray<DirectoryContact>
}

/**
 * Every client, each with its sites (oldest first) and contact people, for
 * "whose new site is this" (`clientOptions`): from the client list, not the
 * sites, so a client with no site yet is there to choose. Archived clients
 * are kept, as in the Property picker.
 */
export function clientsForPicker(
  answer: Directory | NormalisedDirectory,
): Array<DirectoryClientWithSites> {
  const directory = normaliseDirectory(answer)
  const sitesOf = sitesByClient(directory)
  const contacts = contactsByClient(directory)
  return directory.clients.map((client) => ({
    ...client,
    sites: sitesOf.get(client._id) ?? [],
    contacts: contacts.get(client._id) ?? NO_CONTACTS,
  }))
}

/**
 * The client `clientId` in the client list, or undefined: from the clients,
 * never through their sites, so a client with no site yet is found — chosen
 * in New site for, they stay chosen, and a business among them is asked for
 * its site contact.
 */
export function clientOf(
  answer: Directory | NormalisedDirectory,
  clientId: string,
): DirectoryClient | undefined {
  if (clientId === '') return undefined
  return normaliseDirectory(answer).clients.find((c) => c._id === clientId)
}

function sitesByClient(
  directory: NormalisedDirectory,
): Map<string, Array<DirectorySite>> {
  const sitesOf = new Map<string, Array<DirectorySite>>()
  for (const site of directory.sites) {
    const list = sitesOf.get(site.clientId)
    if (list) list.push(site)
    else sitesOf.set(site.clientId, [site])
  }
  return sitesOf
}

/**
 * The Clients page's rows for search, A–Z and the filters: each client the
 * page lists — not archived, as `clients.list` left them out — with its
 * sites, oldest first, as the page built them from the two whole lists, and
 * a business client's contact people, whom the search finds them by.
 */
export function clientRows(answer: Directory | NormalisedDirectory): Array<{
  client: DirectoryClient
  properties: Array<DirectorySite>
  contacts: ReadonlyArray<DirectoryContact>
}> {
  const directory = normaliseDirectory(answer)
  const sitesOf = sitesByClient(directory)
  const contacts = contactsByClient(directory)
  return directory.clients
    .filter((client) => client.archivedAt === undefined)
    .map((client) => ({
      client,
      properties: sitesOf.get(client._id) ?? [],
      contacts: contacts.get(client._id) ?? NO_CONTACTS,
    }))
}
