/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { MEMBER_COLOURS } from './lib/colours'
import {
  MAX_COORDINATE,
  MAX_MARKUP_PAGE,
  MAX_POINTS_PER_AUTHOR,
  MAX_POINTS_PER_REPORT,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_AUTHOR,
  MAX_STROKES_PER_REPORT,
  MIN_COORDINATE,
} from './lib/reportMarkup'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * A report's markup, as the new in-app viewer reads it — every mark on every
 * page in one query — and takes one back (`removeStroke`, by the mark's id),
 * and the calls the old viewer makes, which the live site keeps making until
 * the new one ships (the backend goes first).
 *
 * The risks: a mark read by someone the pen was never offered to (the gate is
 * the REAL person's scope, narrower than the one that opens the report); a
 * teammate's mark reported as yours, so your undo is offered for it and then
 * does nothing; an Undo that removes a mark other than the one it named — a
 * newer one, a colleague's, one on another report; a page number shifted by
 * one between the 1-based rows and the 0-based viewer; a stroke nobody could
 * have drawn painted on every phone that opens the report; and a report with
 * more marks than its one query can read, which would hide all of them at
 * once.
 */

const STROKE = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.2 },
  { x: 0.3, y: 0.15 },
]

async function setup() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const priya = await createActor(t, { email: 'priya@coastal.test' })

  const now = Date.now()
  const ids = await t.run(async (ctx) => {
    const member = (userId: string, colour: string) =>
      ctx.db.insert('memberships', {
        userId,
        businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour,
        status: 'active',
        createdAt: now,
      })
    // Kevin's colour as a member from before Phase 4.2 might hold it: typed
    // in lower case. The viewer is handed one spelling of each colour.
    const kevinId = await member(kevin.userId, '#dc2626')
    const priyaId = await member(priya.userId, MEMBER_COLOURS[2])

    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    const report = (authorMembershipId: Id<'memberships'>) =>
      ctx.db.insert('reports', {
        businessId,
        propertyId,
        authorMembershipId,
        template: 'serviceReport',
        templateVersion: 1,
        legalBasis: 'APVMA · AEPMA',
        status: 'finalised',
        data: {},
        photoIds: [],
        finalisedAt: now,
        createdAt: now,
      })
    return {
      kevinId,
      priyaId,
      propertyId,
      kevinReport: await report(kevinId),
      priyaReport: await report(priyaId),
    }
  })

  return { t, terence, kevin, priya, businessId, ownerMembershipId, ...ids }
}

type Setup = Awaited<ReturnType<typeof setup>>

function draw(
  s: Setup,
  actor: TestActor,
  reportId: Id<'reports'>,
  page = 1,
  points = STROKE,
) {
  return actor.as.mutation(api.reportAnnotations.addStroke, {
    businessId: s.businessId,
    reportId,
    page,
    points,
  })
}

function marks(s: Setup, actor: TestActor, reportId: Id<'reports'>) {
  return actor.as.query(api.reportAnnotations.listForReport, {
    businessId: s.businessId,
    reportId,
  })
}

function pageMarks(
  s: Setup,
  actor: TestActor,
  reportId: Id<'reports'>,
  page = 1,
) {
  return actor.as.query(api.reportAnnotations.listAnnotations, {
    businessId: s.businessId,
    reportId,
    page,
  })
}

/** Every stroke row, to prove a refusal wrote nothing. */
function rows(s: Setup) {
  return s.t.run((ctx) => ctx.db.query('reportPdfAnnotations').collect())
}

/** Strokes written straight to the table, for the caps: thousands of them
 * through the mutation would test convex-test's patience, not the rule. All
 * stamped with one time, as a burst of marks in one millisecond would be. */
function seed(
  s: Setup,
  reportId: Id<'reports'>,
  authorMembershipId: Id<'memberships'>,
  strokes: Array<{ page: number; points: number }>,
) {
  const createdAt = Date.now()
  return s.t.run(async (ctx) => {
    for (const stroke of strokes) {
      await ctx.db.insert('reportPdfAnnotations', {
        reportId,
        page: stroke.page,
        authorMembershipId,
        points: Array.from({ length: stroke.points }, () => ({
          x: 0.5,
          y: 0.5,
        })),
        createdAt,
      })
    }
  })
}

describe('listForReport: who may read the marks', () => {
  test('the author, and the owner on a subcontractor’s report, read every mark', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 1)
    await draw(s, s.terence, s.kevinReport, 2)

    expect(await marks(s, s.kevin, s.kevinReport)).toHaveLength(2)
    expect(await marks(s, s.terence, s.kevinReport)).toHaveLength(2)
  })

  test('someone outside the business is refused, as the per-page read refuses them', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    const nadia = await createActor(s.t, { email: 'nadia@elsewhere.test' })

    await expect(marks(s, nadia, s.kevinReport)).rejects.toThrow('NO_ACCESS')
    await expect(pageMarks(s, nadia, s.kevinReport)).rejects.toThrow(
      'NO_ACCESS',
    )
  })

  test('another business’s owner is refused, whichever business he names', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const other = await createBusiness(s.t, rival, 'Other Pest')

    // His own business, our report: it is not in his business.
    await expect(
      rival.as.query(api.reportAnnotations.listForReport, {
        businessId: other.businessId,
        reportId: s.kevinReport,
      }),
    ).rejects.toThrow('NOT_FOUND')
    await expect(
      rival.as.query(api.reportAnnotations.listAnnotations, {
        businessId: other.businessId,
        reportId: s.kevinReport,
        page: 1,
      }),
    ).rejects.toThrow('NOT_FOUND')
    // Our business: he is not in it.
    await expect(marks(s, rival, s.kevinReport)).rejects.toThrow('NO_ACCESS')
  })

  test('someone removed from the team reads nothing more', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    await s.t.run((ctx) => ctx.db.patch(s.kevinId, { status: 'removed' }))

    await expect(marks(s, s.kevin, s.kevinReport)).rejects.toThrow('NO_ACCESS')
    await expect(pageMarks(s, s.kevin, s.kevinReport)).rejects.toThrow(
      'NO_ACCESS',
    )
  })

  test('a subcontractor who sees only his own work is refused a colleague’s report', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)

    await expect(marks(s, s.priya, s.kevinReport)).rejects.toThrow('NO_ACCESS')
    await expect(pageMarks(s, s.priya, s.kevinReport)).rejects.toThrow(
      'NO_ACCESS',
    )
  })

  test('a report in Recently Deleted has no marks to read', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevinReport, { deletedAt: Date.now() }),
    )

    await expect(marks(s, s.kevin, s.kevinReport)).rejects.toThrow('NOT_FOUND')
  })

  /**
   * The case the viewer has to survive. Looking through Priya's eyes, Kevin
   * can open her report, but the marks come with a pen and looking has never
   * granted authorship — so the markup read refuses him, exactly as the
   * per-page read always has, and the viewer shows the report without marks.
   */
  test('looking through a colleague’s account opens her report but not its marks', async () => {
    const s = await setup()
    await draw(s, s.priya, s.priyaReport)
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevinId, {
        canViewOtherAccounts: true,
        viewingAsMembershipId: s.priyaId,
      }),
    )

    const opened = await s.kevin.as.query(api.reports.get, {
      businessId: s.businessId,
      reportId: s.priyaReport,
    })
    expect(opened?._id).toBe(s.priyaReport)

    await expect(marks(s, s.kevin, s.priyaReport)).rejects.toThrow('NO_ACCESS')
    await expect(pageMarks(s, s.kevin, s.priyaReport)).rejects.toThrow(
      'NO_ACCESS',
    )
  })

  /**
   * Working in Kevin's account, Terence reads with his own (whole-business)
   * scope, and `mine` is still Terence: his undo must never be offered for a
   * mark Kevin drew, whose account he happens to be in.
   */
  test('working in someone else’s account, “mine” is still the person holding the phone', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })
    await draw(s, s.terence, s.kevinReport)

    const seen = await marks(s, s.terence, s.kevinReport)
    expect(seen.map((m) => m.mine)).toEqual([false, true])

    const stored = await rows(s)
    expect(stored.map((r) => r.authorMembershipId)).toEqual([
      s.kevinId,
      s.ownerMembershipId,
    ])
  })
})

describe('listForReport: what each mark says', () => {
  test('“mine” is true only for the caller’s own marks', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    await draw(s, s.terence, s.kevinReport)

    expect((await marks(s, s.kevin, s.kevinReport)).map((m) => m.mine)).toEqual(
      [true, false],
    )
    expect(
      (await marks(s, s.terence, s.kevinReport)).map((m) => m.mine),
    ).toEqual([false, true])
  })

  /** The viewer's slots count from 0; the rows never have. One conversion,
   * on the client — so the page comes back exactly as it was written. */
  test('the page comes back 1-based, as written', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 1)
    await draw(s, s.kevin, s.kevinReport, 3)

    expect((await marks(s, s.kevin, s.kevinReport)).map((m) => m.page)).toEqual(
      [1, 3],
    )
  })

  test('by page, then in the order they were drawn', async () => {
    const s = await setup()
    const a = await draw(s, s.kevin, s.kevinReport, 2)
    const b = await draw(s, s.terence, s.kevinReport, 1)
    const c = await draw(s, s.kevin, s.kevinReport, 2)
    const d = await draw(s, s.kevin, s.kevinReport, 1)

    expect((await marks(s, s.kevin, s.kevinReport)).map((m) => m.id)).toEqual([
      b,
      d,
      a,
      c,
    ])
  })

  test('each mark carries its points and the time it was drawn', async () => {
    const s = await setup()
    const id = await draw(s, s.kevin, s.kevinReport, 1)
    const row = await s.t.run((ctx) => ctx.db.get(id))

    expect(await marks(s, s.kevin, s.kevinReport)).toEqual([
      {
        id,
        page: 1,
        points: STROKE,
        createdAt: row!.createdAt,
        mine: true,
        authorColour: '#DC2626',
      },
    ])
  })

  test('a teammate’s colour is their member colour, in one spelling', async () => {
    const s = await setup()
    await draw(s, s.terence, s.kevinReport)
    await draw(s, s.kevin, s.kevinReport)

    expect(
      (await marks(s, s.terence, s.kevinReport)).map((m) => m.authorColour),
    ).toEqual([MEMBER_COLOURS[0], '#DC2626'])
  })

  /** Someone who leaves gives their colour back to be dealt again; their
   * marks must not be drawn in the name of whoever holds it now. */
  test('an author who has left, or whose colour is not one, has none', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport)
    await draw(s, s.terence, s.kevinReport)
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.kevinId, { status: 'removed' })
      await ctx.db.patch(s.ownerMembershipId, { colour: 'teal-ish' })
    })

    expect(
      (await marks(s, s.terence, s.kevinReport)).map((m) => m.authorColour),
    ).toEqual([null, null])
  })

  test('an empty report has no marks, not an error', async () => {
    const s = await setup()
    expect(await marks(s, s.kevin, s.kevinReport)).toEqual([])
  })
})

describe('addStroke refuses a stroke nobody could have drawn', () => {
  const point = { x: 0.5, y: 0.5 }
  const refused: Array<[string, number, Array<{ x: number; y: number }>]> = [
    ['a NaN coordinate', 1, [point, { x: Number.NaN, y: 0.5 }]],
    ['an infinite coordinate', 1, [point, { x: 0.5, y: Infinity }]],
    ['a negative infinite one', 1, [{ x: -Infinity, y: 0.5 }]],
    ['5,000 points', 1, Array.from({ length: 5000 }, () => point)],
    ['no points at all', 1, []],
    ['page 0', 0, [point]],
    ['page 1.5', 1.5, [point]],
    ['a negative page', -1, [point]],
    ['a page past the last', MAX_MARKUP_PAGE + 1, [point]],
    ['a NaN page', Number.NaN, [point]],
  ]

  test.each(refused)('%s', async (_, page, points) => {
    const s = await setup()
    await expect(draw(s, s.kevin, s.kevinReport, page, points)).rejects.toThrow(
      'INVALID_STROKE',
    )
    expect(await rows(s)).toEqual([])
  })

  test('but keeps everything at the edges: a dot, the last page, the longest stroke, a little off the page', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 1, [point])
    await draw(s, s.kevin, s.kevinReport, MAX_MARKUP_PAGE, [point])
    await draw(
      s,
      s.kevin,
      s.kevinReport,
      1,
      Array.from({ length: MAX_POINTS_PER_STROKE }, () => point),
    )
    await draw(s, s.kevin, s.kevinReport, 1, [
      { x: MIN_COORDINATE, y: MAX_COORDINATE },
      { x: MAX_COORDINATE, y: MIN_COORDINATE },
    ])
    expect(await rows(s)).toHaveLength(4)
  })

  /**
   * The old viewer, which the live site serves until the new one ships (and
   * an installed app for a while after), captures the pointer and sends where
   * the finger is, unclamped: a stroke run off the bottom of a page scrolled
   * up the screen arrives with y near 2. It shows the line as drawn and never
   * hears of a refusal, so refusing it would lose the mark without a word.
   * The part on the page is kept; the part off it is pulled in to the edge
   * band, still off the page and still undrawn.
   */
  test('a stroke run off the page is kept, pulled in to the band around it', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 2, [
      { x: 0.4, y: 0.8 },
      { x: 0.45, y: 1.2 },
      { x: 0.5, y: 2.03 },
      { x: -3, y: -0.9 },
    ])

    const [mark] = await marks(s, s.kevin, s.kevinReport)
    expect(mark.page).toBe(2)
    expect(mark.points).toEqual([
      { x: 0.4, y: 0.8 },
      { x: 0.45, y: 1.2 },
      { x: 0.5, y: MAX_COORDINATE },
      { x: MIN_COORDINATE, y: MIN_COORDINATE },
    ])
  })

  /** Who you are is asked first: a stranger learns nothing from a refusal. */
  test('a stranger is refused for who they are, not for what they sent', async () => {
    const s = await setup()
    const nadia = await createActor(s.t, { email: 'nadia@elsewhere.test' })
    await expect(
      draw(s, nadia, s.kevinReport, 0, [{ x: Number.NaN, y: 0 }]),
    ).rejects.toThrow('NO_ACCESS')
  })
})

describe('a report holds only as many marks as its one read can show', () => {
  test('the stroke past the last is refused, every stroke is listed, and undo makes room', async () => {
    const s = await setup()
    await seed(
      s,
      s.kevinReport,
      s.kevinId,
      Array.from({ length: MAX_STROKES_PER_REPORT }, (_, i) => ({
        page: 1 + (i % 3),
        points: 1,
      })),
    )

    await expect(draw(s, s.kevin, s.kevinReport)).rejects.toThrow(
      'TOO_MANY_STROKES',
    )
    // Refused for anyone, not just the person who filled it — in words of
    // its own for someone with no marks here to clear.
    await expect(draw(s, s.terence, s.kevinReport)).rejects.toThrow(
      'REPORT_FULL_OF_MARKS',
    )
    expect(await marks(s, s.terence, s.kevinReport)).toHaveLength(
      MAX_STROKES_PER_REPORT,
    )

    await s.kevin.as.mutation(api.reportAnnotations.undoLastStroke, {
      businessId: s.businessId,
      reportId: s.kevinReport,
      page: 2,
    })
    await draw(s, s.terence, s.kevinReport)
    expect(await marks(s, s.terence, s.kevinReport)).toHaveLength(
      MAX_STROKES_PER_REPORT,
    )
  })

  test('so is a stroke that would take the report past its points', async () => {
    const s = await setup()
    const perStroke = MAX_POINTS_PER_STROKE
    const full = Math.floor(MAX_POINTS_PER_REPORT / perStroke)
    const left = MAX_POINTS_PER_REPORT - full * perStroke
    // Room for one more stroke, but not a whole one, and not one point over.
    expect(left).toBeGreaterThan(1)
    await seed(
      s,
      s.kevinReport,
      s.kevinId,
      Array.from({ length: full }, () => ({ page: 1, points: perStroke })),
    )
    const points = (n: number) =>
      Array.from({ length: n }, () => ({ x: 0.5, y: 0.5 }))

    // Terence, well inside his own share, meets the report's.
    await expect(
      draw(s, s.terence, s.kevinReport, 1, points(left + 1)),
    ).rejects.toThrow('REPORT_FULL_OF_MARKS')
    await draw(s, s.terence, s.kevinReport, 1, points(left))
    await expect(
      draw(s, s.terence, s.kevinReport, 1, points(1)),
    ).rejects.toThrow('REPORT_FULL_OF_MARKS')
  })

  test('one person’s share: the stroke past it is refused, the rest of the team is not, and their own Undo makes room', async () => {
    const s = await setup()
    await seed(
      s,
      s.kevinReport,
      s.kevinId,
      Array.from({ length: MAX_STROKES_PER_AUTHOR }, () => ({
        page: 1,
        points: 1,
      })),
    )

    await expect(draw(s, s.kevin, s.kevinReport)).rejects.toThrow(
      'TOO_MANY_STROKES',
    )
    await draw(s, s.terence, s.kevinReport)

    const [first] = await rows(s)
    await remove(s, s.kevin, s.kevinReport, first._id)
    await draw(s, s.kevin, s.kevinReport)
  })

  test('and so are the points past it', async () => {
    const s = await setup()
    const full = Math.floor(MAX_POINTS_PER_AUTHOR / MAX_POINTS_PER_STROKE)
    const left = MAX_POINTS_PER_AUTHOR - full * MAX_POINTS_PER_STROKE
    expect(left).toBeGreaterThan(1)
    await seed(
      s,
      s.kevinReport,
      s.kevinId,
      Array.from({ length: full }, () => ({
        page: 1,
        points: MAX_POINTS_PER_STROKE,
      })),
    )
    const points = (n: number) =>
      Array.from({ length: n }, () => ({ x: 0.5, y: 0.5 }))

    await expect(
      draw(s, s.kevin, s.kevinReport, 1, points(left + 1)),
    ).rejects.toThrow('TOO_MANY_STROKES')
    await draw(s, s.kevin, s.kevinReport, 1, points(left))
    await expect(draw(s, s.kevin, s.kevinReport, 1, points(1))).rejects.toThrow(
      'TOO_MANY_STROKES',
    )
    await draw(s, s.terence, s.kevinReport, 1, points(MAX_POINTS_PER_STROKE))
  })

  test('one person drawing all they can leaves the rest of the team room to mark it', async () => {
    // Only the person who drew a mark can take it away, so a report one
    // person could fill would be closed to everyone else — for good, once
    // that person left the team. Kevin draws through the mutation alone:
    // the longest strokes he may until refused, then shorter and shorter
    // ones, until not one more point is taken.
    const s = await setup()
    const points = (n: number) =>
      Array.from({ length: n }, () => ({ x: 0.5, y: 0.5 }))
    for (
      let size = MAX_POINTS_PER_STROKE;
      size >= 1;
      size = Math.floor(size / 2)
    ) {
      for (;;) {
        const refusal = await draw(s, s.kevin, s.kevinReport, 1, points(size))
          .then(() => null)
          .catch((error: unknown) => String(error))
        if (refusal === null) continue
        expect(refusal).toMatch('TOO_MANY_STROKES')
        break
      }
    }
    await expect(draw(s, s.kevin, s.kevinReport)).rejects.toThrow(
      'TOO_MANY_STROKES',
    )

    // The owner can still mark the report Kevin filled his share of.
    await draw(s, s.terence, s.kevinReport)
    expect(
      (await marks(s, s.terence, s.kevinReport)).filter((m) => m.mine),
    ).toHaveLength(1)
  })

  /**
   * What it takes to fill a report now: four people at their share. Two of
   * them here have since left the team, so their marks are nobody's to
   * clear; the two still here can each make room, and the one person with
   * nothing on it is told it is full, not to clear marks he does not have.
   */
  test('four people at their share fill it: the fifth is told it is full, and either still here makes room', async () => {
    const s = await setup()
    const now = Date.now()
    const departed = await s.t.run(async (ctx) => {
      const leaver = (userId: string, colour: string) =>
        ctx.db.insert('memberships', {
          userId,
          businessId: s.businessId,
          role: 'subcontractor',
          canViewAllJobs: false,
          colour,
          status: 'removed',
          createdAt: now,
        })
      return [
        await leaver('left-1', MEMBER_COLOURS[3]),
        await leaver('left-2', MEMBER_COLOURS[4]),
      ]
    })
    const share = Array.from({ length: MAX_STROKES_PER_AUTHOR }, () => ({
      page: 1,
      points: 1,
    }))
    for (const author of [s.kevinId, s.priyaId, ...departed]) {
      await seed(s, s.kevinReport, author, share)
    }
    expect(await rows(s)).toHaveLength(MAX_STROKES_PER_REPORT)

    await expect(draw(s, s.terence, s.kevinReport)).rejects.toThrow(
      'REPORT_FULL_OF_MARKS',
    )
    await expect(draw(s, s.kevin, s.kevinReport)).rejects.toThrow(
      'TOO_MANY_STROKES',
    )

    // Kevin clears his marks on page 1: room for him, and for Terence.
    await s.kevin.as.mutation(api.reportAnnotations.clearMyStrokes, {
      businessId: s.businessId,
      reportId: s.kevinReport,
      page: 1,
    })
    await draw(s, s.terence, s.kevinReport)
    await draw(s, s.kevin, s.kevinReport)
  })

  test('marks on one report do not count against another', async () => {
    const s = await setup()
    await seed(
      s,
      s.kevinReport,
      s.kevinId,
      Array.from({ length: MAX_STROKES_PER_REPORT }, () => ({
        page: 1,
        points: 1,
      })),
    )
    await draw(s, s.priya, s.priyaReport)
    expect(await marks(s, s.priya, s.priyaReport)).toHaveLength(1)
  })
})

/** Undo, as the new viewer asks for it: this mark, by its id. */
function remove(
  s: Setup,
  actor: TestActor,
  reportId: Id<'reports'>,
  strokeId: Id<'reportPdfAnnotations'>,
) {
  return actor.as.mutation(api.reportAnnotations.removeStroke, {
    businessId: s.businessId,
    reportId,
    strokeId,
  })
}

/** A finalised report of someone's in a business of its own, with one mark
 * of theirs on it: the far side of a cross-business id. */
async function rivalReport(s: Setup) {
  const rival = await createActor(s.t, { email: 'rival@other.test' })
  const other = await createBusiness(s.t, rival, 'Other Pest')
  const now = Date.now()
  const reportId = await s.t.run(async (ctx) => {
    const clientId = await ctx.db.insert('clients', {
      businessId: other.businessId,
      kind: 'person',
      name: 'P. Walsh',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId: other.businessId,
      clientId,
      addressLine: '3 Banksia Road',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
      createdAt: now,
    })
    return ctx.db.insert('reports', {
      businessId: other.businessId,
      propertyId,
      authorMembershipId: other.ownerMembershipId,
      template: 'serviceReport',
      templateVersion: 1,
      legalBasis: 'APVMA · AEPMA',
      status: 'finalised',
      data: {},
      photoIds: [],
      finalisedAt: now,
      createdAt: now,
    })
  })
  const strokeId = await rival.as.mutation(api.reportAnnotations.addStroke, {
    businessId: other.businessId,
    reportId,
    page: 1,
    points: STROKE,
  })
  return { rival, businessId: other.businessId, reportId, strokeId }
}

describe('removeStroke: Undo takes the mark it named, and only that', () => {
  /**
   * The race that made Undo inexact. Kevin draws B, taps Undo while B is
   * still saving, and draws C while the Undo waits for B's id. C reaches the
   * server before the Undo does; "my newest on this page" would take C — the
   * mark still on his screen — and leave B. By id, B goes and C stays.
   */
  test('a mark drawn after the Undo was aimed is not the one it takes', async () => {
    const s = await setup()
    const a = await draw(s, s.kevin, s.kevinReport, 1)
    const b = await draw(s, s.kevin, s.kevinReport, 1)
    const c = await draw(s, s.kevin, s.kevinReport, 1)

    const result = await remove(s, s.kevin, s.kevinReport, b)
    expect(result).toBeNull()
    expect((await rows(s)).map((r) => r._id)).toEqual([a, c])
  })

  test('on whatever page the mark is: no page to name, none to get wrong', async () => {
    const s = await setup()
    const onOne = await draw(s, s.kevin, s.kevinReport, 1)
    const onThree = await draw(s, s.kevin, s.kevinReport, 3)

    await remove(s, s.kevin, s.kevinReport, onOne)
    expect((await marks(s, s.kevin, s.kevinReport)).map((m) => m.id)).toEqual([
      onThree,
    ])
  })

  /** Two Undo taps a moment apart that both reached for one mark, or a Clear
   * of its page that landed first: the mark is gone, as asked. */
  test('a mark already gone is quietly nothing, and nothing else goes', async () => {
    const s = await setup()
    const kept = await draw(s, s.kevin, s.kevinReport, 1)
    const gone = await draw(s, s.kevin, s.kevinReport, 1)
    await remove(s, s.kevin, s.kevinReport, gone)

    expect(await remove(s, s.kevin, s.kevinReport, gone)).toBeNull()
    expect((await rows(s)).map((r) => r._id)).toEqual([kept])

    const cleared = await draw(s, s.kevin, s.kevinReport, 2)
    await s.kevin.as.mutation(api.reportAnnotations.clearMyStrokes, {
      businessId: s.businessId,
      reportId: s.kevinReport,
      page: 2,
    })
    expect(await remove(s, s.kevin, s.kevinReport, cleared)).toBeNull()
    expect((await rows(s)).map((r) => r._id)).toEqual([kept])
  })

  test('nobody removes a mark someone else drew — not even the owner', async () => {
    const s = await setup()
    const kevins = await draw(s, s.kevin, s.kevinReport, 1)
    const terences = await draw(s, s.terence, s.kevinReport, 1)

    await expect(remove(s, s.terence, s.kevinReport, kevins)).rejects.toThrow(
      'NO_ACCESS',
    )
    await expect(remove(s, s.kevin, s.kevinReport, terences)).rejects.toThrow(
      'NO_ACCESS',
    )
    expect(await rows(s)).toHaveLength(2)
  })

  /**
   * Working in Kevin's account, Terence is still Terence: the mark he may
   * take back is the one he drew there, not Kevin's, whose account it is.
   */
  test('working in someone else’s account, only your own marks are yours to remove', async () => {
    const s = await setup()
    const kevins = await draw(s, s.kevin, s.kevinReport, 1)
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })
    const terences = await draw(s, s.terence, s.kevinReport, 1)

    await expect(remove(s, s.terence, s.kevinReport, kevins)).rejects.toThrow(
      'NO_ACCESS',
    )
    await remove(s, s.terence, s.kevinReport, terences)
    expect((await rows(s)).map((r) => r._id)).toEqual([kevins])
  })

  /** The report is what the gate checked, so the mark must be on it: an id
   * from another report must not reach past the check. */
  test('a mark on another report is not found through this one', async () => {
    const s = await setup()
    // Terence may see both reports, and the mark on Priya's is his own —
    // it is still not on Kevin's.
    const onPriyas = await draw(s, s.terence, s.priyaReport, 1)

    await expect(remove(s, s.terence, s.kevinReport, onPriyas)).rejects.toThrow(
      'NOT_FOUND',
    )
    expect(await rows(s)).toHaveLength(1)
  })

  test('a mark in another business is not found, from either side', async () => {
    const s = await setup()
    const ours = await draw(s, s.kevin, s.kevinReport, 1)
    const far = await rivalReport(s)

    // The rival names his own report, which passes his gate, and our mark.
    await expect(
      far.rival.as.mutation(api.reportAnnotations.removeStroke, {
        businessId: far.businessId,
        reportId: far.reportId,
        strokeId: ours,
      }),
    ).rejects.toThrow('NOT_FOUND')
    // Terence names ours, and the rival's mark.
    await expect(
      remove(s, s.terence, s.kevinReport, far.strokeId),
    ).rejects.toThrow('NOT_FOUND')
    expect((await rows(s)).map((r) => r._id).sort()).toEqual(
      [ours, far.strokeId].sort(),
    )
  })

  test('someone who cannot see the report removes nothing from it', async () => {
    const s = await setup()
    const kevins = await draw(s, s.kevin, s.kevinReport, 1)
    const nadia = await createActor(s.t, { email: 'nadia@elsewhere.test' })

    // A colleague kept to his own work, and a stranger.
    await expect(remove(s, s.priya, s.kevinReport, kevins)).rejects.toThrow(
      'NO_ACCESS',
    )
    await expect(remove(s, nadia, s.kevinReport, kevins)).rejects.toThrow(
      'NO_ACCESS',
    )
    // Kevin himself, once removed from the team.
    await s.t.run((ctx) => ctx.db.patch(s.kevinId, { status: 'removed' }))
    await expect(remove(s, s.kevin, s.kevinReport, kevins)).rejects.toThrow(
      'NO_ACCESS',
    )
    expect(await rows(s)).toHaveLength(1)
  })

  /** Asked who you are before whether the mark is there: a stranger cannot
   * use "gone" against "refused" to learn which ids exist. */
  test('a stranger is refused even for a mark that is already gone', async () => {
    const s = await setup()
    const gone = await draw(s, s.kevin, s.kevinReport, 1)
    await remove(s, s.kevin, s.kevinReport, gone)
    const nadia = await createActor(s.t, { email: 'nadia@elsewhere.test' })

    await expect(remove(s, nadia, s.kevinReport, gone)).rejects.toThrow(
      'NO_ACCESS',
    )
  })

  test('looking through a colleague’s account does not lend her pen', async () => {
    const s = await setup()
    const priyas = await draw(s, s.priya, s.priyaReport)
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevinId, {
        canViewOtherAccounts: true,
        viewingAsMembershipId: s.priyaId,
      }),
    )

    await expect(remove(s, s.kevin, s.priyaReport, priyas)).rejects.toThrow(
      'NO_ACCESS',
    )
    expect(await rows(s)).toHaveLength(1)
  })

  test('a report in Recently Deleted keeps its marks', async () => {
    const s = await setup()
    const kevins = await draw(s, s.kevin, s.kevinReport, 1)
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevinReport, { deletedAt: Date.now() }),
    )

    await expect(remove(s, s.kevin, s.kevinReport, kevins)).rejects.toThrow(
      'NOT_FOUND',
    )
    expect(await rows(s)).toHaveLength(1)
  })

  test('makes room in a full report, as undo does', async () => {
    const s = await setup()
    await seed(
      s,
      s.kevinReport,
      s.kevinId,
      Array.from({ length: MAX_STROKES_PER_REPORT }, () => ({
        page: 1,
        points: 1,
      })),
    )
    await expect(draw(s, s.terence, s.kevinReport)).rejects.toThrow(
      'REPORT_FULL_OF_MARKS',
    )

    const [first] = await rows(s)
    await remove(s, s.kevin, s.kevinReport, first._id)
    await draw(s, s.terence, s.kevinReport)
    expect(await rows(s)).toHaveLength(MAX_STROKES_PER_REPORT)
  })
})

describe('the old viewer’s calls behave as they did', () => {
  test('addStroke saves the stroke as the real person, on the page given, and returns it', async () => {
    const s = await setup()
    const id = await draw(s, s.kevin, s.kevinReport, 2)

    const row = await s.t.run((ctx) => ctx.db.get(id))
    expect(row).toMatchObject({
      reportId: s.kevinReport,
      page: 2,
      authorMembershipId: s.kevinId,
      points: STROKE,
    })
  })

  test('listAnnotations reads one page, everyone’s, oldest first', async () => {
    const s = await setup()
    const first = await draw(s, s.kevin, s.kevinReport, 1)
    await draw(s, s.kevin, s.kevinReport, 2)
    const second = await draw(s, s.terence, s.kevinReport, 1)

    expect(await pageMarks(s, s.kevin, s.kevinReport, 1)).toEqual([
      { _id: first, authorMembershipId: s.kevinId, points: STROKE },
      { _id: second, authorMembershipId: s.ownerMembershipId, points: STROKE },
    ])
  })

  test('undoLastStroke removes the caller’s newest on that page, and nobody else’s', async () => {
    const s = await setup()
    const older = await draw(s, s.terence, s.kevinReport, 1)
    await draw(s, s.terence, s.kevinReport, 1)
    const elsewhere = await draw(s, s.terence, s.kevinReport, 2)
    const kevins = await draw(s, s.kevin, s.kevinReport, 1)

    const result = await s.terence.as.mutation(
      api.reportAnnotations.undoLastStroke,
      { businessId: s.businessId, reportId: s.kevinReport, page: 1 },
    )
    expect(result).toBeNull()
    expect((await rows(s)).map((r) => r._id).sort()).toEqual(
      [older, elsewhere, kevins].sort(),
    )
  })

  /** "Your newest" is the order they were written in, even for two marks
   * stamped with the same millisecond — as the new viewer reads it from
   * `listForReport` when it chooses what its Undo names. */
  test('of two strokes drawn in one millisecond, undo takes the later', async () => {
    const s = await setup()
    await seed(s, s.kevinReport, s.kevinId, [
      { page: 1, points: 2 },
      { page: 1, points: 3 },
    ])
    const [first, second] = await rows(s)
    expect(first.createdAt).toBe(second.createdAt)

    await s.kevin.as.mutation(api.reportAnnotations.undoLastStroke, {
      businessId: s.businessId,
      reportId: s.kevinReport,
      page: 1,
    })
    expect((await rows(s)).map((r) => r._id)).toEqual([first._id])
  })

  test('undoLastStroke with nothing of yours on the page changes nothing', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 1)
    await s.terence.as.mutation(api.reportAnnotations.undoLastStroke, {
      businessId: s.businessId,
      reportId: s.kevinReport,
      page: 1,
    })
    expect(await rows(s)).toHaveLength(1)
  })

  test('clearMyStrokes clears the caller’s own on that page and leaves the rest', async () => {
    const s = await setup()
    await draw(s, s.terence, s.kevinReport, 1)
    await draw(s, s.terence, s.kevinReport, 1)
    const elsewhere = await draw(s, s.terence, s.kevinReport, 2)
    const kevins = await draw(s, s.kevin, s.kevinReport, 1)

    const result = await s.terence.as.mutation(
      api.reportAnnotations.clearMyStrokes,
      { businessId: s.businessId, reportId: s.kevinReport, page: 1 },
    )
    expect(result).toBeNull()
    expect((await rows(s)).map((r) => r._id).sort()).toEqual(
      [elsewhere, kevins].sort(),
    )
  })

  test('the owner cannot undo or clear a mark someone else drew', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 1)
    for (const call of [
      api.reportAnnotations.undoLastStroke,
      api.reportAnnotations.clearMyStrokes,
    ]) {
      await s.terence.as.mutation(call, {
        businessId: s.businessId,
        reportId: s.kevinReport,
        page: 1,
      })
    }
    expect(await rows(s)).toHaveLength(1)
  })

  test('none of the three writes reach someone who cannot see the report', async () => {
    const s = await setup()
    await draw(s, s.kevin, s.kevinReport, 1)
    const args = { businessId: s.businessId, reportId: s.kevinReport, page: 1 }

    await expect(draw(s, s.priya, s.kevinReport)).rejects.toThrow('NO_ACCESS')
    await expect(
      s.priya.as.mutation(api.reportAnnotations.undoLastStroke, args),
    ).rejects.toThrow('NO_ACCESS')
    await expect(
      s.priya.as.mutation(api.reportAnnotations.clearMyStrokes, args),
    ).rejects.toThrow('NO_ACCESS')
    expect(await rows(s)).toHaveLength(1)
  })

  /** Unchanged since the old viewer: marks are not a change to the report,
   * so a draft takes them as a finalised report does. */
  test('a draft takes marks too', async () => {
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.patch(s.kevinReport, { status: 'draft', finalisedAt: undefined }),
    )
    await draw(s, s.kevin, s.kevinReport)
    expect(await marks(s, s.kevin, s.kevinReport)).toHaveLength(1)
  })
})
