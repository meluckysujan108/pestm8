import { clientScope } from './capabilities'
import type { Role } from './capabilities'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { ActorEnvelope } from './actor'

/**
 * Which clients someone may see when they cannot see all of them.
 *
 * Nobody takes the narrow branch today: the owner opened the client book to
 * everyone in the business, and the policy table grants `clients.directory`
 * to every role. It is kept, with its reasoning, as the tested path back if a
 * business ever wants the book restricted again — re-deriving it would mean
 * re-learning both points below the hard way.
 *
 * Turning it back on narrows more than lists: a phone matches callers
 * against its copy of `clients.directory` (lib/clientMatch.ts), and counts
 * who holds a number from it. A narrowed directory therefore goes without
 * contact people, which makes the phone read it as a copy that can't say
 * who else holds a number; anything that sends a narrowed copy of the book
 * for matching needs the same. The server's own check when a booking saves
 * (lib/findSame.ts) follows suit: it matches only against the clients in
 * the caller's book, judges nothing Same for them (`matchBookComplete`),
 * and checks a typed address for work only at those clients' sites, so it
 * never refuses what their phone couldn't have shown. The cost is that two
 * bookings at one address, one of them outside a narrowed member's book,
 * are not stopped for them; work at a site chosen by its id still is.
 *
 * "The clients whose properties you have jobs at" — the rule the toggle
 * promised. Two things about how it is computed matter more than the rule
 * itself.
 *
 * FIRST: it is derived from the person's OWN jobs, never from `env.scope`.
 * `env.scope` is widened by the "can see everyone's schedule" toggle, so
 * anyone holding that has `RowScope: business` — and "the clients behind every
 * job in the business" is the entire client book. Built that way, this would
 * compute, cost reads, and hide nothing from exactly the people it is aimed
 * at: the two toggles are meant to be independent, and someone can plausibly
 * be given sight of the roster's schedule without the client list.
 *
 * SECOND: it is bounded. There is no way to ask Convex for "the distinct
 * properties this person has ever been to" — it costs one document read per
 * JOB, and a technician doing eight a day accumulates two thousand a year.
 * Unbounded, this query walks their whole history to learn a set of maybe
 * thirty clients, and eventually trips the per-query document ceiling: the
 * Clients page would work for a year and then stop, for the busiest people
 * first.
 *
 * So it reads their most recent `JOB_WINDOW` jobs. The cost is that a client
 * they last visited a very long time ago drops off their list — which is a
 * defensible reading of a restriction whose point is "the people you are
 * working with", and a far better failure than a page that breaks under
 * exactly the people who use it most.
 */
const JOB_WINDOW = 1000

export async function visibleClientIds(
  ctx: QueryCtx,
  env: ActorEnvelope,
): Promise<Set<Id<'clients'>> | 'all'> {
  if (clientScope(env.caps) === 'directory') return 'all'

  const jobs = await ctx.db
    .query('jobs')
    .withIndex('by_assignee_date', (q) =>
      // Their own, deliberately — see the note above.
      q.eq('assignedMembershipId', env.actor.acting._id),
    )
    // A job in the Recycle bin makes nobody's client theirs (lib/bin.ts).
    .filter((q) => q.eq(q.field('deletedAt'), undefined))
    .order('desc')
    .take(JOB_WINDOW)

  const propertyIds = [...new Set(jobs.map((j) => j.propertyId))]
  const properties = await Promise.all(propertyIds.map((id) => ctx.db.get(id)))

  return new Set(
    properties
      .filter((p): p is Doc<'properties'> => p !== null)
      .filter((p) => p.businessId === env.readScope.businessId)
      .map((p) => p.clientId),
  )
}

export function inClientScope(
  visible: Set<Id<'clients'>> | 'all',
  clientId: Id<'clients'>,
): boolean {
  return visible === 'all' || visible.has(clientId)
}

/**
 * Who is sent clients' emails and business clients' contact people: every
 * role, subcontractors included (the owner's answer, 27 Oct 2026). Any
 * member may be the one a caller rings, and they already hold names, phones
 * and addresses. The account being read decides (`readScope`), so an owner
 * looking through a subcontractor's eyes sees what they would.
 *
 * Without them, a directory carries no `email` and no `contacts`, and the
 * phone's matcher reads the copy as incomplete (lib/clientMatch.ts).
 */
const CONTACT_DETAILS_ROLES: ReadonlySet<Role> = new Set([
  'owner',
  'contractor',
  'subcontractor',
])

export function contactDetailsFor(env: ActorEnvelope): boolean {
  return CONTACT_DETAILS_ROLES.has(env.readScope.role)
}

/**
 * Whether what someone may see of the book is everything matching reads:
 * emails and contact people, for their role, and every client. Only then
 * does `clients.directory` send contact people, so only then is their
 * phone's copy complete (lib/clientMatch.ts `complete`), and only then does
 * the server's own check judge a match as Same for them
 * (lib/findSame.ts). One test for both, so the server never refuses what
 * the phone, from the same book, could not have called Same.
 */
export function matchBookComplete(
  env: ActorEnvelope,
  visible: Set<Id<'clients'>> | 'all',
): boolean {
  return contactDetailsFor(env) && visible === 'all'
}
