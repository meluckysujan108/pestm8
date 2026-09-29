import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import { putInBin } from '../bin'
import { isBinned } from '../lib/bin'

/**
 * One-off: every client archived with the old "Archive client" button, into
 * the Recycle bin (convex/bin.ts).
 *
 * The archive hid a client from the client list and gave no way back: its
 * dialog promised "you can unarchive them later", and no screen ever could.
 * The Recycle bin is that way back now. Moved there, each such client can be
 * restored by the owner (un-archived as it comes back) or deleted for good,
 * and is wiped 30 days after the move if nobody does either.
 *
 * Moving a client takes what belongs to it into the bin as a delete does:
 * its properties, their jobs and Recurring Jobs, and the notes and draft
 * reports about them — future visits included, which leave the schedule.
 * Finalised reports stay in Reports. So look before running:
 *
 *   npx convex run migrations/archivedClientsToBinV1:preview --prod
 *   npx convex export --prod --path before-archived-to-bin.zip
 *   npx convex run migrations/archivedClientsToBinV1:run '{"cursor":null}' --prod
 *
 * Nothing recorded who archived a client, so its bin entry names nobody and
 * shows when it was archived instead, and nothing is written to the activity
 * log. Each page schedules the next. Re-running is safe: a client already in
 * the bin is left alone.
 */

const PAGE = 200

/** What `run` would move, and what would leave the schedule with it. */
export const preview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const out = []
    for await (const client of ctx.db.query('clients')) {
      if (client.archivedAt === undefined || isBinned(client)) continue
      const properties = await ctx.db
        .query('properties')
        .withIndex('by_client', (q) => q.eq('clientId', client._id))
        .collect()
      let futureJobs = 0
      let activeSeries = 0
      for (const property of properties) {
        const jobs = await ctx.db
          .query('jobs')
          .withIndex('by_property', (q) => q.eq('propertyId', property._id))
          .collect()
        futureJobs += jobs.filter(
          (j) => j.scheduledAt > now && j.status !== 'cancelled',
        ).length
        const series = await ctx.db
          .query('recurrences')
          .withIndex('by_property', (q) => q.eq('propertyId', property._id))
          .collect()
        activeSeries += series.filter((r) => r.active).length
      }
      out.push({
        clientId: client._id,
        businessId: client.businessId,
        archivedAt: new Date(client.archivedAt).toISOString(),
        properties: properties.length,
        futureJobs,
        activeSeries,
      })
    }
    return out
  },
})

export const run = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('clients')
      .paginate({ numItems: PAGE, cursor })
    let moved = 0
    for (const client of page.page) {
      if (client.archivedAt === undefined || isBinned(client)) continue
      await putInBin(
        ctx,
        client.businessId,
        { kind: 'client', id: client._id },
        { archivedAt: client.archivedAt },
      )
      moved++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.archivedClientsToBinV1.run,
        { cursor: page.continueCursor },
      )
    }
    return { moved, done: page.isDone }
  },
})
