import { clientScope } from './capabilities'
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
