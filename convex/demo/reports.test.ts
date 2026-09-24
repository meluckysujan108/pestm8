/// <reference types="vite/client" />
import { ConvexError } from 'convex/values'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import { fieldsOf, sectionsOf } from '../../src/lib/reportTemplates'
import { resolveReportTemplate } from '../../src/lib/reportTemplates/resolve'
import {
  submittablePayload,
  validateReport,
} from '../../src/lib/reportTemplates/validate'
import { runDemoSteps } from '../../test/demoFixture'
import { at } from './shared'
import type { DemoRun } from '../../test/demoFixture'
import type { TestAs, TestApp } from '../../test/harness'
import type { ReportTemplate } from '../../src/lib/reportTemplates'
import type { Doc, Id } from '../_generated/dataModel'
import type { MemberKey } from './shared'

/**
 * The demo's reports step (convex/demo/reports.ts).
 *
 * Two kinds of check. The reports are the ones the brief asks for, in the
 * states it asks for (finalised with every section answered, stopped as
 * unsafe, held for approval and refused, corrected twice, stale, binned, a
 * suggestion left unconfirmed). And every one is a state the app could have
 * written: a finalised report passes the same validation finalise applies,
 * against the wording frozen for it; numbers go out in the order reports were
 * locked; the migrations' invariants hold; and the app's own queries and
 * mutations, asked as the owner and the subcontractor, answer as they should.
 *
 * Scheduled work (the PDF render finalise queues, the forecast a new draft
 * asks for) is held back with fake timers: it would call out to the network.
 */

const MINUTE = 60 * 1000

/** Every report the brief names, by the key the step returns it under. */
const NAMED = [
  'srLastVisit',
  'srUnsafe',
  'srSubAnts',
  'srSubRejected',
  'srPhotoJob',
  'srToday',
  'srStale',
  'srTrashed',
  'srCarryOver',
  'tpFlagged',
  'tpClean',
  'tpSubDraft',
  'tcOriginal',
  'tcAmendment',
  'tcAmendmentDraft',
  'baitFinal',
  'possumDraft',
  'cloneDraft',
] as const

const FINALISED = new Set<string>([
  'srLastVisit',
  'srUnsafe',
  'srSubAnts',
  'srSubRejected',
  'srPhotoJob',
  'tpFlagged',
  'tpClean',
  'tcOriginal',
  'tcAmendment',
  'baitFinal',
])

const RESERVED_EMAIL = /@([a-z0-9-]+\.)*example\.(com|net|org)$/

async function rowsOf(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => {
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    const photos: Array<Doc<'reportPhotos'>> = []
    const deliveries: Array<Doc<'reportDeliveries'>> = []
    const snapshots: Array<Doc<'reportTemplateSnapshots'>> = []
    for (const report of reports) {
      photos.push(
        ...(await ctx.db
          .query('reportPhotos')
          .withIndex('by_report_field', (q) => q.eq('reportId', report._id))
          .collect()),
      )
      deliveries.push(
        ...(await ctx.db
          .query('reportDeliveries')
          .withIndex('by_report', (q) => q.eq('reportId', report._id))
          .collect()),
      )
      const snapshot = report.templateSnapshotId
        ? await ctx.db.get(report.templateSnapshotId)
        : null
      if (snapshot) snapshots.push(snapshot)
    }
    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    return {
      business: await ctx.db.get(businessId),
      reports,
      photos,
      deliveries,
      snapshots,
      jobs,
      members: await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
      templates: await ctx.db
        .query('customReportTemplates')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .collect(),
      audit: (
        await ctx.db
          .query('auditLog')
          .withIndex('by_business', (q) => q.eq('businessId', businessId))
          .collect()
      ).filter((row) => row.entityType === 'reports'),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }
  })
}

type Rows = Awaited<ReturnType<typeof rowsOf>>

/** A ConvexError's payload, from a call that is expected to be refused. */
async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call
  } catch (error) {
    if (error instanceof ConvexError) return error.data
    throw error
  }
  throw new Error('expected the call to be refused')
}

describe('the demo reports', () => {
  let run: DemoRun
  let rows: Rows
  let seededBy: number

  beforeAll(async () => {
    // Held, not run: the PDF render and the forecast lookup would reach the
    // network. Only setTimeout is faked, so the clock still moves.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    run = await runDemoSteps('reports')
    seededBy = Date.now()
    rows = await rowsOf(run.t, run.base.businessId)
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  const when = (day: number, hh: number, mm = 0) => at(run.base, day, hh, mm)
  const member = (key: MemberKey) => run.base.members[key]
  const id = (key: string): Id<'reports'> => {
    const found = run.reports[key] as Id<'reports'> | undefined
    if (!found) throw new Error(`no report ${key}`)
    return found
  }
  const report = (key: string): Doc<'reports'> => {
    const found = rows.reports.find((r) => r._id === id(key))
    if (!found) throw new Error(`report ${key} is not in the business`)
    return found
  }
  const data = (r: Doc<'reports'>) => r.data as Record<string, unknown>
  const photosOf = (r: Doc<'reports'>, fieldKey?: string) =>
    rows.photos
      .filter(
        (p) =>
          p.reportId === r._id &&
          (fieldKey === undefined || p.fieldKey === fieldKey),
      )
      .sort((a, b) => a.order - b.order)
  const deliveriesOf = (r: Doc<'reports'>) =>
    rows.deliveries.filter((d) => d.reportId === r._id)
  const jobOf = (r: Doc<'reports'>) => rows.jobs.find((j) => j._id === r.jobId)
  const history = () =>
    Object.keys(run.reports)
      .filter((key) => key.startsWith('srHistory'))
      .map(report)
  const finalised = () => rows.reports.filter((r) => r.status === 'finalised')
  const signed = () => ({ businessId: run.base.businessId })

  /** The form a finalised report was signed against, from its snapshot. */
  const frozenForm = (r: Doc<'reports'>): ReportTemplate => {
    const snapshot = rows.snapshots.find((s) => s._id === r.templateSnapshotId)
    if (!snapshot) throw new Error(`no snapshot for ${r._id}`)
    return resolveReportTemplate({
      template: r.template,
      templateVersion: r.templateVersion,
      templateSnapshot: snapshot,
    })
  }
  const check = (r: Doc<'reports'>, form: ReportTemplate) => {
    const photoCounts: Record<string, number> = {}
    for (const photo of photosOf(r)) {
      photoCounts[photo.fieldKey] = (photoCounts[photo.fieldKey] ?? 0) + 1
    }
    for (const slot of Object.keys(r.photoSlots ?? {})) {
      photoCounts[slot] = (photoCounts[slot] ?? 0) + 1
    }
    return validateReport({
      template: form,
      data: data(r),
      signedSlots: Object.keys(r.signatureSlots ?? {}),
      photoCounts,
      prefill: r.prefill,
    })
  }

  // ─────────────────────────────────────────────────────────── the set

  test('every report the brief names is there, in the state it names', () => {
    for (const key of NAMED) {
      expect(report(key).status, key).toBe(
        FINALISED.has(key) ? 'finalised' : 'draft',
      )
    }
    const ids = Object.values(run.reports)
    expect(new Set(ids).size).toBe(ids.length)
    // Nothing else in the business: every row is one the step returned.
    expect(rows.reports.map((r) => r._id).sort()).toEqual([...ids].sort())
  })

  test('about eight more finalised service reports, by the owner, the contractor and Dana', () => {
    const more = history()
    expect(more.length).toBe(8)
    for (const r of more) {
      expect(r.template).toBe('serviceReport')
      expect(r.status).toBe('finalised')
    }
    const authors = new Set(
      more.map((r) =>
        (Object.keys(run.base.members) as Array<MemberKey>).find(
          (k) => member(k) === r.authorMembershipId,
        ),
      ),
    )
    expect([...authors].sort()).toEqual(['contractor', 'dana', 'owner'])
    // Some send a copy to the client, some have no one to send to.
    expect(more.some((r) => deliveriesOf(r).length > 0)).toBe(true)
    expect(more.some((r) => deliveriesOf(r).length === 0)).toBe(true)
  })

  test('nobody outside the team, and not the technician who left, wrote any of it', () => {
    const active = new Set(
      rows.members.filter((m) => m.status === 'active').map((m) => m._id),
    )
    for (const r of rows.reports) {
      expect(active.has(r.authorMembershipId)).toBe(true)
      expect(r.authorMembershipId).not.toBe(member('former'))
      if (r.finalisedByMembershipId) {
        expect(active.has(r.finalisedByMembershipId)).toBe(true)
      }
    }
  })

  // ────────────────────────────────────────────────── finalised reports

  test('every finalised report passes finalise’s own check, against the wording frozen for it', () => {
    expect(finalised().length).toBe(FINALISED.size + history().length)
    for (const r of finalised()) {
      const form = frozenForm(r)
      const result = check(r, form)
      expect(result.ok ? [] : result.issues, r._id).toEqual([])
      // Stored as submitted: nothing hidden, no blank row left behind.
      expect(submittablePayload(form, data(r))).toEqual(data(r))
    }
  })

  test('every finalised report carries its snapshot, context, number, version and pending PDF', () => {
    for (const r of finalised()) {
      expect(r.templateSnapshotId).toBeDefined()
      expect(r.contextSnapshot).toBeDefined()
      expect(r.contextSnapshot?.capturedAt).toBe(r.finalisedAt)
      expect(r.contextSnapshot?.author.membershipId).toBe(r.authorMembershipId)
      expect(r.reportNumber).toBeDefined()
      expect(r.version).toBeDefined()
      expect(r.pdfStatus).toBe('pending')
      expect(r.finalisedByMembershipId).toBeDefined()
      expect(r.searchText).toContain(`#${r.reportNumber}`)
      // Only the render writes these.
      expect(r.pdfStorageId).toBeUndefined()
      expect(r.pdfRenderVersion).toBeUndefined()
      expect(r.customTemplateSnapshot).toBeUndefined()
    }
  })

  test('numbers go out in the order reports were locked, and the next one is free', () => {
    const originals = finalised()
      .filter((r) => r.supersedesReportId === undefined)
      .sort((a, b) => (a.finalisedAt ?? 0) - (b.finalisedAt ?? 0))
    const numbers = originals.map((r) => r.reportNumber)
    expect(numbers).toEqual(originals.map((_, i) => i + 1))
    expect(rows.business?.nextReportNumber).toBe(originals.length + 1)
    // A correction reuses the number it corrects.
    for (const r of finalised().filter((x) => x.supersedesReportId)) {
      const original = rows.reports.find((x) => x._id === r.supersedesReportId)
      expect(r.reportNumber).toBe(original?.reportNumber)
    }
  })

  test('the migrations’ invariants hold', async () => {
    const snapshots = await run.t.query(
      internal.migrations.reportSnapshotsV1.invariant,
      {},
    )
    expect(snapshots.finalisedWithoutSnapshot).toBe(0)
    const contract = await run.t.query(
      internal.migrations.reportsContract.invariant,
      {},
    )
    expect(contract.finalisedCustomWithoutSnapshot).toBe(0)
    expect(contract.withCustomSnapshot).toBe(0)
    const library = await run.t.query(
      internal.migrations.reportsLibrary.invariant,
      {},
    )
    expect(library.withoutUpdatedAt).toBe(0)
    expect(library.withoutSearchText).toBe(0)
  })

  test('each finalise is audited and queued its PDF, as finalise does', () => {
    for (const r of finalised()) {
      const rowsFor = rows.audit.filter(
        (a) => a.entityId === r._id && a.action === 'report.finalise',
      )
      expect(rowsFor).toHaveLength(1)
      expect(rowsFor[0].at).toBe(r.finalisedAt)
      expect(rowsFor[0].actorMembershipId).toBe(r.finalisedByMembershipId)
      expect(rowsFor[0].onBehalfOfMembershipId).toBeUndefined()
    }
    const renders = rows.scheduled.filter((s) =>
      s.name.includes('afterFinalise'),
    )
    expect(renders).toHaveLength(finalised().length)
  })

  // ───────────────────────────────────────────────────── the service reports

  test('the last visit at Marcus’s answers every section, with photos and both signatures', () => {
    const r = report('srLastVisit')
    const answers = data(r)
    for (const key of [
      'serviceDate',
      'location',
      'startTime',
      'finishTime',
      'weather',
      'treatments',
      'risks',
      'riskActions',
      'additionalRiskAction',
      'housekeeping',
      'limitations',
      'comments',
      'nextVisit',
      'technician',
    ]) {
      expect(answers[key], key).toBeDefined()
    }
    expect(answers.safeToStart).toBe(true)
    expect(answers.sendCopy).toBe(true)
    expect(answers.technician).toBe(member('owner'))
    expect(r.jobId).toBe(run.jobs.find((j) => j.key === 'lastVisitPrev')?.id)

    expect(photosOf(r, 'coverPhoto')).toHaveLength(1)
    const gallery = photosOf(r, 'photos')
    expect(gallery.map((p) => p.order)).toEqual([0, 1, 2])
    expect(gallery.filter((p) => p.isCover)).toHaveLength(1)
    expect(gallery.some((p) => p.caption)).toBe(true)

    expect(r.signatureSlots?.client).toMatchObject({
      signedBy: 'Marcus Roberts',
    })
    const [delivery, ...more] = deliveriesOf(r)
    expect(more).toHaveLength(0)
    expect(delivery.status).toBe('queued')
    expect(delivery.to).toEqual(['marcus.roberts@example.com'])
    expect(delivery.cc).toEqual(['reports@example.com'])
    expect(delivery.trigger).toBe('finalise')
    expect(delivery.sentByMembershipId).toBe(member('owner'))
  })

  test('a job stopped as unsafe is recorded, with nothing applied and the reason', () => {
    const r = report('srUnsafe')
    expect(r.authorMembershipId).toBe(member('dana'))
    expect(data(r).safeToStart).toBe(false)
    expect(data(r).treatments ?? []).toEqual([])
    expect(String(data(r).comments)).toMatch(/Not safe to start/)
    // Dayo has no email: nothing to send.
    expect(deliveriesOf(r)).toHaveLength(0)
  })

  test('the subcontractor’s send to an address nobody has on file waits for the owner', async () => {
    const r = report('srSubAnts')
    expect(r.authorMembershipId).toBe(member('sub'))
    const [delivery] = deliveriesOf(r)
    expect(delivery.status).toBe('pendingApproval')
    expect(delivery.to).toContain('site.manager@example.net')
    expect(delivery.sentByMembershipId).toBe(member('sub'))

    const queue = await run.owner.as.query(
      api.deliveries.pendingApproval,
      signed(),
    )
    expect(queue.map((d) => d._id)).toEqual([delivery._id])
  })

  test('the second one the owner refused, as deliveries.reject leaves it', () => {
    const r = report('srSubRejected')
    expect(r.authorMembershipId).toBe(member('sub'))
    const [delivery] = deliveriesOf(r)
    expect(delivery.status).toBe('failed')
    expect(delivery.error).toBe('Not approved')
    expect(delivery.approvedByMembershipId).toBe(member('owner'))
    const refused = rows.audit.filter(
      (a) => a.entityId === r._id && a.action === 'report.email.rejected',
    )
    expect(refused).toHaveLength(1)
    expect(refused[0].actorMembershipId).toBe(member('owner'))
    expect(refused[0].meta).toEqual({ to: delivery.to })
    expect(refused[0].at).toBeGreaterThan(r.finalisedAt ?? Infinity)
  })

  test('the bird-proofing report is the contractor’s, on the job with photos', () => {
    const r = report('srPhotoJob')
    expect(r.authorMembershipId).toBe(member('contractor'))
    expect(r.jobId).toBe(run.jobs.find((j) => j.key === 'photoJob')?.id)
    expect(photosOf(r, 'photos').length).toBeGreaterThan(0)
    // The client's address is stored in mixed case; the send is not.
    expect(deliveriesOf(r)[0].to).toEqual(['accounts@ridgeline.example.com'])
  })

  test('one of the contractor’s was locked by the owner the next morning', () => {
    const r = history().find(
      (x) =>
        x.authorMembershipId === member('contractor') &&
        x.finalisedByMembershipId === member('owner'),
    )
    if (!r) throw new Error('no report locked by the owner')
    expect(r.contextSnapshot?.author.membershipId).toBe(member('contractor'))
    const opened = rows.audit.filter(
      (a) => a.entityId === r._id && a.action === 'report.edit.byOwner',
    )
    expect(opened).toHaveLength(1)
    expect(opened[0].actorMembershipId).toBe(member('owner'))
    expect(opened[0].at).toBeLessThan(r.finalisedAt ?? 0)
  })

  // ─────────────────────────────────────────────────────── the drafts

  test('today’s draft holds the app’s suggestions, unconfirmed, so it cannot be locked yet', async () => {
    const r = report('srToday')
    expect(r.prefill?.startTime).toEqual({ source: 'scheduled' })
    expect(data(r).startTime).toBe('17:30')

    const refused = (await refusal(
      run.owner.as.mutation(api.reports.finalise, {
        ...signed(),
        reportId: r._id,
        data: data(r),
        templateVersion: r.templateVersion,
      }),
    )) as { code: string; issues: Array<{ key: string; message: string }> }
    expect(refused.code).toBe('REPORT_INCOMPLETE')
    expect(refused.issues.map((i) => i.message)).toContain(
      'Check Start Time — the app suggested this answer',
    )
  })

  test('the subcontractor’s week-old draft is what the stale-drafts banner finds', async () => {
    const r = report('srStale')
    expect(r.updatedAt).toBeGreaterThanOrEqual(when(-6, 0))
    expect(r.updatedAt).toBeLessThan(when(-5, 0))
    const stale = await run.sub.as.query(api.reports.staleDrafts, signed())
    expect(stale).toEqual({ count: 1, oldest: r._id })
  })

  test('the binned draft went two days ago, restorable, and only in the bin', async () => {
    const r = report('srTrashed')
    expect(r.status).toBe('draft')
    expect(r.deletedAt).toBe(when(-2, 8, 15))
    expect(r.updatedAt).toBe(r.deletedAt)
    const bin = await run.owner.as.query(api.reports.list, {
      ...signed(),
      filter: 'trash',
      paginationOpts: { numItems: 50, cursor: null },
    })
    expect(bin.page.map((x) => x._id)).toEqual([r._id])
    expect(
      await run.owner.as.query(api.reports.get, {
        ...signed(),
        reportId: r._id,
      }),
    ).toBeNull()
  })

  test('the draft for Marcus’s next visit is offered the last one’s answers', async () => {
    const r = report('srCarryOver')
    expect(r.propertyId).toBe(report('srLastVisit').propertyId)
    const offer = await run.owner.as.query(api.reports.lastAtProperty, {
      ...signed(),
      reportId: r._id,
    })
    expect(offer?.reportId).toBe(id('srLastVisit'))
    expect(offer?.labels.length).toBeGreaterThan(0)
  })

  // ────────────────────────────────────────────────── timber inspections

  test('the flagged inspection flags every conducive condition, with live termites and photos', () => {
    const r = report('tpFlagged')
    const form = frozenForm(r)
    const conducive = sectionsOf(form).find(
      (s) => s.id === 'conduciveConditions',
    )
    if (!conducive) throw new Error('no §7')
    const answers = data(r)
    for (const field of conducive.fields) {
      if (field.kind === 'toggle' && field.flaggedValue !== undefined) {
        expect(answers[field.key], field.key).toBe(field.flaggedValue)
      }
      if (field.kind === 'radio' && field.flaggedValues) {
        expect(field.flaggedValues, field.key).toContain(answers[field.key])
      }
    }
    expect(answers.liveTermites).toBe(true)
    expect(answers.termiteWorkings).toBe(true)
    expect(photosOf(r, 'termiteWorkingsPhotos')).toHaveLength(2)
    expect(photosOf(r, 'propertyPhoto')).toHaveLength(1)
    expect(r.authorMembershipId).toBe(member('owner'))
  })

  test('the clean inspection flags nothing at all', () => {
    const r = report('tpClean')
    expect(r.authorMembershipId).toBe(member('contractor'))
    const answers = data(r)
    for (const field of fieldsOf(frozenForm(r))) {
      if (field.kind === 'toggle' && field.flaggedValue !== undefined) {
        expect(answers[field.key], field.key).not.toBe(field.flaggedValue)
      }
      if (field.kind === 'radio' && field.flaggedValues) {
        expect(field.flaggedValues, field.key).not.toContain(answers[field.key])
      }
    }
  })

  test('the subcontractor cannot lock a timber inspection: no licence on file', async () => {
    const r = report('tpSubDraft')
    expect(r.authorMembershipId).toBe(member('sub'))
    const refused = await refusal(
      run.sub.as.mutation(api.reports.finalise, {
        ...signed(),
        reportId: r._id,
        data: data(r),
        templateVersion: r.templateVersion,
      }),
    )
    expect(refused).toBe('HOLDER_LICENCE_MISSING')
  })

  // ─────────────────────────────────────────── the corrected certificate

  test('the certificate, its correction and the correction still open share one number', () => {
    const original = report('tcOriginal')
    const amendment = report('tcAmendment')
    const open = report('tcAmendmentDraft')

    expect([original.version, amendment.version, open.version]).toEqual([
      1, 2, 3,
    ])
    expect(
      new Set([original, amendment, open].map((r) => r.reportNumber)).size,
    ).toBe(1)
    expect(original.supersededByReportId).toBe(amendment._id)
    expect(amendment.supersedesReportId).toBe(original._id)
    expect(amendment.supersededByReportId).toBeUndefined()
    expect(open.supersedesReportId).toBe(amendment._id)
    expect(amendment.amendmentReason).toBe(
      'Wrong product concentration recorded',
    )
    expect(open.status).toBe('draft')

    // Corrected, re-signed after the original, and carrying the same photos.
    expect(data(original).concentration).not.toBe(data(amendment).concentration)
    const resigned = amendment.signatureSlots?.installer
    expect(resigned?.capturedByMembershipId).toBe(member('owner'))
    expect(resigned?.signedAt).toBeGreaterThan(original.finalisedAt ?? Infinity)
    const shots = (r: Doc<'reports'>) =>
      photosOf(r)
        .map((p) => `${p.fieldKey}:${p.order}:${p.storageId}`)
        .sort()
    expect(shots(amendment)).toEqual(shots(original))
    expect(shots(open)).toEqual(shots(original))

    // The limitation ticked early in the day went when the answer changed.
    expect(data(original).limitationsPresent).toBe(false)
    expect('limitationFactors' in data(original)).toBe(false)

    const amends = rows.audit.filter((a) => a.action === 'report.amend')
    expect(amends.map((a) => a.entityId).sort()).toEqual(
      [amendment._id, open._id].sort(),
    )
  })

  test('a second correction is refused while one is open, and the original is spent', async () => {
    expect(
      await refusal(
        run.owner.as.mutation(api.reports.amend, {
          ...signed(),
          reportId: id('tcAmendment'),
          reason: 'Another one',
        }),
      ),
    ).toBe('AMENDMENT_IN_PROGRESS')
    expect(
      await refusal(
        run.owner.as.mutation(api.reports.amend, {
          ...signed(),
          reportId: id('tcOriginal'),
          reason: 'Another one',
        }),
      ),
    ).toBe('ALREADY_SUPERSEDED')
    const shown = await run.owner.as.query(api.reports.get, {
      ...signed(),
      reportId: id('tcAmendment'),
    })
    expect(shown?.openAmendmentId).toBe(id('tcAmendmentDraft'))
  })

  // ─────────────────────────────────────────────────── the business's forms

  test('the bait station check is locked on the published form, not the owner’s unissued edit', () => {
    const r = report('baitFinal')
    expect(r.customTemplateId).toBe(run.customTemplates.baitStation)
    expect(r.templateVersion).toBe(1)
    expect(r.authorMembershipId).toBe(member('contractor'))
    const snapshot = rows.snapshots.find((s) => s._id === r.templateSnapshotId)
    expect(snapshot?.name).toBe('Rodent Bait Station Check')
    const log = data(r).stationsLog as Array<Record<string, unknown>>
    expect(log.length).toBeGreaterThan(0)
    for (const row of log) expect(typeof row._id).toBe('string')
    const gallery = photosOf(r, 'photos')
    expect(gallery.length).toBeGreaterThan(0)
    expect(gallery.filter((p) => p.isCover)).toHaveLength(1)
    expect(r.signatureSlots?.technician).toMatchObject({
      capturedByMembershipId: member('contractor'),
    })
  })

  test('the possum draft was started before its form was retired', () => {
    const r = report('possumDraft')
    const template = rows.templates.find((t) => t._id === r.customTemplateId)
    expect(r.customTemplateId).toBe(run.customTemplates.possumArchived)
    expect(template?.archivedAt).toBeDefined()
    expect(r.createdAt).toBeLessThan(template?.archivedAt ?? 0)
    expect(r.updatedAt).toBeLessThan(template?.archivedAt ?? 0)
    expect(r.templateVersion).toBe(1)
  })

  test('the owner’s draft on the cloned Service Report is for an upcoming job', () => {
    const r = report('cloneDraft')
    expect(r.customTemplateId).toBe(run.customTemplates.serviceClone)
    expect(r.authorMembershipId).toBe(member('owner'))
    expect(jobOf(r)?.scheduledAt).toBeGreaterThan(seededBy)
  })

  // ─────────────────────────────────────────────── as the app would have it

  test('every date is in the past, and in the order things happened', () => {
    for (const r of rows.reports) {
      expect(r.createdAt).toBeLessThanOrEqual(r.updatedAt ?? 0)
      expect(r.updatedAt ?? Infinity).toBeLessThanOrEqual(seededBy)
      for (const slot of Object.values(r.signatureSlots ?? {})) {
        expect(slot.signedAt).toBeGreaterThanOrEqual(r.createdAt)
        expect(slot.signedAt).toBeLessThanOrEqual(r.finalisedAt ?? seededBy)
      }
      for (const photo of photosOf(r)) {
        expect(photo.createdAt).toBeLessThanOrEqual(r.finalisedAt ?? seededBy)
      }
      if (r.status !== 'finalised') continue
      expect(r.finalisedAt).toBeGreaterThan(r.createdAt)
      const job = jobOf(r)
      if (job && r.supersedesReportId === undefined) {
        // Written up after the work, not before it.
        expect(r.finalisedAt ?? 0).toBeGreaterThan(
          job.scheduledAt + job.durationMinutes * MINUTE,
        )
      }
      for (const delivery of deliveriesOf(r)) {
        expect(delivery.createdAt).toBe(r.finalisedAt)
      }
    }
  })

  test('signatures are stored as attachSignature stores them', () => {
    const images = run.base.images.signatures
    const saved = new Map(
      rows.members.map((m) => [m._id, m.savedSignatureStorageId]),
    )
    for (const r of rows.reports) {
      const form =
        r.status === 'finalised'
          ? frozenForm(r)
          : resolveReportTemplate({
              template: r.template,
              templateVersion: r.templateVersion,
              customTemplate: rows.templates.find(
                (t) => t._id === r.customTemplateId,
              ),
            })
      for (const field of fieldsOf(form)) {
        if (field.kind !== 'signature') continue
        const slot = r.signatureSlots?.[field.slot]
        if (!slot) continue
        // The answer holds only the moment, and the same moment.
        expect(data(r)[field.key]).toEqual({ signedAt: slot.signedAt })
        expect(slot.templateVersion).toBe(r.templateVersion)
        expect(slot.statement).toBe(field.statement)
        if (field.role === 'technician') {
          expect(slot.capturedByMembershipId).toBe(r.authorMembershipId)
          expect(slot.signedBy).toBeUndefined()
          if (slot.method === 'saved') {
            expect(saved.get(r.authorMembershipId)).toBe(slot.storageId)
          }
          expect(Object.values(images)).toContain(slot.storageId)
          expect(slot.storageId).not.toBe(images.client)
        } else {
          expect(slot.storageId).toBe(images.client)
          expect(slot.method).toBe('drawn')
          expect(slot.signedBy?.trim()).toBeTruthy()
        }
      }
    }
  })

  test('photos are stored as the gallery stores them', () => {
    const groups = new Map<string, Array<Doc<'reportPhotos'>>>()
    for (const photo of rows.photos) {
      const key = `${photo.reportId}/${photo.fieldKey}`
      groups.set(key, [...(groups.get(key) ?? []), photo])
    }
    for (const [key, photos] of groups) {
      const orders = photos.map((p) => p.order).sort((a, b) => a - b)
      expect(orders, key).toEqual(photos.map((_, i) => i))
      expect(photos.filter((p) => p.isCover).length).toBeLessThanOrEqual(1)
      for (const photo of photos) {
        expect(photo.width === undefined).toBe(photo.height === undefined)
      }
    }
  })

  test('forms, revisions and legal bases are the ones the app stamps', () => {
    const versions: Record<string, number> = {
      serviceReport: 2,
      timberPestInspection: 2,
      termiteManagementCert: 2,
      custom: 1,
    }
    for (const r of rows.reports) {
      expect(r.templateVersion).toBe(versions[r.template])
      expect(r.photoIds).toEqual([])
      if (r.template === 'custom') {
        const template = rows.templates.find(
          (t) => t._id === r.customTemplateId,
        )
        expect(r.legalBasis).toBe(template?.legalBasis)
      }
    }
    expect(report('srLastVisit').legalBasis).toBe('APVMA · AEPMA')
    expect(report('tpFlagged').legalBasis).toBe('AS 4349.3-2010')
    expect(report('tcOriginal').legalBasis).toBe('AS 3660.2-2017')
  })

  test('only reserved addresses are ever sent to', () => {
    for (const delivery of rows.deliveries) {
      for (const address of [...delivery.to, ...delivery.cc]) {
        expect(address).toMatch(RESERVED_EMAIL)
      }
    }
  })

  // ────────────────────────────────────────────────────── who sees what

  test('the owner reads every report through the app’s own queries', async () => {
    const listed = await run.owner.as.query(api.reports.list, {
      ...signed(),
      filter: 'all',
      paginationOpts: { numItems: 200, cursor: null },
    })
    const live = rows.reports.filter((r) => r.deletedAt === undefined)
    expect(listed.page.map((r) => r._id).sort()).toEqual(
      live.map((r) => r._id).sort(),
    )
    for (const r of live) {
      const shown = await run.owner.as.query(api.reports.get, {
        ...signed(),
        reportId: r._id,
      })
      expect(shown?._id, r._id).toBe(r._id)
    }
  })

  test('the subcontractor sees their own and nothing else', async () => {
    const as = run.sub.as
    const listed = await as.query(api.reports.list, {
      ...signed(),
      filter: 'all',
      paginationOpts: { numItems: 200, cursor: null },
    })
    const theirs = rows.reports.filter(
      (r) =>
        r.authorMembershipId === member('sub') && r.deletedAt === undefined,
    )
    expect(listed.page.map((r) => r._id).sort()).toEqual(
      theirs.map((r) => r._id).sort(),
    )
    expect(theirs.map((r) => r._id).sort()).toEqual(
      ['srStale', 'srSubAnts', 'srSubRejected', 'tpSubDraft'].map(id).sort(),
    )
    expect(
      await as.query(api.reports.get, {
        ...signed(),
        reportId: id('srLastVisit'),
      }),
    ).toBeNull()
  })

  test('the contractor sees their own and their subcontractor’s', async () => {
    const as: TestAs = run.contractor.as
    const listed = await as.query(api.reports.list, {
      ...signed(),
      filter: 'all',
      paginationOpts: { numItems: 200, cursor: null },
    })
    const team = new Set([member('contractor'), member('sub')])
    const expected = rows.reports.filter(
      (r) => team.has(r.authorMembershipId) && r.deletedAt === undefined,
    )
    expect(listed.page.map((r) => r._id).sort()).toEqual(
      expected.map((r) => r._id).sort(),
    )
  })
})
