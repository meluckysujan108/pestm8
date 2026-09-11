/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import schema from './schema'
import { canDeleteNote, canReadNote, canWriteNote, noteKind } from './lib/noteAccess'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

const modules = import.meta.glob('./**/*.ts')

/**
 * The knowledge-first policy, exercised directly against the database:
 * no auth component in the loop, since `canReadNote` takes the resolved
 * viewer explicitly and that is the whole surface under test.
 */
async function seed(ctx: MutationCtx) {
  const now = Date.now()
  const businessId = await ctx.db.insert('businesses', {
    name: 'Bugs Away',
    slug: 'bugs-away',
    state: 'WA',
    timezone: 'Australia/Perth',
    createdAt: now,
  })
  const insertMember = (userId: string, role: 'owner' | 'subcontractor', canViewAllJobs = false) =>
    ctx.db.insert('memberships', {
      userId,
      businessId,
      role,
      canViewAllJobs,
      colour: '#000000',
      status: 'active',
      createdAt: now,
    })
  const ownerId = await insertMember('u-owner', 'owner', true)
  const subId = await insertMember('u-sub', 'subcontractor')
  const seniorId = await insertMember('u-senior', 'subcontractor', true)

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
  const job = (assignedMembershipId: Id<'memberships'>) =>
    ctx.db.insert('jobs', {
      businessId,
      propertyId,
      assignedMembershipId,
      jobType: 'Termites',
      price: 20000,
      scheduledAt: now,
      durationMinutes: 60,
      status: 'booked',
      createdAt: now,
    })
  const subJobId = await job(subId)
  const ownerJobId = await job(ownerId)

  const note = (
    author: Id<'memberships'>,
    links: Partial<Pick<Doc<'notes'>, 'jobId' | 'propertyId' | 'clientId' | 'deletedAt'>>,
  ) =>
    ctx.db.insert('notes', {
      businessId,
      authorMembershipId: author,
      lastEditedByMembershipId: author,
      ...links,
      title: 'x',
      preview: '',
      plainText: 'x',
      createdAt: now,
      updatedAt: now,
    })

  return {
    ownerId,
    subId,
    seniorId,
    teamNote: await note(ownerId, {}),
    siteNote: await note(ownerId, { propertyId, clientId }),
    noteOnSubsJob: await note(ownerId, { jobId: subJobId, propertyId, clientId }),
    noteOnOwnersJob: await note(ownerId, { jobId: ownerJobId, propertyId, clientId }),
    subsOwnDeletedNote: await note(subId, { deletedAt: now }),
    mention: (noteId: Id<'notes'>, membershipId: Id<'memberships'>) =>
      ctx.db.insert('noteMentions', {
        businessId,
        noteId,
        membershipId,
        mentionedByMembershipId: ownerId,
        createdAt: now,
      }),
  }
}

async function member(ctx: MutationCtx, id: Id<'memberships'>) {
  const m = await ctx.db.get(id)
  if (!m) throw new Error('missing membership')
  return m
}

async function read(ctx: MutationCtx, real: Id<'memberships'>, noteId: Id<'notes'>, scope = real) {
  const note = await ctx.db.get(noteId)
  if (!note) throw new Error('missing note')
  return canReadNote(ctx, { real: await member(ctx, real), scope: await member(ctx, scope) }, note)
}

describe('canReadNote', () => {
  test('site and team notes are shared knowledge: any active member reads them', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      expect(await read(ctx, s.subId, s.teamNote)).toBe(true)
      expect(await read(ctx, s.subId, s.siteNote)).toBe(true)
    })
  })

  test("the tech on a job sees the owner's notes about it", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      expect(await read(ctx, s.subId, s.noteOnSubsJob)).toBe(true)
    })
  })

  test("job notes on someone else's job stay hidden without canViewAllJobs", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      expect(await read(ctx, s.subId, s.noteOnOwnersJob)).toBe(false)
      expect(await read(ctx, s.seniorId, s.noteOnOwnersJob)).toBe(true)
    })
  })

  test('being @mentioned grants read on that note', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      await s.mention(s.noteOnOwnersJob, s.subId)
      expect(await read(ctx, s.subId, s.noteOnOwnersJob)).toBe(true)
    })
  })

  test('"view as" narrows job visibility but never changes who you are', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      // Owner viewing as the sub: the owner's own note is still theirs...
      expect(await read(ctx, s.ownerId, s.noteOnOwnersJob, s.subId)).toBe(true)
      // ...but a senior sub viewing as the junior loses the owner's job.
      expect(await read(ctx, s.seniorId, s.noteOnOwnersJob, s.subId)).toBe(false)
    })
  })

  test('a mention is matched against who you really are, never who you view as', async () => {
    // Forward: the senior sub is mentioned; viewing as the junior keeps it.
    const forward = convexTest(schema, modules)
    await forward.run(async (ctx) => {
      const s = await seed(ctx)
      await s.mention(s.noteOnOwnersJob, s.seniorId)
      expect(await read(ctx, s.seniorId, s.noteOnOwnersJob, s.subId)).toBe(true)
    })
    // Reverse: only the junior is mentioned; the senior viewing as the
    // junior must NOT inherit the junior's mention.
    const reverse = convexTest(schema, modules)
    await reverse.run(async (ctx) => {
      const s = await seed(ctx)
      await s.mention(s.noteOnOwnersJob, s.subId)
      expect(await read(ctx, s.seniorId, s.noteOnOwnersJob, s.subId)).toBe(false)
    })
  })

  test('deleted notes are only visible to their author or the owner', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      expect(await read(ctx, s.subId, s.subsOwnDeletedNote)).toBe(true)
      expect(await read(ctx, s.ownerId, s.subsOwnDeletedNote)).toBe(true)
      expect(await read(ctx, s.seniorId, s.subsOwnDeletedNote)).toBe(false)
    })
  })
})

describe('canWriteNote', () => {
  test('readable and live means editable; trashed notes are read-only', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      const sub = await member(ctx, s.subId)
      const trashed = (await ctx.db.get(s.subsOwnDeletedNote))!
      const site = (await ctx.db.get(s.siteNote))!
      expect(await canReadNote(ctx, { real: sub, scope: sub }, trashed)).toBe(true)
      expect(await canWriteNote(ctx, { real: sub, scope: sub }, trashed)).toBe(false)
      expect(await canWriteNote(ctx, { real: sub, scope: sub }, site)).toBe(true)
    })
  })

  test('"view as" never widens or narrows what you may write', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      const senior = await member(ctx, s.seniorId)
      const sub = await member(ctx, s.subId)
      const note = (await ctx.db.get(s.noteOnOwnersJob))!
      // The senior can see the whole business; viewing as the junior hides
      // this note from them but must not stop them editing it as themselves.
      expect(await canReadNote(ctx, { real: senior, scope: sub }, note)).toBe(false)
      expect(await canWriteNote(ctx, { real: senior, scope: sub }, note)).toBe(true)
      // And the junior viewing as the senior gains nothing.
      expect(await canWriteNote(ctx, { real: sub, scope: senior }, note)).toBe(false)
    })
  })
})

describe('canDeleteNote', () => {
  test('what you wrote, or anything if you own the business', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const s = await seed(ctx)
      const ownersNote = (await ctx.db.get(s.teamNote))!
      const subsNote = (await ctx.db.get(s.subsOwnDeletedNote))!
      expect(canDeleteNote(await member(ctx, s.ownerId), subsNote)).toBe(true)
      expect(canDeleteNote(await member(ctx, s.subId), subsNote)).toBe(true)
      expect(canDeleteNote(await member(ctx, s.subId), ownersNote)).toBe(false)
      expect(canDeleteNote(await member(ctx, s.seniorId), subsNote)).toBe(false)
    })
  })
})

test('noteKind reads the links, most specific first', () => {
  const ids = {
    jobId: 'j' as Id<'jobs'>,
    propertyId: 'p' as Id<'properties'>,
    clientId: 'c' as Id<'clients'>,
  }
  expect(noteKind(ids)).toBe('job')
  expect(noteKind({ propertyId: ids.propertyId, clientId: ids.clientId })).toBe('site')
  expect(noteKind({ clientId: ids.clientId })).toBe('client')
  expect(noteKind({})).toBe('team')
})
