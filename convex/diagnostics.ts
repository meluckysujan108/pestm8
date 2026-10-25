import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, mutation } from './_generated/server'
import { components, internal } from './_generated/api'
import { requireAuthUser } from './lib/access'
import { connectionEntry, isTime, trimEntries } from './lib/diagnostics'

/**
 * A phone's notes about its connection to PestM8, sent in by the phone
 * (components/shell/ConnectionDiagnostics.tsx) and read by whoever is
 * looking into "it just hangs" — with `npx convex run diagnostics:recent`,
 * since there is no screen for them.
 *
 * Sent over HTTP rather than the socket, so they arrive while the socket is
 * the thing that is stuck, and so an upload never counts as a change waiting
 * to save in the "Could not reach PestM8" notice.
 */

/** How long reports are kept. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000
/** The least time between one person's reports, so a page in a loop cannot
 * fill the table: the app sends every two minutes at most, and a little
 * sooner just after the "Could not reach PestM8" notice goes. */
const MIN_GAP_MS = 30_000

export const report = mutation({
  args: {
    device: v.string(),
    app: v.string(),
    standalone: v.boolean(),
    agent: v.string(),
    entries: v.array(connectionEntry),
  },
  returns: v.null(),
  handler: async (ctx, { device, app, standalone, agent, entries }) => {
    const user = await requireAuthUser(ctx)
    const last = await ctx.db
      .query('clientDiagnostics')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .order('desc')
      .first()
    if (last && Date.now() - last._creationTime < MIN_GAP_MS) {
      // Refused rather than dropped: the phone keeps its notes and sends
      // them with its next report.
      throw new ConvexError('TOO_SOON')
    }
    if (entries.length === 0) return null
    await ctx.db.insert('clientDiagnostics', {
      userId: user._id,
      device: device.slice(0, 64),
      app: app.slice(0, 32),
      standalone,
      agent: agent.slice(0, 300),
      entries: trimEntries(entries),
    })
    return null
  },
})

/** Forgets reports older than thirty days, a batch at a time. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const batch = await ctx.db
      .query('clientDiagnostics')
      .withIndex('by_creation_time', (q) =>
        q.lt('_creationTime', Date.now() - KEPT_MS),
      )
      .take(200)
    for (const row of batch) await ctx.db.delete('clientDiagnostics', row._id)
    if (batch.length === 200) {
      await ctx.scheduler.runAfter(0, internal.diagnostics.prune, {})
    }
    return null
  },
})

/**
 * The newest reports, for reading from the command line:
 * `npx convex run diagnostics:recent '{"hours": 6}'`, adding
 * `"email": "…"` for one person's. Oldest note first within each report.
 */
export const recent = internalQuery({
  args: {
    hours: v.number(),
    email: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { hours, email, limit }) => {
    const since = Date.now() - hours * 60 * 60 * 1000
    const wanted = email
      ? ((
          (await ctx.runQuery(components.betterAuth.adapter.findOne, {
            model: 'user',
            where: [{ field: 'email', value: email.trim().toLowerCase() }],
          })) as { _id: string } | null
        )?._id ?? null)
      : null
    if (email && wanted === null) return []
    const rows = wanted
      ? await ctx.db
          .query('clientDiagnostics')
          .withIndex('by_userId', (q) =>
            q.eq('userId', wanted).gte('_creationTime', since),
          )
          .order('desc')
          .take(limit ?? 50)
      : await ctx.db
          .query('clientDiagnostics')
          .withIndex('by_creation_time', (q) => q.gte('_creationTime', since))
          .order('desc')
          .take(limit ?? 50)
    return rows.map((row) => ({
      at: new Date(row._creationTime).toISOString(),
      userId: row.userId,
      device: row.device,
      app: row.app,
      standalone: row.standalone,
      agent: row.agent,
      entries: row.entries.map((entry) => ({
        at: isTime(entry.t) ? new Date(entry.t).toISOString() : String(entry.t),
        e: entry.e,
        ...(entry.d ? { d: entry.d } : {}),
      })),
    }))
  },
})
