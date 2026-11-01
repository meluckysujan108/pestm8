/// <reference types="vite/client" />
import { beforeAll, describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import {
  addDaysToKey,
  startOfDayInZone,
  startOfWeekKey,
  todayKeyInZone,
} from './lib/dates'
import { KEPT_FNS, KEPT_SHAPE } from '../src/lib/offline/keptShape'
import type { TestAs } from '../test/harness'
import type { KeptFn } from '../src/lib/offline/keptShape'

/**
 * The answers a phone keeps for opening the schedule and New Job with no
 * signal (src/lib/offline/), held to the shape KEPT_SHAPE stands for.
 *
 * A phone holds these answers for up to three weeks, and reads them with
 * whatever build it runs next. A field renamed or removed here would reach
 * that build missing from a copy written by the last one; KEPT_SHAPE is what
 * tells the two apart, and the phone skips a copy of another shape. So the
 * six queries are run, as the owner and as a subcontractor, over a business
 * with one of most things a field can come from — a person and a business
 * client, a contact person, a site contact, a shared job, a recurring visit,
 * a finished job, an archived client, the business's own job type, and a
 * job and a Recurring Job of the owner's that the subcontractor sees only
 * the dates of — and every key path in their answers is compared with the
 * list below, which was written at SHAPE_AT. A change to either fails here
 * until both are changed together.
 *
 * Only what this seed produces is seen: a field that only some other record
 * carries can still change unnoticed, which is why each kept query also says
 * so above it.
 */

const CHANGED =
  'A query kept on phones changed shape: bump KEPT_SHAPE and update this list.'

/** The KEPT_SHAPE the list below describes. */
const SHAPE_AT = 1

/**
 * Every key path in each kept query's answers: `[]` is an item of a list.
 * Sorted. A key whose value is `undefined` is left out, as the wire leaves
 * it out.
 */
const KEPT_PATHS: Record<KeptFn, ReadonlyArray<string>> = {
  'jobs:listDay': [
    '[]._creationTime',
    '[]._id',
    '[].addressLine',
    '[].alsoGoing',
    '[].alsoGoing[]._id',
    '[].alsoGoing[].colour',
    '[].alsoGoing[].name',
    '[].assignedMembershipId',
    '[].assigneeColour',
    '[].assigneeName',
    '[].businessId',
    '[].clientEmail',
    '[].clientKind',
    '[].clientName',
    '[].clientPhone',
    '[].clientRequestId',
    '[].completedAt',
    '[].contactPersonName',
    '[].contactPersonPhone',
    '[].createdAt',
    '[].durationMinutes',
    '[].jobNumber',
    '[].jobType',
    '[].notePreview',
    '[].occurrenceAt',
    '[].postcode',
    '[].price',
    '[].pricesHidden',
    '[].propertyId',
    '[].propertyState',
    '[].recurrenceId',
    '[].repeats',
    '[].repeats.count',
    '[].repeats.unit',
    '[].scheduledAt',
    '[].siteContactName',
    '[].siteContactPhone',
    '[].status',
    '[].suburb',
    '[].workOrder',
  ],
  'jobs:listWeek': [
    '[].colours',
    '[].count',
    '[].dayKey',
    '[].offset',
    '[].postcode',
    '[].recurringCount',
    '[].suburb',
  ],
  'clients:directory': [
    'capped',
    'clients',
    'clients[]._creationTime',
    'clients[]._id',
    'clients[].abn',
    'clients[].archivedAt',
    'clients[].clientNumber',
    'clients[].createdAt',
    'clients[].email',
    'clients[].kind',
    'clients[].name',
    'clients[].phone',
    'clients[].status',
    'clients[].tags',
    'contacts',
    'contactsCapped',
    'contacts[]._id',
    'contacts[].clientId',
    'contacts[].email',
    'contacts[].name',
    'contacts[].phone',
    'contacts[].role',
    'sites',
    'sites[]._id',
    'sites[].addressLine',
    'sites[].clientId',
    'sites[].createdAt',
    'sites[].postcode',
    'sites[].siteContactName',
    'sites[].siteContactPhone',
    'sites[].suburb',
  ],
  'memberships:listForBusiness': [
    '[]._id',
    '[].bookable',
    '[].canViewAllJobs',
    '[].canViewOtherAccounts',
    '[].colour',
    '[].email',
    '[].licenceNumber',
    '[].name',
    '[].phone',
    '[].role',
    '[].status',
  ],
  'jobTypes:list': ['[].formerNames', '[].name', '[].offered', '[].report'],
  // As the owner, everything in full; as Kevin, his own work and the shared
  // job in full, the owner's as a site and a date (`series` for a visit),
  // and the owner's Recurring Job with only its next visit.
  'jobs:openWork': [
    'rows',
    'rows[].assignedMembershipId',
    'rows[].at',
    'rows[].jobId',
    'rows[].jobNumber',
    'rows[].jobType',
    'rows[].propertyId',
    'rows[].recurrenceId',
    'rows[].scheduledAt',
    'rows[].series',
    'rows[].status',
    'series',
    'series[]._id',
    'series[].intervalCount',
    'series[].intervalUnit',
    'series[].jobType',
    'series[].nextAt',
    'series[].propertyId',
  ],
}

/** Every key path in `value`, into `into`. */
function keyPaths(
  value: unknown,
  at = '',
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, `${at}[]`, into)
    return into
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue
      const path = at === '' ? key : `${at}.${key}`
      into.add(path)
      keyPaths(inner, path, into)
    }
  }
  return into
}

const TZ = 'Australia/Perth'
const HOUR = 60 * 60 * 1000

/** What each kept query answered, as the owner and as Kevin, by path. */
const answered = new Map<KeptFn, Array<string>>()

beforeAll(async () => {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, {
    email: 'kevin@pestm8.test',
    name: 'Kevin',
  })
  const kevinId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  // Their numbers, which the roster sends to whoever manages the team.
  await owner.as.mutation(api.memberships.setProfile, {
    businessId,
    membershipId: ownerMembershipId,
    phone: '0412 000 111',
  })
  for (const [membershipId, licenceNumber] of [
    [ownerMembershipId, 'PMT-4471'],
    [kevinId, 'TECH-8821'],
  ] as const) {
    await owner.as.mutation(api.memberships.setLicence, {
      businessId,
      membershipId,
      licenceNumber,
    })
  }

  // The business's own service, beside the nine it starts with.
  await owner.as.mutation(api.jobTypes.create, {
    businessId,
    name: 'Possum Proofing',
    report: 'serviceReport',
  })

  const personSite = await owner.as.mutation(api.properties.create, {
    businessId,
    kind: 'person',
    clientName: 'Arthur Wellard',
    phone: '0412 345 678',
    email: 'arthur@example.com',
    tags: ['Referral'],
    addressLine: '12 Wattle Street',
    suburb: 'Wellard',
    state: 'WA',
    postcode: '6170',
  })
  // A business client with its contact person, whose own number the card's
  // Call rings, and a site contact on its site.
  const schoolSite = await owner.as.mutation(api.properties.create, {
    businessId,
    kind: 'business',
    clientName: 'Karratha Primary School',
    abn: '51 824 753 556',
    phone: '08 9185 1234',
    contactPerson: 'Dana Reception',
    status: 'active',
    addressLine: '14 Balmoral Rd',
    suburb: 'Bulgarra',
    state: 'WA',
    postcode: '6714',
    siteContactName: 'Pat Caretaker',
    siteContactPhone: '0499 111 222',
  })
  const contact = await t.run(async (ctx) => {
    const site = await ctx.db.get(schoolSite)
    if (!site) throw new Error('the school has no site')
    return ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', site.clientId))
      .first()
  })
  if (!contact) throw new Error('the school has no contact person')
  await owner.as.mutation(api.clientContacts.update, {
    businessId,
    contactId: contact._id,
    phone: '0400 555 666',
  })
  // A second contact person, with a role and an email, which the directory
  // sends for matching a caller.
  await owner.as.mutation(api.clientContacts.create, {
    businessId,
    clientId: contact.clientId,
    name: 'Terry Bursar',
    role: 'Bursar',
    email: 'bursar@karratha.test',
  })
  // Archived, which the directory still sends, for the pickers.
  const oldSite = await owner.as.mutation(api.properties.create, {
    businessId,
    clientName: 'Old Mate Holdings',
    addressLine: '3 Gone Way',
    suburb: 'Kwinana',
    state: 'WA',
    postcode: '6167',
  })
  const oldClient = await t.run(
    async (ctx) => (await ctx.db.get(oldSite))?.clientId,
  )
  if (!oldClient) throw new Error('the old client has no site')
  await owner.as.mutation(api.clients.archive, {
    businessId,
    clientId: oldClient,
  })

  const today = todayKeyInZone(TZ)
  const at = (dayKey: string, hour: number) =>
    startOfDayInZone(dayKey, TZ) + hour * HOUR

  // Shared: the owner leads, Kevin is also going. Booked from a phone (its
  // request id), with a work order and a note.
  await owner.as.mutation(api.jobs.create, {
    businessId,
    propertyId: schoolSite,
    assignedMembershipId: ownerMembershipId,
    alsoGoing: [kevinId],
    jobType: 'Possum Proofing',
    price: 38000,
    scheduledAt: at(today, 9),
    durationMinutes: 90,
    workOrder: 'PO-4471',
    notes: 'Key at the office',
    clientRequestId: '3f1c2a9e-7b4d-4c1a-9e2f-5a6b7c8d9e0f',
  })
  // Kevin's own, finished.
  const kevinsJob = await owner.as.mutation(api.jobs.create, {
    businessId,
    propertyId: personSite,
    assignedMembershipId: kevinId,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: at(today, 13),
    durationMinutes: 60,
  })
  await owner.as.mutation(api.jobs.complete, { businessId, jobId: kevinsJob })
  // Weekly from a week ago, so today's visit is a projection on today.
  await owner.as.mutation(api.recurrences.create, {
    businessId,
    propertyId: personSite,
    assignedMembershipId: kevinId,
    intervalCount: 1,
    intervalUnit: 'week',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: at(addDaysToKey(today, -7), 15),
    durationMinutes: 45,
  })
  // The owner's own, which Kevin isn't on: a job, and a monthly Recurring
  // Job, both after today, so the day above holds nothing more.
  await owner.as.mutation(api.jobs.create, {
    businessId,
    propertyId: personSite,
    assignedMembershipId: ownerMembershipId,
    jobType: 'Termite Inspection',
    price: 32000,
    scheduledAt: at(addDaysToKey(today, 2), 10),
    durationMinutes: 60,
  })
  await owner.as.mutation(api.recurrences.create, {
    businessId,
    propertyId: schoolSite,
    assignedMembershipId: ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'month',
    jobType: 'General Pest Control',
    price: 24000,
    anchorDate: at(addDaysToKey(today, 3), 10),
    durationMinutes: 60,
  })

  // The zone's week as of `today`, as the cron would have it: the business
  // was made before `today` was read, and a week may have turned between.
  await t.run(async (ctx) => {
    const week = await ctx.db
      .query('zoneWeeks')
      .withIndex('by_timezone', (q) => q.eq('timezone', TZ))
      .unique()
    await ctx.db.patch(week!._id, { monday: startOfWeekKey(today) })
  })

  // The keys the phone keeps them under (keptQueries, src/lib/offline/
  // keptSet.ts): a day, a week, and the business; what is booked at each
  // site, by this week's Monday.
  const asked: Record<KeptFn, (as: TestAs) => Promise<unknown>> = {
    'jobs:listDay': (as) =>
      as.query(api.jobs.listDay, { businessId, dayKey: today }),
    'jobs:listWeek': (as) =>
      as.query(api.jobs.listWeek, {
        businessId,
        startKey: startOfWeekKey(today),
      }),
    'clients:directory': (as) =>
      as.query(api.clients.directory, { businessId }),
    'memberships:listForBusiness': (as) =>
      as.query(api.memberships.listForBusiness, { businessId }),
    'jobTypes:list': (as) => as.query(api.jobTypes.list, { businessId }),
    'jobs:openWork': (as) =>
      as.query(api.jobs.openWork, {
        businessId,
        startKey: startOfWeekKey(today),
      }),
  }
  for (const fn of KEPT_FNS) {
    const paths = new Set<string>()
    for (const who of [owner, kevin])
      keyPaths(await asked[fn](who.as), '', paths)
    answered.set(fn, [...paths].sort())
  }
}, 60_000)

describe('what phones keep is in the shape KEPT_SHAPE names', () => {
  test('the list below was written at this KEPT_SHAPE', () => {
    expect(KEPT_SHAPE, CHANGED).toBe(SHAPE_AT)
  })

  test.each(KEPT_FNS)('%s', (fn) => {
    expect(answered.get(fn), CHANGED).toEqual(KEPT_PATHS[fn])
  })
})
