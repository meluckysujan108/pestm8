/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { validateReport } from '../src/lib/reportTemplates/validate'
import type { Doc, Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Field verification, the server's half: the hard rules every form's email,
 * phone and ABN meet, whichever screen (or older build of one) sent them.
 *
 * The risks are in what the rules must NOT do as much as what they must. A
 * record saved before them, with a number or address they would now refuse,
 * has to stay editable — the edit forms send every field back on every save —
 * so only a value this call changes is checked. An address the server
 * deliberately does not police (the demo seeds '6O53' and 'Joondalop') must
 * still save. And a typo already on file must not count as a "known"
 * recipient that skips the owner's approval.
 */

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
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

/** Every row the client and property forms can write. */
function everything(s: Setup) {
  return s.t.run(async (ctx) => ({
    clients: await ctx.db.query('clients').collect(),
    properties: await ctx.db.query('properties').collect(),
    clientContacts: await ctx.db.query('clientContacts').collect(),
    jobs: await ctx.db.query('jobs').collect(),
    recurrences: await ctx.db.query('recurrences').collect(),
  }))
}

const nothing = {
  clients: [],
  properties: [],
  clientContacts: [],
  jobs: [],
  recurrences: [],
}

function get<T extends 'clients' | 'properties' | 'clientContacts' | 'jobs'>(
  s: Setup,
  id: Id<T>,
) {
  return s.t.run(async (ctx) => (await ctx.db.get(id))!)
}

/** A client (and a site) as an older build, or the seed, left it: written
 * straight to the table, so whatever it holds was never checked. */
async function legacyClient(s: Setup, fields: Partial<Doc<'clients'>> = {}) {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId: s.businessId,
      kind: 'business',
      name: 'Coastal Cafe Group',
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

async function legacyContact(
  s: Setup,
  clientId: Id<'clients'>,
  fields: Partial<Doc<'clientContacts'>> = {},
) {
  return s.t.run((ctx) =>
    ctx.db.insert('clientContacts', {
      businessId: s.businessId,
      clientId,
      name: 'Jan Morris',
      createdAt: Date.now(),
      ...fields,
    }),
  )
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

function series(s: Setup) {
  return {
    businessId: s.businessId,
    assignedMembershipId: s.ownerMembershipId,
    intervalCount: 1,
    intervalUnit: 'month' as const,
    jobType: 'General Pest Control',
    price: 20000,
    anchorDate: Date.now() + DAY,
    durationMinutes: 60,
  }
}

describe('a client contact', () => {
  test('is refused an email that can never be delivered to, or a number that can never be dialled', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s)
    for (const [fields, code] of [
      [{ email: 'jan@gmail' }, /INVALID_EMAIL/],
      [{ email: 'jan morris@gmail.com' }, /INVALID_EMAIL/],
      [{ phone: '1234' }, /INVALID_PHONE/],
    ] as const) {
      await expect(
        s.owner.as.mutation(api.clientContacts.create, {
          businessId: s.businessId,
          clientId,
          name: 'Jan Morris',
          ...fields,
        }),
      ).rejects.toThrow(code)
    }
    expect((await everything(s)).clientContacts).toEqual([])
  })

  test('is stored trimmed, with the email’s domain lower-cased and blanks left off', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s)
    const contactId = await s.owner.as.mutation(api.clientContacts.create, {
      businessId: s.businessId,
      clientId,
      name: 'Jan Morris',
      email: ' Jan.Morris@Coastal.TEST ',
      phone: ' 0412 345 678 ',
    })
    const contact = await get(s, contactId)
    expect(contact.email).toBe('Jan.Morris@coastal.test')
    expect(contact.phone).toBe('0412 345 678')

    const blank = await get(
      s,
      await s.owner.as.mutation(api.clientContacts.create, {
        businessId: s.businessId,
        clientId,
        name: 'Priya Shah',
        email: '  ',
        phone: '',
      }),
    )
    expect(blank).not.toHaveProperty('email')
    expect(blank).not.toHaveProperty('phone')
  })

  test('has its role, phone and email cleared by a blank, and left alone when they are left out', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s)
    const contactId = await legacyContact(s, clientId, {
      role: 'Store manager',
      phone: '0412 345 678',
      email: 'jan@coastal.test',
    })

    // Left out: an older screen's save touches nothing it did not send.
    await s.owner.as.mutation(api.clientContacts.update, {
      businessId: s.businessId,
      contactId,
      name: 'Jan Morris-Lee',
    })
    expect(await get(s, contactId)).toMatchObject({
      name: 'Jan Morris-Lee',
      role: 'Store manager',
      phone: '0412 345 678',
      email: 'jan@coastal.test',
    })

    await s.owner.as.mutation(api.clientContacts.update, {
      businessId: s.businessId,
      contactId,
      role: '',
      phone: '  ',
      email: '',
    })
    const cleared = await get(s, contactId)
    expect(cleared.name).toBe('Jan Morris-Lee')
    expect(cleared).not.toHaveProperty('role')
    expect(cleared).not.toHaveProperty('phone')
    expect(cleared).not.toHaveProperty('email')
  })

  test('saved before the rules stays editable: an unchanged email or number is not checked again', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s)
    const contactId = await legacyContact(s, clientId, {
      phone: '1234',
      email: 'jan@gmail',
    })

    // The edit form sends every field back, the old ones included.
    await s.owner.as.mutation(api.clientContacts.update, {
      businessId: s.businessId,
      contactId,
      name: 'Jan Morris-Lee',
      role: 'Owner',
      phone: '1234',
      email: ' jan@gmail ',
    })
    expect(await get(s, contactId)).toMatchObject({
      name: 'Jan Morris-Lee',
      role: 'Owner',
    })

    // Changing either is a new value, and meets the rule.
    await expect(
      s.owner.as.mutation(api.clientContacts.update, {
        businessId: s.businessId,
        contactId,
        email: 'jan@hotmail',
      }),
    ).rejects.toThrow(/INVALID_EMAIL/)
    await expect(
      s.owner.as.mutation(api.clientContacts.update, {
        businessId: s.businessId,
        contactId,
        name: 'Refused, so not saved',
        phone: '12345',
      }),
    ).rejects.toThrow(/INVALID_PHONE/)
    expect((await get(s, contactId)).name).toBe('Jan Morris-Lee')

    await s.owner.as.mutation(api.clientContacts.update, {
      businessId: s.businessId,
      contactId,
      email: 'Jan@Gmail.com',
      phone: '0412 345 678',
    })
    expect(await get(s, contactId)).toMatchObject({
      email: 'Jan@gmail.com',
      phone: '0412 345 678',
    })
  })
})

describe('editing a client', () => {
  test('refuses a new email or number that can never work, and writes nothing — the contact person included', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s, {
      email: 'accounts@cafe.test',
      phone: '08 9335 1000',
    })
    const before = await everything(s)

    for (const [fields, code] of [
      [{ email: 'accounts@cafe' }, /INVALID_EMAIL/],
      [{ phone: '9335' }, /INVALID_PHONE/],
    ] as const) {
      await expect(
        s.owner.as.mutation(api.clients.update, {
          businessId: s.businessId,
          clientId,
          name: 'Renamed',
          contactPerson: 'Jan Morris',
          ...fields,
        }),
      ).rejects.toThrow(code)
    }
    expect(await everything(s)).toEqual(before)
  })

  test('saved before the rules stays editable with its old details sent back unchanged', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s, {
      email: 'accounts@cafe',
      phone: '9335',
    })
    await s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId,
      name: 'Coastal Cafe Group Pty Ltd',
      email: 'accounts@cafe',
      phone: '9335',
    })
    expect(await get(s, clientId)).toMatchObject({
      name: 'Coastal Cafe Group Pty Ltd',
      email: 'accounts@cafe',
      phone: '9335',
    })
  })

  test('stores a new email the one way, and a blank still clears it', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s, { email: 'accounts@cafe' })
    await s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId,
      email: ' Accounts@Cafe.TEST ',
    })
    expect((await get(s, clientId)).email).toBe('Accounts@cafe.test')

    await s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId,
      email: '',
      phone: ' ',
    })
    const cleared = await get(s, clientId)
    expect(cleared).not.toHaveProperty('email')
    expect(cleared).not.toHaveProperty('phone')
  })
})

describe('a new client, however it is created', () => {
  test('from the Clients page: a bad email or number refuses the whole submit', async () => {
    const s = await setup()
    for (const [fields, code] of [
      [{ email: 'jn@gmail' }, /INVALID_EMAIL/],
      [{ phone: '0412' }, /INVALID_PHONE/],
      [
        { kind: 'business', siteContactPhone: '0400 1' } as const,
        /INVALID_PHONE/,
      ],
    ] as const) {
      await expect(
        s.owner.as.mutation(api.properties.create, {
          businessId: s.businessId,
          clientName: 'J. Nguyen',
          ...site,
          ...fields,
        }),
      ).rejects.toThrow(code)
    }
    expect(await everything(s)).toEqual(nothing)
  })

  test('while booking a job or a series: nothing is booked, and no client is left behind', async () => {
    const s = await setup()
    await expect(
      s.owner.as.mutation(api.jobs.create, {
        ...booking(s),
        newClient: { clientName: 'J. Nguyen', email: 'jn@gmail', ...site },
      }),
    ).rejects.toThrow(/INVALID_EMAIL/)
    await expect(
      s.owner.as.mutation(api.recurrences.create, {
        ...series(s),
        newClient: { clientName: 'J. Nguyen', phone: '12', ...site },
      }),
    ).rejects.toThrow(/INVALID_PHONE/)
    expect(await everything(s)).toEqual(nothing)
  })

  test('is stored trimmed, the email’s domain lower-cased, blanks left off', async () => {
    const s = await setup()
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'J. Nguyen',
      email: ' JN@Example.COM ',
      phone: ' 0412 345 678 ',
      ...site,
    })
    const client = await get(s, (await get(s, propertyId)).clientId)
    expect(client.email).toBe('JN@example.com')
    expect(client.phone).toBe('0412 345 678')

    const bare = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'K. Petrov',
      email: '',
      phone: '  ',
      ...site,
    })
    const bareClient = await get(s, (await get(s, bare)).clientId)
    expect(bareClient).not.toHaveProperty('email')
    expect(bareClient).not.toHaveProperty('phone')
  })

  test('with an odd address still saves: the server does not police addresses', async () => {
    const s = await setup()
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'J. Nguyen',
      addressLine: '7 Hakea Court',
      suburb: 'Joondalop',
      state: 'QLD',
      postcode: '6O53',
    })
    expect(await get(s, propertyId)).toMatchObject({
      suburb: 'Joondalop',
      state: 'QLD',
      postcode: '6O53',
    })
  })
})

describe('a site contact’s number', () => {
  test('is refused when new and undiallable, from the client sheet and the booking sheet alike', async () => {
    const s = await setup()
    const { clientId } = await legacyClient(s)
    const before = await everything(s)
    await expect(
      s.owner.as.mutation(api.properties.createForClient, {
        businessId: s.businessId,
        clientId,
        ...site,
        siteContactPhone: '040',
      }),
    ).rejects.toThrow(/INVALID_PHONE/)
    await expect(
      s.owner.as.mutation(api.jobs.create, {
        ...booking(s),
        newProperty: { clientId, ...site, siteContactPhone: '040' },
      }),
    ).rejects.toThrow(/INVALID_PHONE/)
    expect(await everything(s)).toEqual(before)
  })

  test('saved before the rule stays editable; a changed one meets it; a blank clears it', async () => {
    const s = await setup()
    const { propertyId } = await legacyClient(s)
    await s.t.run((ctx) =>
      ctx.db.patch(propertyId, {
        siteContactName: 'Priya',
        siteContactPhone: '5550',
      }),
    )

    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId,
      addressLine: '90 Marine Parade',
      siteContactName: 'Priya Shah',
      siteContactPhone: '5550',
    })
    expect(await get(s, propertyId)).toMatchObject({
      addressLine: '90 Marine Parade',
      siteContactName: 'Priya Shah',
      siteContactPhone: '5550',
    })

    await expect(
      s.owner.as.mutation(api.properties.update, {
        businessId: s.businessId,
        propertyId,
        addressLine: 'Refused, so not saved',
        siteContactPhone: '5551',
      }),
    ).rejects.toThrow(/INVALID_PHONE/)
    expect((await get(s, propertyId)).addressLine).toBe('90 Marine Parade')

    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId,
      siteContactPhone: ' 0400 222 333 ',
    })
    expect((await get(s, propertyId)).siteContactPhone).toBe('0400 222 333')

    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId,
      siteContactPhone: '',
    })
    expect(await get(s, propertyId)).not.toHaveProperty('siteContactPhone')
  })
})

describe('how an address was entered', () => {
  test('is stored, with when, by every way a property is created', async () => {
    const s = await setup()
    const start = Date.now()

    const fromClientsPage = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'J. Nguyen',
      ...site,
      addressCheck: 'picked',
    })
    const clientId = (await get(s, fromClientsPage)).clientId
    const fromClientSheet = await s.owner.as.mutation(
      api.properties.createForClient,
      { businessId: s.businessId, clientId, ...site, addressCheck: 'typed' },
    )
    const jobForNewSite = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s),
      newProperty: { clientId, ...site, addressCheck: 'picked' },
    })
    const jobForNewClient = await s.owner.as.mutation(api.jobs.create, {
      ...booking(s),
      newClient: {
        kind: 'business',
        clientName: 'Coastal Cafe Group',
        ...site,
        addressCheck: 'typed',
      },
    })
    const seriesForNewClient = await s.owner.as.mutation(
      api.recurrences.create,
      {
        ...series(s),
        newClient: { clientName: 'K. Petrov', ...site, addressCheck: 'picked' },
      },
    )

    const propertyOf = async (
      id: Id<'properties'> | Id<'jobs'> | Id<'recurrences'>,
    ) =>
      s.t.run(async (ctx) => {
        const row = (await ctx.db.get(id))!
        return (await ctx.db.get(
          'propertyId' in row ? row.propertyId : (id as Id<'properties'>),
        ))!
      })

    const expected: Array<[Doc<'properties'>, 'picked' | 'typed']> = [
      [await propertyOf(fromClientsPage), 'picked'],
      [await propertyOf(fromClientSheet), 'typed'],
      [await propertyOf(jobForNewSite), 'picked'],
      [await propertyOf(jobForNewClient), 'typed'],
      [await propertyOf(seriesForNewClient), 'picked'],
    ]
    for (const [property, check] of expected) {
      expect(property.addressCheck).toBe(check)
      expect(property.addressCheckedAt).toBeGreaterThanOrEqual(start)
    }
  })

  test('is absent when an older screen does not say, and an edit that does not say leaves it alone', async () => {
    const s = await setup()
    const propertyId = await s.owner.as.mutation(api.properties.create, {
      businessId: s.businessId,
      clientName: 'J. Nguyen',
      ...site,
    })
    const created = await get(s, propertyId)
    expect(created).not.toHaveProperty('addressCheck')
    expect(created).not.toHaveProperty('addressCheckedAt')

    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId,
      suburb: 'North Cottesloe',
      addressCheck: 'typed',
    })
    const typed = await get(s, propertyId)
    expect(typed.addressCheck).toBe('typed')
    const typedAt = typed.addressCheckedAt!
    expect(typedAt).toBeGreaterThan(0)

    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId,
      postcode: '6011',
    })
    expect(await get(s, propertyId)).toMatchObject({
      addressCheck: 'typed',
      addressCheckedAt: typedAt,
    })

    // Re-picked from the suggestions, with nothing else changed.
    await s.owner.as.mutation(api.properties.update, {
      businessId: s.businessId,
      propertyId,
      addressCheck: 'picked',
    })
    const picked = await get(s, propertyId)
    expect(picked.addressCheck).toBe('picked')
    expect(picked.addressCheckedAt).toBeGreaterThanOrEqual(typedAt)
  })
})

describe('the business’s own details', () => {
  test('a new email, copy address or number that can never work is refused, and nothing is saved', async () => {
    const s = await setup()
    for (const [fields, code] of [
      [{ email: 'office@coastal' }, /INVALID_EMAIL/],
      [{ reportCopyEmail: 'reports @coastal.test' }, /INVALID_EMAIL/],
      [{ phone: '9271' }, /INVALID_PHONE/],
    ] as const) {
      await expect(
        s.owner.as.mutation(api.businesses.update, {
          businessId: s.businessId,
          name: 'Refused, so not saved',
          ...fields,
        }),
      ).rejects.toThrow(code)
    }
    const business = await s.t.run(async (ctx) => ctx.db.get(s.businessId))
    expect(business?.name).toBe('Coastal Pest')
  })

  test('an ABN is checked only when it changes: the seed’s, sent back as it was, still saves', async () => {
    const s = await setup()
    // Fails the ATO's check, as scripts/seed.mjs's does.
    await s.t.run((ctx) =>
      ctx.db.patch(s.businessId, {
        abn: '54 123 456 789',
        email: 'office@coastal',
        phone: '9271',
      }),
    )

    // What the settings forms send: every field, the old ones included, and
    // spacing is not a change.
    await s.owner.as.mutation(api.businesses.update, {
      businessId: s.businessId,
      name: 'Coastal Pest Control',
      abn: '54123456789',
      email: 'office@coastal',
      phone: '9271',
    })
    const business = await s.t.run(async (ctx) => ctx.db.get(s.businessId))
    expect(business).toMatchObject({
      name: 'Coastal Pest Control',
      email: 'office@coastal',
      phone: '9271',
    })

    await expect(
      s.owner.as.mutation(api.businesses.update, {
        businessId: s.businessId,
        abn: '51 824 753 557',
      }),
    ).rejects.toThrow(/INVALID_ABN/)

    // A real one is stored as the ATO prints it, since it is printed as
    // stored on every report.
    await s.owner.as.mutation(api.businesses.update, {
      businessId: s.businessId,
      abn: '51824753556',
      email: 'Office@Coastal.TEST',
    })
    const fixed = await s.t.run(async (ctx) => ctx.db.get(s.businessId))
    expect(fixed?.abn).toBe('51 824 753 556')
    expect(fixed?.email).toBe('Office@coastal.test')

    await s.owner.as.mutation(api.businesses.update, {
      businessId: s.businessId,
      abn: '',
    })
    expect(
      await s.t.run(async (ctx) => ctx.db.get(s.businessId)),
    ).not.toHaveProperty('abn')
  })

  test('a new business’s ABN is checked, and stored as the ATO prints it', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'jo@jospest.test' })
    await expect(
      owner.as.mutation(api.businesses.create, {
        name: 'Jo’s Pest',
        state: 'WA',
        timezone: 'Australia/Perth',
        abn: '54 123 456 789',
      }),
    ).rejects.toThrow(/INVALID_ABN/)
    expect(await t.run((ctx) => ctx.db.query('businesses').collect())).toEqual(
      [],
    )

    const { businessId } = await owner.as.mutation(api.businesses.create, {
      name: 'Jo’s Pest',
      state: 'WA',
      timezone: 'Australia/Perth',
      abn: '51-824-753-556',
    })
    const other = await owner.as.mutation(api.businesses.create, {
      name: 'Jo’s Other Pest',
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const [withAbn, without] = await t.run(async (ctx) => [
      await ctx.db.get(businessId),
      await ctx.db.get(other.businessId),
    ])
    expect(withAbn?.abn).toBe('51 824 753 556')
    expect(without).not.toHaveProperty('abn')
  })
})

describe('a member’s own number', () => {
  test('is refused when new and undiallable, kept when sent back unchanged, and cleared when left out', async () => {
    const s = await setup()
    const args = {
      businessId: s.businessId,
      membershipId: s.ownerMembershipId,
    }
    const phone = () =>
      s.t.run(async (ctx) => (await ctx.db.get(s.ownerMembershipId))!.phone)

    await expect(
      s.owner.as.mutation(api.memberships.setProfile, { ...args, phone: '04' }),
    ).rejects.toThrow(/INVALID_PHONE/)

    await s.owner.as.mutation(api.memberships.setProfile, {
      ...args,
      phone: ' 0412 345 678 ',
    })
    expect(await phone()).toBe('0412 345 678')

    await s.t.run((ctx) => ctx.db.patch(s.ownerMembershipId, { phone: '123' }))
    await s.owner.as.mutation(api.memberships.setProfile, {
      ...args,
      phone: '123',
    })
    expect(await phone()).toBe('123')

    await s.owner.as.mutation(api.memberships.setProfile, args)
    const cleared = await s.t.run(async (ctx) =>
      ctx.db.get(s.ownerMembershipId),
    )
    expect(cleared).not.toHaveProperty('phone')
  })
})

describe('an invitation’s email', () => {
  async function invite(
    owner: TestActor,
    businessId: Id<'businesses'>,
    email: string,
  ) {
    return owner.as.action(api.invitations.create, {
      businessId,
      email,
      role: 'subcontractor',
    })
  }

  test('is lower-cased whole, as before, so the account that redeems it matches', async () => {
    const s = await setup()
    await invite(s.owner, s.businessId, ' Kevin@KevinsPest.TEST ')
    const rows = await s.t.run((ctx) => ctx.db.query('invitations').collect())
    expect(rows.map((row) => row.email)).toEqual(['kevin@kevinspest.test'])
  })

  test('is refused, with the same code as before, when it can never be delivered to', async () => {
    const s = await setup()
    for (const email of [
      'kevin',
      'kevin@kevinspest',
      'kevin@@kevinspest.test',
      // Let through by the old, looser pattern.
      'kevin@kevinspest..test',
      'kevin@kevinspest.t',
    ]) {
      await expect(invite(s.owner, s.businessId, email)).rejects.toThrow(
        /INVALID_EMAIL/,
      )
    }
    expect(
      await s.t.run((ctx) => ctx.db.query('invitations').collect()),
    ).toEqual([])
  })

  test('from the CLI stand-in follows the same rule', async () => {
    const s = await setup()
    const store = (email: string) =>
      s.t.mutation(internal.adminInvite.store, {
        businessId: s.businessId,
        email,
        role: 'subcontractor',
        actorMembershipId: s.ownerMembershipId,
        tokenHash: `hash-${email}`,
      })
    await expect(store('kevin@kevinspest..test')).rejects.toThrow(
      /INVALID_EMAIL/,
    )
    await store(' Kevin@KevinsPest.TEST ')
    const rows = await s.t.run((ctx) => ctx.db.query('invitations').collect())
    expect(rows.map((row) => row.email)).toEqual(['kevin@kevinspest.test'])
  })
})

describe('sending a report', () => {
  async function withReport(
    s: Setup,
    client: Partial<Doc<'clients'>>,
    contacts: Array<Partial<Doc<'clientContacts'>>> = [],
  ) {
    const { clientId, propertyId } = await legacyClient(s, client)
    for (const contact of contacts) await legacyContact(s, clientId, contact)
    const reportId = await s.t.run((ctx) =>
      ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId,
        authorMembershipId: s.ownerMembershipId,
        template: 'serviceReport',
        templateVersion: getTemplate('serviceReport').version,
        legalBasis: 'APVMA · AEPMA',
        status: 'finalised',
        data: {},
        photoIds: [],
        finalisedAt: Date.now(),
        createdAt: Date.now(),
      }),
    )
    return reportId
  }

  test('a typo already on file is not a known recipient, so it cannot skip the owner’s approval', async () => {
    const s = await setup()
    await s.t.run((ctx) =>
      ctx.db.patch(s.businessId, {
        email: 'office@coastal.test',
        reportCopyEmail: 'reports@coastal',
      }),
    )
    const reportId = await withReport(s, { email: 'accounts@cafe' }, [
      { email: 'jan@coastal.test' },
      { email: 'priya@gmail..com' },
    ])

    const expected = ['jan@coastal.test', 'office@coastal.test']
    const known = await s.t.query(internal.deliveries.knownRecipients, {
      reportId,
    })
    expect([...known].sort()).toEqual(expected)
    const shown = await s.owner.as.query(api.deliveries.known, {
      businessId: s.businessId,
      reportId,
    })
    expect([...shown.addresses].sort()).toEqual(expected)
  })

  test('to an address that can never be delivered to is refused, not queued or held', async () => {
    const s = await setup()
    const reportId = await withReport(s, { email: 'accounts@cafe.test' })
    for (const recipients of [
      { to: ['accounts@cafe'] },
      { to: ['accounts@cafe.test'], cc: ['copies@coastal'] },
    ]) {
      await expect(
        s.owner.as.mutation(api.deliveries.request, {
          businessId: s.businessId,
          reportId,
          ...recipients,
        }),
      ).rejects.toThrow(/INVALID_EMAIL/)
    }
    expect(
      await s.t.run((ctx) => ctx.db.query('reportDeliveries').collect()),
    ).toEqual([])

    const { status } = await s.owner.as.mutation(api.deliveries.request, {
      businessId: s.businessId,
      reportId,
      to: [' Accounts@Cafe.test '],
    })
    expect(status).toBe('queued')
  })
})

describe('a report’s “Email Report To”', () => {
  const template = getTemplate('serviceReport')
  const issuesFor = (emailReportTo: unknown) => {
    const result = validateReport({ template, data: { emailReportTo } })
    return result.ok
      ? []
      : result.issues.filter((issue) => issue.key === 'emailReportTo')
  }

  test('names an address that can never be delivered to among the things to finish', () => {
    const [issue, ...more] = issuesFor(['strata@example.com', 'agent@gmail'])
    expect(more).toEqual([])
    expect(issue.message).toContain('agent@gmail')
    expect(issue.message).toContain('Email Report To')
  })

  test('says nothing about real addresses, an empty list, or none at all', () => {
    expect(issuesFor(['strata@example.com', ' agent@example.net '])).toEqual([])
    expect(issuesFor([])).toEqual([])
    expect(issuesFor(undefined)).toEqual([])
  })

  test('checks the single string an older draft stored, too', () => {
    expect(issuesFor('agent@gmail')).toHaveLength(1)
    expect(issuesFor('agent@gmail.com')).toEqual([])
  })
})
