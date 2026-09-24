import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import { internalAction, internalQuery } from '../_generated/server'
import { hashInviteToken, newInviteToken } from '../lib/inviteTokens'
import { PHOTO_SPECS, logoPng, photoPng, signaturePng } from './images'
import { DEMO_BUSINESS_NAME, DEMO_PLAN } from './shared'
import { slugOfName } from './team'
import type { Id } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'

/**
 * A demo business full of sample data, for clicking through every screen and
 * finding the edge cases — without touching a real business's records.
 *
 * `run` makes a NEW business ("Demo – Swan River Pest Co (sample data)") and
 * gives the owner, contractor and subcontractor of `fromBusinessId` the same
 * roles in it. They reach it from the business switcher; nobody's landing page
 * changes. Everything in it is fictional (convex/demo/shared.ts), and two
 * placeholder people who cannot sign in fill out the roster.
 *
 * Every date is relative to the moment it runs: "today" in the data is the
 * day it was seeded. Re-seed (remove, then run) when a fresh one is wanted.
 *
 * For production (CLAUDE.md: every command names its deployment):
 *
 *   SEED:    CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run demo/seed:run '{"fromBusinessId":"<id>"}'
 *   FIND:    CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run demo/seed:list
 *   REMOVE:  CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run demo/cleanup:remove '{"businessId":"<id>","confirmSlug":"<slug>"}'
 *            (it works in batches and schedules itself until done)
 *   CHECK:   CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run demo/cleanup:status '{"businessId":"<id>"}'
 *
 * The steps run as separate transactions, in order. If one fails part-way,
 * what came before stays: remove the partial business and run again.
 *
 * While a demo exists, its three real people belong to it too. Removing one
 * of them from the source business (Settings → Team) then does not sign them
 * out, since they still have a business, and they land in the demo: remove
 * the demo — or their membership in it — before offboarding anyone.
 */
export const run = internalAction({
  args: {
    fromBusinessId: v.id('businesses'),
    /** A second demo alongside an existing one. Off by default, so running
     * the command twice does not quietly make two. */
    allowAnother: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { fromBusinessId, allowAnother },
  ): Promise<{
    businessId: Id<'businesses'>
    slug: string
    counts: Record<string, number>
  }> => {
    const existing = await ctx.runQuery(internal.demo.seed.list, {})
    if (existing.length > 0 && !allowAnother) {
      throw new ConvexError(
        `DEMO_EXISTS: ${existing.map((b) => b.slug).join(', ')} — remove it first, or pass allowAnother`,
      )
    }

    const images = await storeImages(ctx)
    const inviteTokenHashes = await Promise.all(
      Array.from({ length: 8 }, () => hashInviteToken(newInviteToken())),
    )

    // The images are stored before anything is checked (a mutation cannot
    // store files), and until the business exists nothing records them. So
    // if the first step refuses — the wrong source business, say — they are
    // deleted here, not left where no cleanup can find them.
    let base
    try {
      base = await ctx.runMutation(internal.demo.team.seed, {
        fromBusinessId,
        images,
        inviteTokenHashes,
      })
    } catch (error) {
      for (const id of [
        images.logo,
        ...Object.values(images.signatures),
        ...images.photos.map((p) => p.storageId),
      ]) {
        await ctx.storage.delete(id)
      }
      throw error
    }
    const { customTemplates } = await ctx.runMutation(
      internal.demo.templates.seed,
      { base },
    )
    const { properties, clients } = await ctx.runMutation(
      internal.demo.clients.seed,
      { base },
    )
    // Series first, then the one-offs, then the conversion of one of them:
    // the Job tab lists by creation, newest first, and a series' old visits
    // belong under the work booked since, not above it.
    const series = await ctx.runMutation(internal.demo.jobs.seedSeries, {
      base,
      properties,
    })
    const oneOff = await ctx.runMutation(internal.demo.jobs.seedOneOff, {
      base,
      properties,
    })
    const converted = await ctx.runMutation(internal.demo.jobs.convertOne, {
      base,
      oneOff,
    })
    const jobs = [...oneOff, ...series, ...converted]
    const { reports } = await ctx.runMutation(internal.demo.reports.seed, {
      base,
      properties,
      jobs,
      customTemplates,
    })
    const { notes } = await ctx.runMutation(internal.demo.notes.seed, {
      base,
      properties,
      clients,
      jobs,
    })

    const business = await ctx.runQuery(internal.demo.seed.slugOf, {
      businessId: base.businessId,
    })
    return {
      businessId: base.businessId,
      slug: business,
      counts: {
        clients: Object.keys(clients).length,
        properties: Object.keys(properties).length,
        jobs: jobs.length,
        customTemplates: Object.keys(customTemplates).length,
        reports: Object.keys(reports).length,
        notes,
      },
    }
  },
})

/** The logo, a signature per signer, and the site photos, stored once and
 * shared by everything the seed writes. */
async function storeImages(ctx: ActionCtx) {
  const store = (bytes: Uint8Array<ArrayBuffer>) =>
    ctx.storage.store(new Blob([bytes], { type: 'image/png' }))
  const photos = []
  for (const spec of PHOTO_SPECS) {
    photos.push({
      storageId: await store(photoPng(spec.seed, spec.width, spec.height)),
      width: spec.width,
      height: spec.height,
    })
  }
  return {
    logo: await store(logoPng()),
    signatures: {
      owner: await store(signaturePng(0)),
      contractor: await store(signaturePng(1)),
      sub: await store(signaturePng(2)),
      dana: await store(signaturePng(3)),
      client: await store(signaturePng(4)),
    },
    photos,
  }
}

/** Every demo business on the deployment. */
export const list = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      businessId: v.id('businesses'),
      name: v.string(),
      slug: v.string(),
      createdAt: v.number(),
    }),
  ),
  // Read by slug, not by scanning every business: every demo's slug is the
  // name's slug, or it with "-2", "-3"… on.
  handler: async (ctx) => {
    const base = slugOfName(DEMO_BUSINESS_NAME)
    return (
      await ctx.db
        .query('businesses')
        .withIndex('by_slug', (q) =>
          q.gte('slug', base).lt('slug', `${base}\uffff`),
        )
        .take(100)
    )
      .filter((b) => b.plan === DEMO_PLAN)
      .map((b) => ({
        businessId: b._id,
        name: b.name,
        slug: b.slug,
        createdAt: b.createdAt,
      }))
  },
})

export const slugOf = internalQuery({
  args: { businessId: v.id('businesses') },
  returns: v.string(),
  handler: async (ctx, { businessId }) =>
    (await ctx.db.get(businessId))?.slug ?? '',
})
