import { v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'

/**
 * One-off (30 Sept 2026): report emails need no owner's approval any more
 * (`convex/deliveries.ts`), so nothing may be left waiting for one — and
 * nothing that was waiting is sent now, days after it was asked for.
 *
 * Until this release a technician's email to an address that was not on the
 * client's record waited as `pendingApproval` for an owner, and no screen
 * could let it go. Each one still waiting is marked as not sent, with the
 * reason (`NOT_SENT`), so its report stops saying "Waiting for approval" and
 * says to send it again instead. Whoever asked can do that from the Send
 * sheet, which offers the addresses a report was already meant for. Sending
 * them from here would email a client about a visit from a week ago, with
 * nobody watching to see whether it went.
 *
 * It then clears `businesses.allowTechnicianRecipients`, the Settings switch
 * that let a business skip the approval. Nothing reads it now, and the
 * contract step can only drop it from the schema once no row holds it —
 * Convex refuses to deploy a schema an existing row fails.
 *
 * No audit rows are written: nobody in the business made these changes. The
 * preview lists them instead. Re-running is safe: the second time it finds
 * nothing.
 *
 * EVERY COMMAND NAMES ITS DEPLOYMENT (see jobStatusV1.ts). For production,
 * AFTER this release's backend is deployed there — so nothing new is held
 * while it runs — and once Vercel serves its frontend, so the old Settings
 * switch is off every screen:
 *
 *   0. SNAPSHOT: CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex export --path before-held-deliveries.zip
 *   1. PREVIEW:  CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/heldDeliveriesV1:preview
 *   2. RUN:      CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/heldDeliveriesV1:run '{"cursor":null}'
 *   3. VERIFY:   step 1 again lists nothing in either list.
 *
 * Each page schedules the next, deliveries first and then businesses, so a
 * run finishes on its own. On 29 Sept 2026 production held one send: the
 * demo business's seeded example. Run it on dev and e2e as well
 * (`CONVEX_DEPLOYMENT=dev:<name>`) before the contract step, since the e2e
 * suite used to hold sends on purpose.
 */

/** What a held send's history says once this has run. */
export const NOT_SENT =
  'Not sent: it was waiting for an owner’s approval, which isn’t needed any more. Send it again if it should still go.'

const PAGE = 200

/**
 * What `run` would change: every send still held, and every business that
 * still has the retired switch set. Reads both tables whole, which is fine
 * for a one-off on tables this size.
 */
export const preview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const held = []
    for await (const row of ctx.db.query('reportDeliveries')) {
      if (row.status !== 'pendingApproval') continue
      // No addresses: this is read in a terminal, and the ids say which.
      held.push({
        deliveryId: row._id,
        businessId: row.businessId,
        reportId: row.reportId,
        trigger: row.trigger,
        askedAt: new Date(row.createdAt).toISOString(),
        recipients: row.to.length,
      })
    }
    const switchSet = []
    for await (const business of ctx.db.query('businesses')) {
      if (business.allowTechnicianRecipients === undefined) continue
      switchSet.push({
        businessId: business._id,
        on: business.allowTechnicianRecipients,
      })
    }
    return { held, switchSet }
  },
})

export const run = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    /** Which pass: the held sends, then the switch. Starts with the sends. */
    table: v.optional(
      v.union(v.literal('reportDeliveries'), v.literal('businesses')),
    ),
  },
  handler: async (ctx, { cursor, table = 'reportDeliveries' }) => {
    if (table === 'reportDeliveries') {
      const page = await ctx.db
        .query('reportDeliveries')
        .paginate({ numItems: PAGE, cursor })
      let released = 0
      for (const row of page.page) {
        if (row.status !== 'pendingApproval') continue
        // Who asked, and who approved or refused anything before, stay as
        // they were: the row is the record of what happened to it.
        await ctx.db.patch(row._id, { status: 'failed', error: NOT_SENT })
        released++
      }
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.heldDeliveriesV1.run,
        page.isDone
          ? { cursor: null, table: 'businesses' as const }
          : { cursor: page.continueCursor, table },
      )
      return { table, changed: released, done: false }
    }

    const page = await ctx.db
      .query('businesses')
      .paginate({ numItems: PAGE, cursor })
    let cleared = 0
    for (const business of page.page) {
      if (business.allowTechnicianRecipients === undefined) continue
      await ctx.db.patch(business._id, { allowTechnicianRecipients: undefined })
      cleared++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.heldDeliveriesV1.run,
        { cursor: page.continueCursor, table },
      )
    }
    return { table, changed: cleared, done: page.isDone }
  },
})
