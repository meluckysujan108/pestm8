/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { dayKeyOf } from './lib/dates'
import { buildReportContext } from './lib/reportContext'
import { contactToCall } from './lib/siteContact'
import type { Doc, Id } from './_generated/dataModel'

/**
 * Prompt 6.1 and 6.3: what a business client carries beyond a name and a
 * number — its ABN, its contact person, a contact at each site — and a new
 * site booked for a client that already exists.
 *
 * The risks are all in the writes: a checksum-failing ABN that still leaves a
 * client behind, a cleared field stored as '' so it can never be taken off,
 * a contact person who replaces someone's real record, and a site number that
 * leaks into `clientPhone` where an older card dials it under the client's
 * name.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, owner)
  return { t, owner, businessId, ownerMembershipId }
}

type Setup = Awaited<ReturnType<typeof setup>>

const site = {
  addressLine: '88 Marine Parade',
  suburb: 'Cottesloe',
  state: 'WA',
  postcode: '6011',
}

/** Every row the client forms can write, to prove a refusal wrote none. */
function everything(s: Setup) {
  return s.t.run(async (ctx) => ({
    clients: await ctx.db.query('clients').collect(),
    properties: await ctx.db.query('properties').collect(),
    clientContacts: await ctx.db.query('clientContacts').collect(),
    jobs: await ctx.db.query('jobs').collect(),
  }))
}

async function insertClient(s: Setup, fields: Partial<Doc<'clients'>> = {}) {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId: s.businessId,
      kind: 'business',
      name: 'Coastal Cafe Group',
      phone: '08 9335 1000',
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId: s.businessId,
      clientId,
      ...site,
      createdAt: now,
    })
    return { clientId, propertyId }
  })
}

/** A second tenant with a client and a site of its own. */
async function rival(s: Setup) {
  const other = await createActor(s.t, { email: 'rival@other.test' })
  const { businessId } = await createBusiness(s.t, other, 'Other Pest')
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'business',
      name: 'Harbour Strata',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '1 Quay Road',
      suburb: 'Fremantle',
      state: 'WA',
      postcode: '6160',
      createdAt: now,
    })
    return { businessId, clientId, propertyId }
  })
}

function get<T extends 'clients' | 'properties' | 'jobs'>(s: Setup, id: Id<T>) {
  return s.t.run(async (ctx) => (await ctx.db.get(id))!)
}

function contactsOf(s: Setup, clientId: Id<'clients'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )
}

async function clientOfProperty(s: Setup, propertyId: Id<'properties'>) {
  const property = await get(s, propertyId)
  return get(s, property.clientId)
}

function booking(s: Setup) {
  return {
    businessId: s.businessId,
    assignedMembershipId: s.ownerMembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  }
}

describe('a new business client', () => {
  test('stores its ABN as digits, its contact person as the primary contact, and the site’s contact', async () => {
    const s = await setup()
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      kind: 'business',
      clientName: 'Coastal Cafe Group',
      phone: '08 9335 1000',
      abn: '51 824 753 556',
      contactPerson: ' Jan Morris ',
      ...site,
      siteContactName: ' Priya Shah ',
      siteContactPhone: ' 0400 111 222 ',
    })

    const property = await get(s, propertyId)
    expect(property.siteContactName).toBe('Priya Shah')
    expect(property.siteContactPhone).toBe('0400 111 222')

    const client = await get(s, property.clientId)
    expect(client.abn).toBe('51824753556')
    const contacts = await contactsOf(s, client._id)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({
      businessId: s.businessId,
      name: 'Jan Morris',
      isPrimary: true,
    })
  })

  test('blank details are left off, not stored as empty strings', async () => {
    const s = await setup()
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      kind: 'business',
      clientName: 'Coastal Cafe Group',
      abn: '   ',
      contactPerson: '  ',
      ...site,
      siteContactName: '',
      siteContactPhone: '   ',
    })

    const property = await get(s, propertyId)
    expect(property).not.toHaveProperty('siteContactName')
    expect(property).not.toHaveProperty('siteContactPhone')
    const client = await get(s, property.clientId)
    expect(client).not.toHaveProperty('abn')
    expect(await contactsOf(s, client._id)).toHaveLength(0)
  })

  test('an ABN that fails the checksum is refused, and nothing is written', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.properties.create, {
        businessId: s.businessId,
        kind: 'business',
        clientName: 'Coastal Cafe Group',
        abn: '51 824 753 557',
        contactPerson: 'Jan Morris',
        ...site,
        siteContactPhone: '0400 111 222',
      }),
    ).rejects.toThrow(/INVALID_ABN/)
    expect(await everything(s)).toEqual({
      clients: [],
      properties: [],
      clientContacts: [],
      jobs: [],
    })
  })
})

describe('a new person client', () => {
  test('has no ABN, contact person or site contact, whatever the form sent', async () => {
    const s = await setup()
    // Kind left out defaults to a person, as every older caller relies on.
    for (const kind of ['person', undefined] as const) {
      const propertyId = await s.owner.as.mutation(api.properties.create, {
        businessId: s.businessId,
        kind,
        clientName: 'J. Nguyen',
        phone: '0412 345 678',
        abn: '51 824 753 556',
        contactPerson: 'Jan Morris',
        ...site,
        siteContactName: 'Priya Shah',
        siteContactPhone: '0400 111 222',
      })
      const property = await get(s, propertyId)
      expect(property).not.toHaveProperty('siteContactName')
      expect(property).not.toHaveProperty('siteContactPhone')
      const client = await get(s, property.clientId)
      expect(client.kind).toBe('person')
      expect(client).not.toHaveProperty('abn')
      expect(await contactsOf(s, client._id)).toHaveLength(0)
    }
  })

  test('an ABN sent for one is ignored, not checked', async () => {
    const s = await setup()
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      kind: 'person',
      clientName: 'J. Nguyen',
      abn: '51 824 753 557',
      ...site,
    })
    expect(await clientOfProperty(s, propertyId)).not.toHaveProperty('abn')
  })
})

describe('booking a job for a new business client', () => {
  test('carries the ABN and contact person through', async () => {
    const s = await setup()
    const jobId = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s),
      newClient: {
        kind: 'business',
        clientName: 'Coastal Cafe Group',
        abn: '51-824-753-556',
        contactPerson: 'Jan Morris',
        ...site,
      },
    })
    const client = await clientOfProperty(s, (await get(s, jobId)).propertyId)
    expect(client.abn).toBe('51824753556')
    expect((await contactsOf(s, client._id)).map((c) => c.name)).toEqual([
      'Jan Morris',
    ])
  })

  test('with an invalid ABN books nothing and leaves no client, site or contact behind', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.jobs.create, {
        ...booking(s),
        newClient: {
          kind: 'business',
          clientName: 'Coastal Cafe Group',
          abn: '51 824 735 556',
          contactPerson: 'Jan Morris',
          ...site,
        },
      }),
    ).rejects.toThrow(/INVALID_ABN/)
    expect(await everything(s)).toEqual({
      clients: [],
      properties: [],
      clientContacts: [],
      jobs: [],
    })
  })
})

describe('changing a client’s ABN', () => {
  function update(
    s: Setup,
    clientId: Id<'clients'>,
    patch: { abn?: string; name?: string; contactPerson?: string },
  ) {
    return s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId,
      ...patch,
    })
  }

  test('sets it as digits', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s, { updatedAt: 0 })
    await update(s, clientId, { abn: '51-824-753-556' })
    const client = await get(s, clientId)
    expect(client.abn).toBe('51824753556')
    expect(client.updatedAt).toBeGreaterThan(0)
  })

  test('the same ABN typed differently writes nothing', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s, {
      abn: '51824753556',
      updatedAt: 0,
    })
    await update(s, clientId, { abn: '51 824 753 556' })
    const client = await get(s, clientId)
    expect(client.abn).toBe('51824753556')
    expect(client.updatedAt).toBe(0)
  })

  test.each(['', '   '])(
    'a blank one ("%s") clears it — the field is gone, not an empty string',
    async (blank) => {
      const s = await setup()
      const { clientId } = await insertClient(s, { abn: '51824753556' })
      await update(s, clientId, { abn: blank })
      expect(await get(s, clientId)).not.toHaveProperty('abn')
    },
  )

  test('leaving it out leaves it alone', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s, { abn: '51824753556' })
    await update(s, clientId, { name: 'Coastal Cafes' })
    const client = await get(s, clientId)
    expect(client.name).toBe('Coastal Cafes')
    expect(client.abn).toBe('51824753556')
  })

  test('an invalid one is refused, and nothing else in the same save is written', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s, { abn: '51824753556' })
    const before = await get(s, clientId)
    await expect(
      update(s, clientId, {
        abn: '51 824 753 557',
        name: 'Coastal Cafes',
        contactPerson: 'Jan Morris',
      }),
    ).rejects.toThrow(/INVALID_ABN/)
    expect(await get(s, clientId)).toEqual(before)
    expect(await contactsOf(s, clientId)).toHaveLength(0)
  })
})

describe('changing a client’s contact person', () => {
  async function addContact(
    s: Setup,
    clientId: Id<'clients'>,
    fields: Partial<Doc<'clientContacts'>> & { name: string },
  ) {
    return s.t.run((ctx) =>
      ctx.db.insert('clientContacts', {
        businessId: s.businessId,
        clientId,
        createdAt: Date.now(),
        ...fields,
      }),
    )
  }

  function setContactPerson(
    s: Setup,
    clientId: Id<'clients'>,
    contactPerson: string,
  ) {
    return s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId,
      contactPerson,
    })
  }

  const primaries = (contacts: Array<Doc<'clientContacts'>>) =>
    contacts.filter((c) => c.isPrimary).map((c) => c.name)

  test('with nobody listed, adds them as the primary contact', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    await setContactPerson(s, clientId, ' Jan Morris ')
    const contacts = await contactsOf(s, clientId)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ name: 'Jan Morris', isPrimary: true })
  })

  test('blank takes the star off, and keeps the contact', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    const jan = await addContact(s, clientId, {
      name: 'Jan Morris',
      isPrimary: true,
    })
    await setContactPerson(s, clientId, '   ')
    const contacts = await contactsOf(s, clientId)
    expect(contacts.map((c) => c._id)).toEqual([jan])
    expect(contacts[0].isPrimary).toBe(false)
  })

  test('the same name in a different case corrects it in place', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    const jan = await addContact(s, clientId, {
      name: 'jan morris',
      role: 'Store manager',
      isPrimary: true,
    })
    await setContactPerson(s, clientId, 'Jan Morris')
    const contacts = await contactsOf(s, clientId)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({
      _id: jan,
      name: 'Jan Morris',
      role: 'Store manager',
      isPrimary: true,
    })
  })

  test('a name already in the list takes the star from whoever had it', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    await addContact(s, clientId, {
      name: 'Jan Morris',
      role: 'Owner',
      isPrimary: true,
    })
    const priya = await addContact(s, clientId, {
      name: 'Priya Shah',
      email: 'accounts@cafe.test',
    })
    await setContactPerson(s, clientId, ' priya shah ')
    const contacts = await contactsOf(s, clientId)
    expect(contacts).toHaveLength(2)
    expect(primaries(contacts)).toEqual(['Priya Shah'])
    // The star moves; the record it lands on is not rewritten.
    expect(contacts.find((c) => c._id === priya)).toMatchObject({
      name: 'Priya Shah',
      email: 'accounts@cafe.test',
    })
  })

  test('a primary who is only a name is renamed in place — fixing "Jhon"', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    const jhon = await addContact(s, clientId, {
      name: 'Jhon',
      isPrimary: true,
    })
    await setContactPerson(s, clientId, 'John')
    const contacts = await contactsOf(s, clientId)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({
      _id: jhon,
      name: 'John',
      isPrimary: true,
    })
  })

  test.each([
    ['a role', { role: 'Store manager' }],
    ['a number', { phone: '0400 111 222' }],
    ['an email', { email: 'jan@cafe.test' }],
  ])(
    'a primary with %s keeps its row; a new contact takes the star',
    async (_, details) => {
      const s = await setup()
      const { clientId } = await insertClient(s)
      const jan = await addContact(s, clientId, {
        name: 'Jan Morris',
        isPrimary: true,
        ...details,
      })
      await setContactPerson(s, clientId, 'Priya Shah')
      const contacts = await contactsOf(s, clientId)
      expect(contacts).toHaveLength(2)
      expect(contacts.find((c) => c._id === jan)).toMatchObject({
        name: 'Jan Morris',
        isPrimary: false,
        ...details,
      })
      expect(contacts.find((c) => c._id !== jan)).toMatchObject({
        businessId: s.businessId,
        clientId,
        name: 'Priya Shah',
        isPrimary: true,
      })
    },
  )

  test('with contacts but no primary, a new name is added as the primary', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    await addContact(s, clientId, { name: 'Sam Lee', role: 'Accounts' })
    await setContactPerson(s, clientId, 'Jan Morris')
    const contacts = await contactsOf(s, clientId)
    expect(contacts).toHaveLength(2)
    expect(primaries(contacts)).toEqual(['Jan Morris'])
  })

  test.each([
    ['renames the bare one', 'John', ['John']],
    ['keeps the same one', 'Jhon', ['Jhon']],
    ['moves to a new one', 'Priya Shah', ['Priya Shah']],
    ['clears both', '', []],
  ])(
    'rows drifted to two primaries come out with one: %s',
    async (_, name, expected) => {
      const s = await setup()
      const { clientId } = await insertClient(s)
      await addContact(s, clientId, { name: 'Jhon', isPrimary: true })
      await addContact(s, clientId, {
        name: 'Jan Morris',
        role: 'Owner',
        isPrimary: true,
      })
      await setContactPerson(s, clientId, name)
      expect(primaries(await contactsOf(s, clientId))).toEqual(expected)
    },
  )

  test('never deletes anyone, and never leaves two primaries', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    await addContact(s, clientId, {
      name: 'Jan Morris',
      role: 'Owner',
      isPrimary: true,
    })
    await addContact(s, clientId, { name: 'Sam Lee' })

    let seen = new Set((await contactsOf(s, clientId)).map((c) => c._id))
    for (const name of [
      'Priya Shah',
      '',
      'sam lee',
      'Sammy Lee',
      'Jan Morris',
      '',
    ]) {
      await setContactPerson(s, clientId, name)
      const contacts = await contactsOf(s, clientId)
      const now = new Set(contacts.map((c) => c._id))
      for (const id of seen) expect(now.has(id), `after "${name}"`).toBe(true)
      expect(primaries(contacts).length).toBeLessThanOrEqual(1)
      seen = now
    }
    expect((await contactsOf(s, clientId)).map((c) => c.name).sort()).toEqual([
      'Jan Morris',
      'Priya Shah',
      'Sammy Lee',
    ])
  })
})

describe('a site’s contact', () => {
  test('is stored trimmed when another property is added to a client', async () => {
    const s = await setup()
    const { clientId } = await insertClient(s)
    const propertyId = await s.owner.as.mutation(
      api.properties.createForClient,
      {
        businessId: s.businessId,
        clientId,
        addressLine: '5 Bay View Terrace',
        suburb: 'Claremont',
        state: 'WA',
        postcode: '6010',
        siteContactName: ' Jan Morris ',
        siteContactPhone: ' 0400 111 222 ',
      },
    )
    expect(await get(s, propertyId)).toMatchObject({
      clientId,
      siteContactName: 'Jan Morris',
      siteContactPhone: '0400 111 222',
    })
  })

  test('is set, left alone when not sent, and cleared by a blank', async () => {
    const s = await setup()
    const { propertyId } = await insertClient(s)
    const update = (patch: {
      addressLine?: string
      siteContactName?: string
      siteContactPhone?: string
    }) =>
      s.owner.as.mutation(api.properties.update, {
        businessId: s.businessId,
        propertyId,
        ...patch,
      })

    await update({
      siteContactName: 'Jan Morris',
      siteContactPhone: '0400 111 222',
    })
    expect(await get(s, propertyId)).toMatchObject({
      siteContactName: 'Jan Morris',
      siteContactPhone: '0400 111 222',
    })

    await update({ addressLine: '90 Marine Parade' })
    expect(await get(s, propertyId)).toMatchObject({
      addressLine: '90 Marine Parade',
      siteContactName: 'Jan Morris',
      siteContactPhone: '0400 111 222',
    })

    await update({ siteContactName: '' })
    let property = await get(s, propertyId)
    expect(property).not.toHaveProperty('siteContactName')
    expect(property.siteContactPhone).toBe('0400 111 222')

    await update({ siteContactPhone: '   ' })
    property = await get(s, propertyId)
    expect(property).not.toHaveProperty('siteContactPhone')
  })

  test('cannot be written onto another business’s client or site', async () => {
    const s = await setup()
    const theirs = await rival(s)
    const before = await get(s, theirs.propertyId)

    await expect(
      s.owner.as.mutation(api.properties.createForClient, {
        businessId: s.businessId,
        clientId: theirs.clientId,
        ...site,
        siteContactPhone: '0400 111 222',
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      s.owner.as.mutation(api.properties.update, {
        businessId: s.businessId,
        propertyId: theirs.propertyId,
        siteContactPhone: '0400 111 222',
      }),
    ).rejects.toThrow(/NOT_FOUND/)

    expect(await get(s, theirs.propertyId)).toEqual(before)
    expect((await everything(s)).properties).toHaveLength(1)
  })
})

describe('booking a job at a new site for an existing client', () => {
  const newSite = {
    addressLine: '5 Bay View Terrace',
    suburb: 'Claremont',
    state: 'WA',
    postcode: '6010',
  }

  test('adds the site under that client and books the job there', async () => {
    const s = await setup()
    const { clientId, propertyId: existing } = await insertClient(s)
    const jobId = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s),
      newProperty: {
        clientId,
        ...newSite,
        siteContactName: ' Jan Morris ',
        siteContactPhone: ' 0400 111 222 ',
      },
    })

    const job = await get(s, jobId)
    expect(job.propertyId).not.toBe(existing)
    expect(await get(s, job.propertyId)).toMatchObject({
      businessId: s.businessId,
      clientId,
      ...newSite,
      siteContactName: 'Jan Morris',
      siteContactPhone: '0400 111 222',
    })
    // The same client, not a second record of it.
    const { clients, properties } = await everything(s)
    expect(clients).toHaveLength(1)
    expect(properties).toHaveLength(2)
  })

  test('for another business’s client is NOT_FOUND, and makes no site or job', async () => {
    const s = await setup()
    const theirs = await rival(s)
    await expect(
      s.owner.as.mutation(api.jobs.create, {
        ...booking(s),
        newProperty: { clientId: theirs.clientId, ...newSite },
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    const { properties, jobs } = await everything(s)
    expect(properties.map((p) => p._id)).toEqual([theirs.propertyId])
    expect(jobs).toHaveLength(0)
  })

  test('works for a Recurring Job too, every visit at the new site', async () => {
    const s = await setup()
    const { clientId, propertyId: existing } = await insertClient(s)
    const recurrenceId = await s.owner.as.mutation(api.recurrences.create, {
      businessId: s.businessId,
      newProperty: { clientId, ...newSite },
      assignedMembershipId: s.ownerMembershipId,
      intervalCount: 1,
      intervalUnit: 'month',
      jobType: 'General Pest Control',
      price: 20000,
      anchorDate: Date.now() + DAY,
      durationMinutes: 60,
    })

    const [series, visits] = await s.t.run(async (ctx) => [
      (await ctx.db.get(recurrenceId))!,
      await ctx.db
        .query('jobs')
        .withIndex('by_recurrence', (q) => q.eq('recurrenceId', recurrenceId))
        .collect(),
    ])
    expect(series.propertyId).not.toBe(existing)
    expect(await get(s, series.propertyId)).toMatchObject({
      clientId,
      ...newSite,
    })
    expect(visits.length).toBeGreaterThan(0)
    for (const visit of visits) expect(visit.propertyId).toBe(series.propertyId)
  })
})

describe('what a job row carries for the card’s Call', () => {
  async function bookAt(s: Setup, propertyId: Id<'properties'>) {
    const at = Date.now() + DAY
    await s.owner.as.mutation(api.jobs.create, {
      ...booking(s),
      propertyId,
      scheduledAt: at,
    })
    return at
  }

  test('the site contact rides beside the client’s own number, never in place of it', async () => {
    const s = await setup()
    const { propertyId } = await insertClient(s)
    await s.t.run((ctx) =>
      ctx.db.patch(propertyId, {
        siteContactName: 'Jan Morris',
        siteContactPhone: '0400 111 222',
      }),
    )
    const at = await bookAt(s, propertyId)

    const { jobs } = await s.owner.as.query(api.jobs.list, {
      businessId: s.businessId,
    })
    const expected = {
      clientName: 'Coastal Cafe Group',
      clientKind: 'business',
      // Still the client's line: an older card dials this under the
      // client's name.
      clientPhone: '08 9335 1000',
      siteContactName: 'Jan Morris',
      siteContactPhone: '0400 111 222',
    }
    expect(jobs[0]).toMatchObject(expected)
    expect(contactToCall(jobs[0])).toEqual({
      name: 'Jan Morris',
      phone: '0400 111 222',
      atSite: true,
    })

    const timezone = await s.t.run(
      async (ctx) => (await ctx.db.get(s.businessId))!.timezone,
    )
    const day = await s.owner.as.query(api.jobs.listDay, {
      businessId: s.businessId,
      dayKey: dayKeyOf(at, timezone),
    })
    expect(day[0]).toMatchObject(expected)
  })

  test('a site with no contact gives empty ones, and a person client says so', async () => {
    const s = await setup()
    const { propertyId } = await insertClient(s, {
      kind: 'person',
      name: 'J. Nguyen',
      phone: '0412 345 678',
    })
    await bookAt(s, propertyId)

    const { jobs } = await s.owner.as.query(api.jobs.list, {
      businessId: s.businessId,
    })
    expect(jobs[0]).toMatchObject({
      clientKind: 'person',
      clientPhone: '0412 345 678',
      siteContactName: '',
      siteContactPhone: '',
    })
  })
})

describe('a business client’s head-office address on a report', () => {
  async function printedAddress(
    s: Setup,
    head: Pick<
      Partial<Doc<'clients'>>,
      'addressLine' | 'suburb' | 'state' | 'postcode'
    >,
  ) {
    const { propertyId } = await insertClient(s, head)
    const client = await s.t.run(async (ctx) => {
      const reportId = await ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId,
        authorMembershipId: s.ownerMembershipId,
        template: 'treatmentRecord',
        templateVersion: 1,
        legalBasis: 'AS 3660.2-2017',
        status: 'draft',
        data: {},
        photoIds: [],
        createdAt: Date.now(),
      })
      const report = (await ctx.db.get(reportId))!
      const { snapshot } = await buildReportContext(ctx, report, {})
      return snapshot.client
    })
    // The client is printed either way; only its address is in question.
    expect(client?.name).toBe('Coastal Cafe Group')
    return client!.address
  }

  test.each([
    [{ state: 'ACT' }],
    [{ state: 'ACT', postcode: '2600' }],
    [{ addressLine: '  ', state: 'WA' }],
  ])('%o on its own is no address, and prints none', async (head) => {
    const s = await setup()
    expect(await printedAddress(s, head)).toBeUndefined()
  })

  test('with a street or a suburb, prints in full', async () => {
    const s = await setup()
    expect(
      await printedAddress(s, {
        addressLine: 'Level 2, 10 Hay Street',
        suburb: 'Perth',
        state: 'WA',
        postcode: '6000',
      }),
    ).toBe('Level 2, 10 Hay Street Perth WA 6000')
    expect(await printedAddress(s, { suburb: 'Perth', state: 'WA' })).toBe(
      'Perth WA',
    )
  })
})
