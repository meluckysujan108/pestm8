import { v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { refreshSearchText } from '../reports'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * One-off (the owner's instruction of 2026-09-24): correct three production
 * property records the weather lookup could not place. Found while chasing
 * "No forecast" (see convex/weather.ts), and listed in PR #32.
 *
 *   - "Fannybay", saved as WA 0810, at 38 George Cre: Fannie Bay, NT 0820
 *     (George Crescent is in Fannie Bay).
 *   - "Darwin" NT 2209 (a Sydney postcode) at 6/79 progress drive: Nightcliff
 *     NT 0810. Progress Drive runs between Nightcliff and Coconut Grove, both
 *     0810; Darwin 0800 (the CBD, the first thought) has no Progress Drive,
 *     and a certificate would print an address that does not exist.
 *   - "Test", "Tedt test", a junk entry under the client Mahal Mart, whose
 *     real property (Kewdale) stays. Nothing refers to it — no job, series,
 *     report or note — so it is deleted. Properties have no archive; the
 *     client does, but archiving it would hide the real Kewdale one.
 *
 * GUARDS: each change applies only while the record still holds exactly the
 * values seen on 2026-09-24, so a record corrected by hand in the meantime is
 * left alone, and a second run changes nothing. The delete refuses if
 * anything has come to refer to the property. A dry run reports what it
 * would do without writing.
 *
 * For production (CLAUDE.md), every command names its deployment:
 *
 *   1. PREVIEW: CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/propertyFixesV1:run '{"dryRun":true}'
 *   2. RUN:     CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/propertyFixesV1:run '{}'
 *   3. VERIFY:  step 1 again reports every fix as "already done".
 */

type Fields = {
  suburb: string
  state: string
  postcode: string
  addressLine: string
}

export type Fix =
  | { kind: 'patch'; id: string; was: Fields; set: Partial<Fields> }
  | { kind: 'delete'; id: string; was: Fields }

export const FIXES: Array<Fix> = [
  {
    kind: 'patch',
    id: 'kd7a6t8614jtn91p1zygkhtn3x8eyf28',
    was: {
      suburb: 'Fannybay',
      state: 'WA',
      postcode: '0810',
      addressLine: '38 George Cre',
    },
    set: { suburb: 'Fannie Bay', state: 'NT', postcode: '0820' },
  },
  {
    kind: 'patch',
    id: 'kd72g8kfy8j5d1d872qd953b998ecx6r',
    was: {
      suburb: 'Darwin',
      state: 'NT',
      postcode: '2209',
      addressLine: '6/79 progress drive',
    },
    set: { suburb: 'Nightcliff', postcode: '0810' },
  },
  {
    kind: 'delete',
    id: 'kd73h25tp36rgtk13nm9mnwge98edrem',
    was: {
      suburb: 'Test',
      state: 'WA',
      postcode: '5485',
      addressLine: 'Tedt test',
    },
  },
]

type Outcome = { id: string; kind: Fix['kind']; result: string }

/** What still refers to a property; a delete must find nothing. */
async function referencesTo(
  ctx: MutationCtx,
  propertyId: Id<'properties'>,
  businessId: Id<'businesses'>,
) {
  const jobs = await ctx.db
    .query('jobs')
    .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
    .take(1)
  const reports = await ctx.db
    .query('reports')
    .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
    .take(1)
  const notes = await ctx.db
    .query('notes')
    .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
    .take(1)
  // No index by property: a business holds a handful of series.
  const series = (
    await ctx.db
      .query('recurrences')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
  ).filter((r) => r.propertyId === propertyId)
  return [
    ...jobs.map(() => 'a job'),
    ...reports.map(() => 'a report'),
    ...notes.map(() => 'a note'),
    ...series.map(() => 'a series'),
  ]
}

/** The fixes applied to whatever rows `fixes` names; split out so a test can
 * hand it rows of its own. */
export async function applyPropertyFixes(
  ctx: MutationCtx,
  fixes: Array<Fix>,
  dryRun: boolean,
): Promise<Array<Outcome>> {
  const outcomes: Array<Outcome> = []
  for (const fix of fixes) {
    const id = ctx.db.normalizeId('properties', fix.id)
    const row = id ? await ctx.db.get(id) : null
    const say = (result: string) =>
      outcomes.push({ id: fix.id, kind: fix.kind, result })

    if (!id || !row) {
      say(
        fix.kind === 'delete'
          ? 'already done: no such property'
          : 'skipped: no such property',
      )
      continue
    }
    const current: Fields = {
      suburb: row.suburb,
      state: row.state,
      postcode: row.postcode,
      addressLine: row.addressLine,
    }

    if (fix.kind === 'patch') {
      const wanted = { ...current, ...fix.set }
      if (JSON.stringify(current) === JSON.stringify(wanted)) {
        say('already done')
        continue
      }
      if (JSON.stringify(current) !== JSON.stringify(fix.was)) {
        say(
          `skipped: changed since 2026-09-24 (now ${JSON.stringify(current)})`,
        )
        continue
      }
      if (!dryRun) {
        await ctx.db.patch(id, fix.set)
        // A draft's search text holds the address, so a search for the
        // corrected suburb would miss it until someone next saved it.
        // Finalised reports keep the address they were signed with.
        for (const report of await ctx.db
          .query('reports')
          .withIndex('by_property', (q) => q.eq('propertyId', id))
          .collect()) {
          if (report.status === 'draft')
            await refreshSearchText(ctx, report._id)
        }
      }
      say(`${dryRun ? 'would set' : 'set'} ${JSON.stringify(fix.set)}`)
      continue
    }

    if (JSON.stringify(current) !== JSON.stringify(fix.was)) {
      say(`skipped: changed since 2026-09-24 (now ${JSON.stringify(current)})`)
      continue
    }
    const refs = await referencesTo(ctx, id, row.businessId)
    if (refs.length > 0) {
      say(`skipped: still referred to by ${refs.join(', ')}`)
      continue
    }
    if (!dryRun) await ctx.db.delete(id)
    say(dryRun ? 'would delete' : 'deleted')
  }
  return outcomes
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }) => ({
    dryRun,
    outcomes: await applyPropertyFixes(ctx, FIXES, dryRun),
  }),
})
