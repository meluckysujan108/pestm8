import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'

/**
 * No PNG fixture needed here, unlike `annotation.spec.ts` (the photo
 * markup tool) — a PDF-page stroke is a plain array of normalized points,
 * not an image.
 */
const STROKE = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.2 },
  { x: 0.3, y: 0.15 },
]

test('the report author and an owner viewing a sub-authored report can both add strokes', async () => {
  const s = await setupBusinessWithSub('annot-visible')

  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await finaliseReport(s.sub.client, s, reportId, 'serviceReport')

  await s.sub.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })
  await s.owner.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })

  const strokes = await s.owner.client.query(api.reportAnnotations.listAnnotations, {
    businessId: s.businessId,
    reportId,
    page: 1,
  })
  expect(strokes).toHaveLength(2)
})

test('annotations work on a draft report too — the guard is not hardcoded to finalised', async () => {
  const s = await setupBusinessWithSub('annot-draft')

  const reportId = await createReport(s.owner.client, s, 'serviceReport')

  await s.owner.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })

  const strokes = await s.owner.client.query(api.reportAnnotations.listAnnotations, {
    businessId: s.businessId,
    reportId,
    page: 1,
  })
  expect(strokes).toHaveLength(1)
})

test('a non-member cannot add or read annotations on someone else business report', async () => {
  const s = await setupBusinessWithSub('annot-lock')

  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await finaliseReport(s.owner.client, s, reportId, 'serviceReport')

  const outsider = await signUpActor(
    uniqueEmail('annot-outsider'),
    FIXTURE_PASSWORD,
    'Nadia',
  )

  await expectRejected(
    () =>
      outsider.client.mutation(api.reportAnnotations.addStroke, {
        businessId: s.businessId,
        reportId,
        page: 1,
        points: STROKE,
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      outsider.client.query(api.reportAnnotations.listAnnotations, {
        businessId: s.businessId,
        reportId,
        page: 1,
      }),
    'NO_ACCESS',
  )
})

test('undoLastStroke removes only the caller own most recent stroke', async () => {
  const s = await setupBusinessWithSub('annot-undo')

  // Authored by the sub — an owner can always see any report, but a sub
  // without `canViewAllJobs` can only see the ones they authored, per
  // `canSeeReport`'s existing visibility rule.
  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await finaliseReport(s.sub.client, s, reportId, 'serviceReport')

  // Owner draws first, then sub — so the "most recent" belongs to sub.
  await s.owner.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })
  await s.sub.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })

  // Owner undoes — should remove the owner's own stroke, not the sub's more
  // recent one, since undo is scoped per-author.
  await s.owner.client.mutation(api.reportAnnotations.undoLastStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
  })

  const remaining = await s.owner.client.query(api.reportAnnotations.listAnnotations, {
    businessId: s.businessId,
    reportId,
    page: 1,
  })
  expect(remaining).toHaveLength(1)
  expect(remaining[0].authorMembershipId).toBe(s.subMembershipId)
})

test('clearMyStrokes removes only the caller own rows, leaving the other author intact', async () => {
  const s = await setupBusinessWithSub('annot-clear')

  // Authored by the sub, same reasoning as the undo test above.
  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await finaliseReport(s.sub.client, s, reportId, 'serviceReport')

  await s.owner.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })
  await s.owner.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })
  await s.sub.client.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })

  await s.owner.client.mutation(api.reportAnnotations.clearMyStrokes, {
    businessId: s.businessId,
    reportId,
    page: 1,
  })

  const remaining = await s.owner.client.query(api.reportAnnotations.listAnnotations, {
    businessId: s.businessId,
    reportId,
    page: 1,
  })
  expect(remaining).toHaveLength(1)
  expect(remaining[0].authorMembershipId).toBe(s.subMembershipId)
})
