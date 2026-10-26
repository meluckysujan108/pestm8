/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from './_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../test/harness'
import type { FunctionArgs } from 'convex/server'
import type { Id } from './_generated/dataModel'

/**
 * The bookings a phone keeps with no signal (src/lib/outbox/), sent to
 * `jobs.create` and `recurrences.create` exactly as the first build to keep
 * them sends them: outbox version 1, every mode New Job has (a site already
 * in the directory, a new site for a client, a new client), as a one-off and
 * as a Recurring Job. Each mode twice: once with every field it can carry,
 * and once with only what it must, as most are sent (New Job leaves a blank
 * out, and a person client has no ABN, contact person or site contact). The
 * first catches a field dropped or a value narrowed; the second, a field
 * that was optional made required.
 *
 * A phone may hold one of these for days, and sends it, and sends it again,
 * to whatever backend is live by then. Convex checks the arguments before
 * the handler runs, so a field dropped or narrowed since refuses the send
 * and its repeat with an ArgumentValidationError, before the request id's
 * lookup can answer it (lib/clientRequest.ts) — and on prod that reaches the
 * phone as a bare "Server Error", which it can't tell from any other. So
 * these are written out here as they were frozen, typed as nothing in
 * particular, and the validators alone judge them, as they would a phone's.
 * Only the ids come from this test's business.
 *
 * If one of these fails, the change narrowed what phones still hold: widen
 * it instead. Never edit a payload here to make it pass. A new shape is a
 * new outbox version, with its own payloads beside these, and these stay
 * for as long as any phone could hold one.
 */

const DAY = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.unstubAllEnvs()
})

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const kevinMembershipId = await joinBusiness(
    t,
    owner,
    kevin,
    businessId,
    'subcontractor',
  )
  const jane = await t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'Jane Smith',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '14 Rosewood Ave',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
      createdAt: now,
    })
    return { clientId, propertyId }
  })
  const at: At = {
    businessId,
    propertyId: jane.propertyId,
    clientId: jane.clientId,
    owner: ownerMembershipId,
    kevin: kevinMembershipId,
    start: Date.now() + DAY,
  }
  return { owner, at }
}

/** What a payload names from this test's business. */
type At = {
  businessId: Id<'businesses'>
  propertyId: Id<'properties'>
  clientId: Id<'clients'>
  owner: Id<'memberships'>
  kevin: Id<'memberships'>
  start: number
}

/** A payload as a phone holds it: no type of today's says what it may be. */
type Frozen = Record<string, unknown>

// ─────────────────────────────────────────── outbox version 1, frozen

const ONE_OFF_V1: Record<string, (at: At) => Frozen> = {
  'at a site already in the directory': (at) => ({
    businessId: at.businessId,
    propertyId: at.propertyId,
    assignedMembershipId: at.kevin,
    jobType: 'General Pest Control',
    price: 22000,
    scheduledAt: at.start,
    durationMinutes: 90,
    workOrder: 'WO-4471',
    notes: 'Side gate code 4411.',
    alsoGoing: [at.owner],
    clientRequestId: '0b9e6f1c-2a47-4d83-9c15-6e2f8a4b7d01',
    asMembership: at.owner,
  }),
  'at a new site for a client': (at) => ({
    businessId: at.businessId,
    newProperty: {
      clientId: at.clientId,
      addressLine: '5 Banksia Road',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      siteContactName: 'Mia',
      siteContactPhone: '0413 222 333',
      addressCheck: 'typed',
    },
    assignedMembershipId: at.kevin,
    jobType: 'Termite inspection',
    price: 35000,
    scheduledAt: at.start,
    durationMinutes: 120,
    workOrder: 'WO-4472',
    notes: 'Dog in the yard.',
    alsoGoing: [at.owner],
    clientRequestId: '1c8d5e2b-3b56-4e92-8d24-7f3a9b5c8e12',
    asMembership: at.owner,
  }),
  'for a new client': (at) => ({
    businessId: at.businessId,
    newClient: {
      clientName: 'Harbour View Strata',
      kind: 'business',
      phone: '0412 345 678',
      email: 'office@harbourview.test',
      abn: '51 824 753 556',
      contactPerson: 'Dev Shah',
      status: 'active',
      tags: ['Strata'],
      addressLine: '12 Marine Parade',
      suburb: 'Cottesloe',
      state: 'WA',
      postcode: '6011',
      siteContactName: 'Mia',
      siteContactPhone: '0413 222 333',
      addressCheck: 'picked',
    },
    assignedMembershipId: at.kevin,
    jobType: 'General Pest Control',
    price: 48000,
    scheduledAt: at.start,
    durationMinutes: 60,
    workOrder: 'WO-4473',
    notes: 'Keys with the caretaker.',
    alsoGoing: [at.owner],
    clientRequestId: '2d7c4f3a-4c65-4fa1-ae33-8a4bac6d9f23',
    asMembership: at.owner,
  }),
  'at a site already in the directory, with nothing it needn’t': (at) => ({
    businessId: at.businessId,
    propertyId: at.propertyId,
    assignedMembershipId: at.owner,
    jobType: 'General Pest Control',
    price: 0,
    scheduledAt: at.start,
    durationMinutes: 60,
    clientRequestId: '6b38fd76-8aa1-43ef-a27f-ce8f0aa1d367',
    asMembership: at.owner,
  }),
  'at a new site for a client, with nothing it needn’t': (at) => ({
    businessId: at.businessId,
    newProperty: {
      clientId: at.clientId,
      addressLine: '9 Kalamunda Road',
      suburb: 'Kalamunda',
      state: 'WA',
      postcode: '6076',
    },
    assignedMembershipId: at.kevin,
    jobType: 'General Pest Control',
    price: 19000,
    scheduledAt: at.start,
    durationMinutes: 60,
    clientRequestId: '7c27ee85-9bb0-4400-b38e-df9e1bb2e478',
    asMembership: at.owner,
  }),
  'for a new person client, with nothing it needn’t': (at) => ({
    businessId: at.businessId,
    newClient: {
      clientName: 'Liam Nguyen',
      kind: 'person',
      addressLine: '3 Wattle Street',
      suburb: 'Midland',
      state: 'WA',
      postcode: '6056',
    },
    assignedMembershipId: at.kevin,
    jobType: 'Cockroaches',
    price: 16500,
    scheduledAt: at.start,
    durationMinutes: 45,
    clientRequestId: '8d16df94-acc1-4511-849f-e0af2cc3f589',
    asMembership: at.owner,
  }),
}

const SERIES_V1: Record<string, (at: At) => Frozen> = {
  'at a site already in the directory': (at) => ({
    businessId: at.businessId,
    propertyId: at.propertyId,
    assignedMembershipId: at.kevin,
    intervalCount: 3,
    intervalUnit: 'month',
    jobType: 'Rodents',
    price: 18000,
    anchorDate: at.start,
    durationMinutes: 45,
    workOrder: 'WO-5501',
    notes: 'Bait stations behind the shed.',
    clientRequestId: '3e6b3a49-5d74-40b0-bf42-9b5cbd7ea034',
    asMembership: at.owner,
    refuseBackfill: true,
  }),
  'at a new site for a client': (at) => ({
    businessId: at.businessId,
    newProperty: {
      clientId: at.clientId,
      addressLine: '5 Banksia Road',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      siteContactName: 'Mia',
      siteContactPhone: '0413 222 333',
      addressCheck: 'picked',
    },
    assignedMembershipId: at.kevin,
    intervalCount: 1,
    intervalUnit: 'year',
    jobType: 'Termite inspection',
    price: 35000,
    anchorDate: at.start,
    durationMinutes: 120,
    workOrder: 'WO-5502',
    notes: 'Check the patio slab.',
    clientRequestId: '4f5a2b58-6e83-41cf-8051-ac6dce8fb145',
    asMembership: at.owner,
    refuseBackfill: true,
  }),
  'for a new client': (at) => ({
    businessId: at.businessId,
    newClient: {
      clientName: 'Harbour View Strata',
      kind: 'business',
      phone: '0412 345 678',
      email: 'office@harbourview.test',
      abn: '51 824 753 556',
      contactPerson: 'Dev Shah',
      status: 'active',
      tags: ['Strata'],
      addressLine: '12 Marine Parade',
      suburb: 'Cottesloe',
      state: 'WA',
      postcode: '6011',
      siteContactName: 'Mia',
      siteContactPhone: '0413 222 333',
      addressCheck: 'typed',
    },
    assignedMembershipId: at.kevin,
    intervalCount: 2,
    intervalUnit: 'week',
    jobType: 'General Pest Control',
    price: 26000,
    anchorDate: at.start,
    durationMinutes: 60,
    workOrder: 'WO-5503',
    notes: 'Bins out the back.',
    clientRequestId: '5a493c67-7f92-42de-9160-bd7edf90c256',
    asMembership: at.owner,
    refuseBackfill: true,
  }),
  // Without `refuseBackfill` too: it goes only when the first visit was
  // meant to be booked, and a series started weeks back is sent without it.
  'at a site already in the directory, with nothing it needn’t': (at) => ({
    businessId: at.businessId,
    propertyId: at.propertyId,
    assignedMembershipId: at.owner,
    intervalCount: 10,
    intervalUnit: 'day',
    jobType: 'Fleas',
    price: 0,
    anchorDate: at.start,
    durationMinutes: 30,
    clientRequestId: '9e05c0a3-bdd2-4622-95a0-f1b03dd4069a',
    asMembership: at.owner,
  }),
  'at a new site for a client, with nothing it needn’t': (at) => ({
    businessId: at.businessId,
    newProperty: {
      clientId: at.clientId,
      addressLine: '9 Kalamunda Road',
      suburb: 'Kalamunda',
      state: 'WA',
      postcode: '6076',
    },
    assignedMembershipId: at.kevin,
    intervalCount: 6,
    intervalUnit: 'month',
    jobType: 'General Pest Control',
    price: 19000,
    anchorDate: at.start,
    durationMinutes: 60,
    clientRequestId: 'af94b1b2-cee3-4733-a6b1-02c14ee517ab',
    asMembership: at.owner,
  }),
  'for a new person client, with nothing it needn’t': (at) => ({
    businessId: at.businessId,
    newClient: {
      clientName: 'Liam Nguyen',
      kind: 'person',
      addressLine: '3 Wattle Street',
      suburb: 'Midland',
      state: 'WA',
      postcode: '6056',
    },
    assignedMembershipId: at.kevin,
    intervalCount: 1,
    intervalUnit: 'year',
    jobType: 'Termite inspection',
    price: 30000,
    anchorDate: at.start,
    durationMinutes: 90,
    clientRequestId: 'b083a2c1-dff4-4844-b7c2-13d25ff628bc',
    asMembership: at.owner,
  }),
}

/** `clientRequests.find`, as the phone asks it when an answer went missing. */
function findV1(at: At, clientRequestId: unknown, kind: 'job' | 'series') {
  return {
    businessId: at.businessId,
    clientRequestId,
    kind,
  } as Frozen as FunctionArgs<typeof api.clientRequests.find>
}

describe('outbox version 1: a one-off, as jobs.create takes it', () => {
  for (const [mode, payload] of Object.entries(ONE_OFF_V1)) {
    test(mode, async () => {
      const { owner, at } = await setup()
      const args = payload(at) as FunctionArgs<typeof api.jobs.create>

      const jobId = await owner.as.mutation(api.jobs.create, args)
      // Sent again, as a phone does when the answer never came.
      expect(await owner.as.mutation(api.jobs.create, args)).toBe(jobId)
      expect(
        await owner.as.query(
          api.clientRequests.find,
          findV1(at, args.clientRequestId, 'job'),
        ),
      ).toMatchObject({ kind: 'job', id: jobId })
    })
  }
})

describe('outbox version 1: a Recurring Job, as recurrences.create takes it', () => {
  for (const [mode, payload] of Object.entries(SERIES_V1)) {
    test(mode, async () => {
      const { owner, at } = await setup()
      const args = payload(at) as FunctionArgs<typeof api.recurrences.create>

      const recurrenceId = await owner.as.mutation(api.recurrences.create, args)
      expect(await owner.as.mutation(api.recurrences.create, args)).toBe(
        recurrenceId,
      )
      expect(
        await owner.as.query(
          api.clientRequests.find,
          findV1(at, args.clientRequestId, 'series'),
        ),
      ).toMatchObject({ kind: 'series', id: recurrenceId })
    })
  }
})

describe('and every one of them, sent again while sends from phones are paused', () => {
  test('is still answered with what it made: the lookup comes before the switch', async () => {
    const { owner, at } = await setup()
    const sends = [
      ...Object.values(ONE_OFF_V1).map(
        (payload) => () =>
          owner.as.mutation(
            api.jobs.create,
            payload(at) as FunctionArgs<typeof api.jobs.create>,
          ),
      ),
      ...Object.values(SERIES_V1).map(
        (payload) => () =>
          owner.as.mutation(
            api.recurrences.create,
            payload(at) as FunctionArgs<typeof api.recurrences.create>,
          ),
      ),
    ]
    const made: Array<string> = []
    for (const send of sends) made.push(await send())

    vi.stubEnv('OUTBOX_PAUSED', 'on')
    for (const [i, send] of sends.entries()) {
      expect(await send()).toBe(made[i])
    }
  })
})
