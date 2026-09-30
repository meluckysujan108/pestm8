import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, mutation, query } from './_generated/server'
import { requireActor, requireCapability, requireWriteActor } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import { entriesOf, jobTypeRows } from './lib/jobTypeList'
import {
  DEFAULT_JOB_TYPES,
  MAX_FORMER_NAMES,
  MAX_JOBS_COUNTED,
  MAX_JOB_TYPE_ROWS,
  MAX_OFFERED_JOB_TYPES,
  canonicalJobTypeLabel,
  findJobType,
  jobTypeKey,
  jobTypeNameProblem,
  splitJobTypes,
  tidyJobTypeName,
} from './lib/jobTypes'
import { settableJobStatus } from './schema'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * Settings → Job types: the services New Job offers, as the business's own
 * list (lib/jobTypes.ts says how a label is read against it).
 *
 * Everyone who books work reads the list; only the owner changes it
 * (`business.manage`, as for Business details — and like every administration
 * capability it is off while the owner works inside someone else's account).
 *
 * Nothing a job already says is lost to a change here:
 * - deleting a service only stops New Job offering it — booked jobs keep it,
 *   and "Offer again" brings it back;
 * - a rename (or a merge, which is a rename onto a name the list already has)
 *   rewrites the label on every job and series that carries the service,
 *   finished ones included, so history, search and analytics agree. Finalised
 *   reports keep the words they were signed with: their data is their own.
 *   The old name is remembered on the service, so a label that still has it —
 *   a phone on last week's build, a job the rewrite has not reached yet — is
 *   read and saved as the new one.
 */

const reportArg = v.union(
  v.literal('serviceReport'),
  v.literal('timberPestInspection'),
  v.literal('termiteManagementCert'),
  v.literal('none'),
)

/** Most repeating services it reads. */
const MAX_SERIES_SCANNED = 500
/** Jobs (then series) a rewrite batch patches before handing on. */
const REWRITE_BATCH = 200
/** Most services a typed-in one can be swapped for. */
const MAX_SWAP_TARGETS = 10

/** The list, for New Job, the job sheet and the report suggestions. Any member. */
export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    await requireActor(ctx, businessId)
    return entriesOf(await jobTypeRows(ctx, businessId))
  },
})

/**
 * The list as the owner edits it: each service with how many jobs and running
 * series carry it, then the services typed into jobs that the list does not
 * have.
 *
 * Counts leave out projected visits — a series is counted once, as a series,
 * not once per visit the engine has guessed at — and anything in the Recycle
 * bin. Jobs are read by status so the projections are never read at all: at
 * the busiest client they are most of the rows. Past MAX_JOBS_COUNTED the read
 * stops and `complete` says the counts are a floor.
 */
export const manage = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    requireCapability(await requireActor(ctx, businessId), 'business.manage')
    const rows = await jobTypeRows(ctx, businessId)
    const entries = entriesOf(rows)

    type Count = { jobs: number; series: number }
    const used = new Map<string, Count>()
    const typedIn = new Map<string, Count & { name: string }>()
    const tally = (label: string, field: keyof Count) => {
      for (const service of splitJobTypes(label)) {
        const entry = findJobType(entries, service)
        if (entry) {
          const key = jobTypeKey(entry.name)
          const count = used.get(key) ?? { jobs: 0, series: 0 }
          count[field] += 1
          used.set(key, count)
        } else {
          const key = jobTypeKey(service)
          const count = typedIn.get(key) ?? {
            name: service,
            jobs: 0,
            series: 0,
          }
          count[field] += 1
          typedIn.set(key, count)
        }
      }
    }

    let scanned = 0
    let complete = true
    statuses: for (const { value: status } of settableJobStatus.members) {
      const jobs = ctx.db
        .query('jobs')
        .withIndex('by_business_status', (q) =>
          q.eq('businessId', businessId).eq('status', status),
        )
      for await (const job of jobs) {
        if (scanned >= MAX_JOBS_COUNTED) {
          complete = false
          break statuses
        }
        scanned += 1
        if (job.deletedAt === undefined) tally(job.jobType, 'jobs')
      }
    }

    const series = await ctx.db
      .query('recurrences')
      .withIndex('by_business_active', (q) =>
        q.eq('businessId', businessId).eq('active', true),
      )
      .take(MAX_SERIES_SCANNED)
    for (const row of series) {
      if (row.deletedAt === undefined) tally(row.jobType, 'series')
    }

    return {
      /** Never changed: the built-in nine, with no rows behind them yet. */
      isDefault: rows.length === 0,
      types: entries.map((entry) => ({
        ...entry,
        ...(used.get(jobTypeKey(entry.name)) ?? { jobs: 0, series: 0 }),
      })),
      typedIn: [...typedIn.values()].sort((a, b) =>
        jobTypeKey(a.name).localeCompare(jobTypeKey(b.name)),
      ),
      complete,
    }
  },
})

/** Add a service to the list — or adopt one typed into jobs (`from`). */
export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    name: v.string(),
    report: reportArg,
    /**
     * A service typed into jobs that this one takes the place of: every label
     * carrying it is rewritten to `name`, and it is remembered as a former
     * name, so a typo fixed on the way onto the list is fixed everywhere.
     */
    from: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, name: raw, report, from: rawFrom }) => {
    const owner = await requireOwner(ctx, businessId)
    const name = checkedName(raw)
    const key = jobTypeKey(name)
    const from = rawFrom === undefined ? undefined : checkedTypedIn(rawFrom)

    const rows = await ensureRows(ctx, businessId)
    // Only a service the list does not have can be adopted: taking one it has
    // would leave two services answering to the same old name.
    if (from !== undefined && findJobType(entriesOf(rows), from)) {
      throw new ConvexError('JOB_TYPE_ON_LIST')
    }
    const same = rows.find((row) => row.key === key)
    if (same && same.archivedAt === undefined) {
      throw new ConvexError('JOB_TYPE_EXISTS')
    }
    if (offered(rows).length >= MAX_OFFERED_JOB_TYPES) {
      throw new ConvexError('TOO_MANY_JOB_TYPES')
    }

    const adopted = from !== undefined && jobTypeKey(from) !== key ? [from] : []
    // The name is this service's now, whoever had it before a rename.
    await forgetFormerName(ctx, rows, key, same?._id)

    let id: Id<'jobTypes'>
    if (same) {
      // Back from the deleted list rather than a second row beside it.
      id = same._id
      await ctx.db.patch(id, {
        name,
        report,
        archivedAt: undefined,
        formerNames: keptFormerNames([...same.formerNames, ...adopted], key),
      })
    } else {
      if (rows.length >= MAX_JOB_TYPE_ROWS) {
        throw new ConvexError('TOO_MANY_JOB_TYPES')
      }
      id = await ctx.db.insert('jobTypes', {
        businessId,
        name,
        key,
        report,
        formerNames: keptFormerNames(adopted, key),
        createdAt: Date.now(),
      })
    }

    // Adopted, or back under new capitals ("WASPS"): the jobs follow.
    if (from !== undefined || (same && same.name !== name)) {
      await startRewrite(ctx, businessId)
    }
    await recordAudit(ctx, forSelf(owner), {
      businessId,
      action: 'jobType.create',
      entityType: 'jobTypes',
      entityId: id,
      meta: { name, report, ...(from !== undefined && { from }) },
    })
  },
})

/**
 * Rename a service, change its report, or both. Renaming onto a name another
 * service already has is a merge, and is refused unless `merge` says the owner
 * was asked: the other survives, this one's jobs become it, and this one leaves
 * the list.
 */
export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    /** Its name now. */
    name: v.string(),
    newName: v.optional(v.string()),
    report: v.optional(reportArg),
    merge: v.optional(v.boolean()),
  },
  handler: async (ctx, { businessId, name, newName, report, merge }) => {
    const owner = await requireOwner(ctx, businessId)
    const rows = await ensureRows(ctx, businessId)
    const row = findRow(rows, name)

    const next = newName === undefined ? row.name : checkedName(newName)
    const nextKey = jobTypeKey(next)
    const other = rows.find((r) => r._id !== row._id && r.key === nextKey)

    if (other) {
      if (merge !== true) throw new ConvexError('JOB_TYPE_EXISTS')
      const offeredAfter =
        offered(rows).length -
        (row.archivedAt === undefined ? 1 : 0) +
        (other.archivedAt === undefined ? 0 : 1)
      if (offeredAfter > MAX_OFFERED_JOB_TYPES) {
        throw new ConvexError('TOO_MANY_JOB_TYPES')
      }
      // The survivor keeps its own name and report: it is the service the
      // owner chose to keep ("ants" typed means Ants). Brought back if it had
      // been deleted — the owner has just picked it.
      await ctx.db.patch(other._id, {
        archivedAt: undefined,
        formerNames: keptFormerNames(
          [...other.formerNames, ...row.formerNames, row.name],
          nextKey,
        ),
      })
      await ctx.db.delete(row._id)
      await startRewrite(ctx, businessId)
      await recordAudit(ctx, forSelf(owner), {
        businessId,
        action: 'jobType.merge',
        entityType: 'jobTypes',
        entityId: other._id,
        meta: { from: row.name, into: other.name },
      })
      return { merged: true }
    }

    const renamed = next !== row.name
    if (!renamed && (report === undefined || report === row.report)) {
      return { merged: false }
    }
    if (renamed && nextKey !== row.key) {
      await forgetFormerName(ctx, rows, nextKey, row._id)
    }
    await ctx.db.patch(row._id, {
      ...(report !== undefined && { report }),
      ...(renamed && {
        name: next,
        key: nextKey,
        formerNames: keptFormerNames(
          nextKey === row.key
            ? row.formerNames
            : [...row.formerNames, row.name],
          nextKey,
        ),
      }),
    })
    if (renamed) await startRewrite(ctx, businessId)
    await recordAudit(ctx, forSelf(owner), {
      businessId,
      action: 'jobType.update',
      entityType: 'jobTypes',
      entityId: row._id,
      meta: {
        ...(renamed && { from: row.name, to: next }),
        ...(report !== undefined && { report }),
      },
    })
    return { merged: false }
  },
})

/**
 * Delete: New Job stops offering it. Every job and series keeps its label —
 * nothing is rewritten — and "Offer again" brings it back as it was.
 */
export const remove = mutation({
  args: { businessId: v.id('businesses'), name: v.string() },
  handler: async (ctx, { businessId, name }) => {
    const owner = await requireOwner(ctx, businessId)
    const rows = await ensureRows(ctx, businessId)
    const row = findRow(rows, name)
    if (row.archivedAt !== undefined) return
    // New Job with nothing to offer asks every booking to be typed out.
    if (offered(rows).length <= 1) throw new ConvexError('LAST_JOB_TYPE')
    await ctx.db.patch(row._id, { archivedAt: Date.now() })
    await recordAudit(ctx, forSelf(owner), {
      businessId,
      action: 'jobType.remove',
      entityType: 'jobTypes',
      entityId: row._id,
      meta: { name: row.name },
    })
  },
})

/** Offer again: a deleted service back on the list, as it was. */
export const restore = mutation({
  args: { businessId: v.id('businesses'), name: v.string() },
  handler: async (ctx, { businessId, name }) => {
    const owner = await requireOwner(ctx, businessId)
    const rows = await ensureRows(ctx, businessId)
    const row = findRow(rows, name)
    if (row.archivedAt === undefined) return
    if (offered(rows).length >= MAX_OFFERED_JOB_TYPES) {
      throw new ConvexError('TOO_MANY_JOB_TYPES')
    }
    await ctx.db.patch(row._id, { archivedAt: undefined })
    await recordAudit(ctx, forSelf(owner), {
      businessId,
      action: 'jobType.restore',
      entityType: 'jobTypes',
      entityId: row._id,
      meta: { name: row.name },
    })
  },
})

/**
 * Swap a service typed into jobs for ones on the list: "Gpc & Tpi" becomes
 * General Pest Control and Termite Inspection on every job and series that
 * says it. The list itself does not change.
 */
export const swap = mutation({
  args: {
    businessId: v.id('businesses'),
    from: v.string(),
    to: v.array(v.string()),
  },
  handler: async (ctx, { businessId, from: rawFrom, to }) => {
    const owner = await requireOwner(ctx, businessId)
    const from = checkedTypedIn(rawFrom)
    if (to.length === 0 || to.length > MAX_SWAP_TARGETS) {
      throw new ConvexError('JOB_TYPE_NOT_FOUND')
    }
    const entries = entriesOf(await jobTypeRows(ctx, businessId))
    // A service on the list is renamed or merged, not swapped: a swap would
    // rewrite its jobs and leave the service itself behind.
    if (findJobType(entries, from)) throw new ConvexError('JOB_TYPE_ON_LIST')
    // Only services the list offers, in the list's own spelling.
    const targets = to.map((name) => {
      const entry = entries.find((e) => jobTypeKey(e.name) === jobTypeKey(name))
      if (!entry || !entry.offered) throw new ConvexError('JOB_TYPE_NOT_FOUND')
      return entry.name
    })
    await startRewrite(ctx, businessId, { from, to: targets })
    await recordAudit(ctx, forSelf(owner), {
      businessId,
      action: 'jobType.swap',
      entityType: 'jobTypes',
      entityId: businessId,
      meta: { from, to: targets },
    })
  },
})

/**
 * One batch of a rewrite: every label on a page of the business's series
 * (then its jobs) read against the list as it is NOW (`canonicalJobTypeLabel`),
 * plus the swap, if there is one.
 *
 * Reading the live list rather than carrying a rename in the arguments is what
 * makes two quick renames safe: whichever batch reaches a job last writes the
 * newest name, because every older name is a former name of it. Binned jobs
 * are rewritten too, so one restored later comes back under today's name.
 */
export const rewriteLabels = internalMutation({
  args: {
    businessId: v.id('businesses'),
    /** The `jobTypeRewrites` row that says this rewrite is under way. */
    runId: v.id('jobTypeRewrites'),
    table: v.union(v.literal('jobs'), v.literal('recurrences')),
    swap: v.optional(v.object({ from: v.string(), to: v.array(v.string()) })),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const entries = entriesOf(await jobTypeRows(ctx, args.businessId))
    const page =
      args.table === 'jobs'
        ? await ctx.db
            .query('jobs')
            .withIndex('by_business', (q) =>
              q.eq('businessId', args.businessId),
            )
            .paginate({ numItems: REWRITE_BATCH, cursor: args.cursor })
        : await ctx.db
            .query('recurrences')
            .withIndex('by_business', (q) =>
              q.eq('businessId', args.businessId),
            )
            .paginate({ numItems: REWRITE_BATCH, cursor: args.cursor })

    for (const row of page.page) {
      const label = canonicalJobTypeLabel(row.jobType, entries, args.swap)
      if (label !== row.jobType) await ctx.db.patch(row._id, { jobType: label })
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.jobTypes.rewriteLabels, {
        ...args,
        cursor: page.continueCursor,
      })
    } else if (args.table === 'recurrences') {
      // The series first, then the visits: a visit the engine projects from
      // a series while the jobs are being read copies its already-rewritten
      // label, and lands after the cursor, where the jobs pass reaches it.
      await ctx.scheduler.runAfter(0, internal.jobTypes.rewriteLabels, {
        ...args,
        table: 'jobs',
        cursor: null,
      })
    } else if (await ctx.db.get(args.runId)) {
      await ctx.db.delete(args.runId)
    }
  },
})

// ——— Helpers ——————————————————————————————————————————————————————————

/** The owner, working as themselves. Refused to anyone else, and while switched. */
async function requireOwner(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Id<'memberships'>> {
  const env = await requireWriteActor(ctx, businessId)
  requireCapability(env, 'business.manage')
  return env.actor.real._id
}

function checkedName(raw: string): string {
  const problem = jobTypeNameProblem(raw)
  if (problem) throw new ConvexError(problem)
  return tidyJobTypeName(raw)
}

/**
 * A service as typed into jobs: any length (people typed whole sentences),
 * but one service — a label never holds a comma inside one.
 */
function checkedTypedIn(raw: string): string {
  const name = tidyJobTypeName(raw)
  if (name.length === 0) throw new ConvexError('JOB_TYPE_EMPTY')
  if (name.includes(',')) throw new ConvexError('JOB_TYPE_COMMA')
  return name
}

function offered(rows: ReadonlyArray<Doc<'jobTypes'>>) {
  return rows.filter((row) => row.archivedAt === undefined)
}

function findRow(
  rows: ReadonlyArray<Doc<'jobTypes'>>,
  name: string,
): Doc<'jobTypes'> {
  const key = jobTypeKey(name)
  const row = rows.find((r) => r.key === key)
  if (!row) throw new ConvexError('JOB_TYPE_NOT_FOUND')
  return row
}

/**
 * The business's rows, writing the built-in nine first if it has none — the
 * first change a business makes is to a list that is then wholly its own.
 */
async function ensureRows(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Array<Doc<'jobTypes'>>> {
  const rows = await jobTypeRows(ctx, businessId)
  if (rows.length > 0) return rows
  const createdAt = Date.now()
  for (const entry of DEFAULT_JOB_TYPES) {
    await ctx.db.insert('jobTypes', {
      businessId,
      name: entry.name,
      key: jobTypeKey(entry.name),
      report: entry.report,
      formerNames: [],
      createdAt,
    })
  }
  return jobTypeRows(ctx, businessId)
}

/**
 * Old names, each once and never the service's own, oldest first: the first
 * it ever had — a built-in one, usually, which the treatment table and older
 * phones know it by — and the newest after it, MAX_FORMER_NAMES in all.
 */
function keptFormerNames(
  names: ReadonlyArray<string>,
  ownKey: string,
): Array<string> {
  const kept: Array<string> = []
  const seen = new Set<string>([ownKey])
  for (const name of [...names].reverse()) {
    const key = jobTypeKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    kept.unshift(name)
  }
  if (kept.length <= MAX_FORMER_NAMES) return kept
  return [kept[0], ...kept.slice(-(MAX_FORMER_NAMES - 1))]
}

/**
 * A name that is now a service's own is no other service's old name.
 *
 * Refused while a rewrite is under way (JOB_TYPE_BUSY): the jobs it has not
 * reached yet still carry that old name, and would be read as the new
 * holder's. A moment later, it is fine.
 */
async function forgetFormerName(
  ctx: MutationCtx,
  rows: ReadonlyArray<Doc<'jobTypes'>>,
  key: string,
  except: Id<'jobTypes'> | undefined,
) {
  const holders = rows.filter(
    (row) =>
      row._id !== except &&
      row.formerNames.some((former) => jobTypeKey(former) === key),
  )
  if (holders.length === 0) return
  if (await rewriteUnderWay(ctx, holders[0].businessId)) {
    throw new ConvexError('JOB_TYPE_BUSY')
  }
  for (const row of holders) {
    await ctx.db.patch(row._id, {
      formerNames: row.formerNames.filter((f) => jobTypeKey(f) !== key),
    })
  }
}

/** How long a rewrite is taken to be running. Past it, one is stuck. */
const REWRITE_STALE_MS = 10 * 60 * 1000

async function rewriteUnderWay(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<boolean> {
  const runs = await ctx.db
    .query('jobTypeRewrites')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .take(50)
  const since = Date.now() - REWRITE_STALE_MS
  return runs.some((run) => run.startedAt > since)
}

async function startRewrite(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  replace?: { from: string; to: Array<string> },
) {
  const runId = await ctx.db.insert('jobTypeRewrites', {
    businessId,
    startedAt: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.jobTypes.rewriteLabels, {
    businessId,
    runId,
    table: 'recurrences',
    ...(replace && { swap: replace }),
    cursor: null,
  })
}
