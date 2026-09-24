import { describe, expect, test } from 'vitest'
import {
  EMPTY_NEW_CLIENT,
  EMPTY_NEW_SITE,
  abnRefusal,
  newClientArgs,
  newSiteArgs,
} from './NewClientFields'
import type { NewClientFieldsValue } from './NewClientFields'
import type { Id } from '../../../convex/_generated/dataModel'

const business: NewClientFieldsValue = {
  ...EMPTY_NEW_CLIENT,
  kind: 'business',
  clientName: ' Harbour Strata ',
  abn: '51 824 753 556',
  contactPerson: ' Jan Kowalski ',
  addressLine: ' 1 Quay Road ',
  suburb: 'Fremantle ',
  state: 'WA',
  postcode: ' 6160',
  phone: '08 9335 1234',
  email: '',
  siteContactName: 'Dee (caretaker)',
  siteContactPhone: '0412 345 678',
}

describe('newClientArgs', () => {
  test('sends every field a business draft holds, trimmed', () => {
    expect(newClientArgs(business)).toStrictEqual({
      clientName: 'Harbour Strata',
      kind: 'business',
      addressLine: '1 Quay Road',
      suburb: 'Fremantle',
      state: 'WA',
      postcode: '6160',
      phone: '08 9335 1234',
      email: undefined,
      abn: '51 824 753 556',
      contactPerson: 'Jan Kowalski',
      siteContactName: 'Dee (caretaker)',
      siteContactPhone: '0412 345 678',
    })
  })

  test('leaves a blank optional field out rather than sending ""', () => {
    const args = newClientArgs({
      ...business,
      abn: '  ',
      contactPerson: '',
      siteContactName: '',
      siteContactPhone: ' ',
    })
    expect(args.abn).toBeUndefined()
    expect(args.contactPerson).toBeUndefined()
    expect(args.siteContactName).toBeUndefined()
    expect(args.siteContactPhone).toBeUndefined()
  })

  test('drops the business-only fields for a person, even when still typed in', () => {
    // Switched from Business to Person after filling them: hidden, not sent.
    const args = newClientArgs({ ...business, kind: 'person' })
    expect(args.kind).toBe('person')
    for (const key of [
      'abn',
      'contactPerson',
      'siteContactName',
      'siteContactPhone',
    ]) {
      expect(args).not.toHaveProperty(key)
    }
    expect(args.phone).toBe('08 9335 1234')
  })
})

describe('newSiteArgs', () => {
  const clientId = 'client1' as Id<'clients'>
  const site = {
    ...EMPTY_NEW_SITE,
    addressLine: ' 5 Wattle Street ',
    suburb: ' Bayswater',
    state: 'WA',
    postcode: '6053 ',
    siteContactName: ' Dee ',
    siteContactPhone: '0412 345 678',
  }

  test('carries the site contact for a business client', () => {
    expect(newSiteArgs(clientId, 'business', site)).toStrictEqual({
      clientId,
      addressLine: '5 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      siteContactName: 'Dee',
      siteContactPhone: '0412 345 678',
    })
  })

  test('leaves it out for anyone else', () => {
    expect(newSiteArgs(clientId, 'person', site)).toStrictEqual({
      clientId,
      addressLine: '5 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
  })
})

describe('abnRefusal', () => {
  test('names the ABN for the server refusing one', () => {
    const error = new Error(
      '[CONVEX M(jobs:create)] Uncaught ConvexError: INVALID_ABN',
    )
    expect(abnRefusal(error)).toMatch(/ABN doesn't pass the ATO check/)
  })

  test('says nothing of the ABN for any other failure', () => {
    expect(abnRefusal(new Error('NO_ACCESS'))).toBeNull()
    expect(abnRefusal(null)).toBeNull()
  })
})
