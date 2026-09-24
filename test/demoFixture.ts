/// <reference types="vite/client" />
import prosemirrorSyncTest from '@convex-dev/prosemirror-sync/test'
import { internal } from '../convex/_generated/api'
import { MEMBER_COLOURS } from '../convex/lib/colours'
import { hashInviteToken, newInviteToken } from '../convex/lib/inviteTokens'
import {
  PHOTO_SPECS,
  logoPng,
  photoPng,
  signaturePng,
} from '../convex/demo/images'
import { createActor, createBusiness, testApp } from './harness'
import type { TestActor, TestApp } from './harness'
import type { Id } from '../convex/_generated/dataModel'
import type { DemoBase, ManifestJob } from '../convex/demo/shared'

/**
 * The demo seed (convex/demo), run for real inside convex-test, a step at a
 * time: each step's test runs the steps before it exactly as `seed:run` does
 * and then checks its own. Outside `convex/` for the reason harness.ts is.
 */

export type DemoSource = {
  t: TestApp
  fromBusinessId: Id<'businesses'>
  owner: TestActor
  contractor: TestActor
  sub: TestActor
}

/** A test app with both components, and a business with the three people
 * the demo copies: an owner, a contractor, and a subcontractor. */
export async function demoSource(): Promise<DemoSource> {
  const t = testApp()
  prosemirrorSyncTest.register(t)
  const owner = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const contractor = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const sub = await createActor(t, {
    email: 'priya@coastal.test',
    name: 'Priya',
  })
  const { businessId } = await createBusiness(t, owner)
  await t.run(async (ctx) => {
    const now = Date.now()
    const noGrants = {
      switchInto: null,
      clientDirectory: false,
      prices: false,
      otherSchedules: false,
    }
    await ctx.db.insert('memberships', {
      userId: contractor.userId,
      businessId,
      role: 'contractor',
      canViewAllJobs: false,
      grants: noGrants,
      colour: MEMBER_COLOURS[1],
      status: 'active',
      createdAt: now,
    })
    await ctx.db.insert('memberships', {
      userId: sub.userId,
      businessId,
      role: 'subcontractor',
      canViewAllJobs: false,
      grants: noGrants,
      colour: MEMBER_COLOURS[2],
      status: 'active',
      createdAt: now,
    })
  })
  return { t, fromBusinessId: businessId, owner, contractor, sub }
}

/** What `seed:run` stores before the first step, stored the same way. */
export async function demoImages(t: TestApp) {
  return t.run(async (ctx) => {
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
  })
}

export type DemoStep =
  'team' | 'templates' | 'clients' | 'jobs' | 'reports' | 'notes'

const ORDER: Array<DemoStep> = [
  'team',
  'templates',
  'clients',
  'jobs',
  'reports',
  'notes',
]

export type DemoRun = DemoSource & {
  base: DemoBase
  customTemplates: Record<string, Id<'customReportTemplates'>>
  properties: Record<string, Id<'properties'>>
  clients: Record<string, Id<'clients'>>
  oneOff: Array<ManifestJob>
  series: Array<ManifestJob>
  jobs: Array<ManifestJob>
  reports: Record<string, Id<'reports'>>
  notes: number
}

/**
 * Runs the seed's steps in `seed:run`'s order, through `upTo` inclusive, and
 * returns everything they handed each other. Steps not reached are empty.
 */
export async function runDemoSteps(upTo: DemoStep): Promise<DemoRun> {
  const source = await demoSource()
  const { t } = source
  const last = ORDER.indexOf(upTo)
  const reached = (step: DemoStep) => ORDER.indexOf(step) <= last

  const images = await demoImages(t)
  const inviteTokenHashes = await Promise.all(
    Array.from({ length: 8 }, () => hashInviteToken(newInviteToken())),
  )
  const base = await t.mutation(internal.demo.team.seed, {
    fromBusinessId: source.fromBusinessId,
    images,
    inviteTokenHashes,
  })
  const run: DemoRun = {
    ...source,
    base,
    customTemplates: {},
    properties: {},
    clients: {},
    oneOff: [],
    series: [],
    jobs: [],
    reports: {},
    notes: 0,
  }
  if (reached('templates')) {
    run.customTemplates = (
      await t.mutation(internal.demo.templates.seed, { base })
    ).customTemplates
  }
  if (reached('clients')) {
    const out = await t.mutation(internal.demo.clients.seed, { base })
    run.properties = out.properties
    run.clients = out.clients
  }
  if (reached('jobs')) {
    // seed:run's order: series, one-offs, then the conversion.
    const series = await t.mutation(internal.demo.jobs.seedSeries, {
      base,
      properties: run.properties,
    })
    run.oneOff = await t.mutation(internal.demo.jobs.seedOneOff, {
      base,
      properties: run.properties,
    })
    const converted = await t.mutation(internal.demo.jobs.convertOne, {
      base,
      oneOff: run.oneOff,
    })
    run.series = [...series, ...converted]
    run.jobs = [...run.oneOff, ...run.series]
  }
  if (reached('reports')) {
    run.reports = (
      await t.mutation(internal.demo.reports.seed, {
        base,
        properties: run.properties,
        jobs: run.jobs,
        customTemplates: run.customTemplates,
      })
    ).reports
  }
  if (reached('notes')) {
    run.notes = (
      await t.mutation(internal.demo.notes.seed, {
        base,
        properties: run.properties,
        clients: run.clients,
        jobs: run.jobs,
      })
    ).notes
  }
  return run
}
