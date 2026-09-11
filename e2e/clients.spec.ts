import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/** Creates a fresh business-kind client (+ its first property) and returns
 * its clientId, resolved via the property rather than by listing clients. */
async function createBusinessClient(
  s: Awaited<ReturnType<typeof setupBusinessWithSub>>,
  name: string,
) {
  const propertyId = await s.owner.client.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: name,
    kind: 'business',
    addressLine: '1 Head Office Way',
    suburb: 'Perth',
    state: 'WA',
    postcode: '6000',
  })
  const property = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId,
  })
  return property!.clientId
}

test('a business address round-trips through clients.update, and stays undefined if never set', async () => {
  const s = await setupBusinessWithSub('client-address')
  const clientId = await createBusinessClient(s, 'ACME Pest Solutions')

  await s.owner.client.mutation(api.clients.update, {
    businessId: s.businessId,
    clientId,
    addressLine: '42 Corporate Drive',
    suburb: 'Osborne Park',
    state: 'WA',
    postcode: '6017',
  })

  const client = await s.owner.client.query(api.clients.get, {
    businessId: s.businessId,
    clientId,
  })
  expect(client?.addressLine).toBe('42 Corporate Drive')
  expect(client?.suburb).toBe('Osborne Park')
  expect(client?.state).toBe('WA')
  expect(client?.postcode).toBe('6017')

  // The fixture's own default property client (person-kind) never had any
  // address field set — confirm it reads back undefined, not defaulted.
  const person = await s.owner.client.query(api.properties.get, {
    businessId: s.businessId,
    propertyId: s.propertyId,
  })
  const personClient = await s.owner.client.query(api.clients.get, {
    businessId: s.businessId,
    clientId: person!.clientId,
  })
  expect(personClient?.addressLine).toBeUndefined()
})

test('only one contact is ever primary at a time', async () => {
  const s = await setupBusinessWithSub('client-primary')
  const clientId = await createBusinessClient(s, 'Beacon Facilities')

  const contactB = await s.owner.client.mutation(api.clientContacts.create, {
    businessId: s.businessId,
    clientId,
    name: 'Beth',
  })
  const contactC = await s.owner.client.mutation(api.clientContacts.create, {
    businessId: s.businessId,
    clientId,
    name: 'Carl',
  })

  await s.owner.client.mutation(api.clientContacts.setPrimary, {
    businessId: s.businessId,
    contactId: contactB,
  })
  let contacts = await s.owner.client.query(api.clientContacts.list, {
    businessId: s.businessId,
    clientId,
  })
  expect(contacts.find((c) => c._id === contactB)?.isPrimary).toBe(true)
  expect(contacts.find((c) => c._id === contactC)?.isPrimary ?? false).toBe(
    false,
  )

  await s.owner.client.mutation(api.clientContacts.setPrimary, {
    businessId: s.businessId,
    contactId: contactC,
  })
  contacts = await s.owner.client.query(api.clientContacts.list, {
    businessId: s.businessId,
    clientId,
  })
  expect(contacts.find((c) => c._id === contactB)?.isPrimary ?? false).toBe(
    false,
  )
  expect(contacts.find((c) => c._id === contactC)?.isPrimary).toBe(true)
})

test('editing a contact in place patches only the given fields', async () => {
  const s = await setupBusinessWithSub('client-contact-edit')
  const clientId = await createBusinessClient(s, 'Harborview Strata')

  const contactId = await s.owner.client.mutation(api.clientContacts.create, {
    businessId: s.businessId,
    clientId,
    name: 'Dana',
    role: 'Office manager',
    phone: '0400 111 222',
  })

  await s.owner.client.mutation(api.clientContacts.update, {
    businessId: s.businessId,
    contactId,
    role: 'Facilities manager',
    email: 'dana@harborview.example',
  })

  const contacts = await s.owner.client.query(api.clientContacts.list, {
    businessId: s.businessId,
    clientId,
  })
  const dana = contacts.find((c) => c._id === contactId)
  expect(dana?.name).toBe('Dana')
  expect(dana?.role).toBe('Facilities manager')
  expect(dana?.phone).toBe('0400 111 222')
  expect(dana?.email).toBe('dana@harborview.example')
})

test('a non-member cannot set a business address or a primary contact', async () => {
  const s = await setupBusinessWithSub('client-lock')
  const clientId = await createBusinessClient(s, 'Redline Logistics')
  const contactId = await s.owner.client.mutation(api.clientContacts.create, {
    businessId: s.businessId,
    clientId,
    name: 'Priya',
  })

  const outsider = await signUpActor(
    uniqueEmail('client-outsider'),
    FIXTURE_PASSWORD,
    'Nadia',
  )

  await expectRejected(
    () =>
      outsider.client.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId,
        addressLine: '99 Nowhere Street',
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      outsider.client.mutation(api.clientContacts.setPrimary, {
        businessId: s.businessId,
        contactId,
      }),
    'NO_ACCESS',
  )
})
