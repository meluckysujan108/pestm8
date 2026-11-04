// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { propertyEditArgs, propertyFieldsOf } from './propertyEditArgs'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * What the job sheet's Edit → Property details saves. Only this module, never
 * PropertyEditMode.tsx: that reaches the kept copy's keeper, which a test
 * can't load without a deployment's address (and CI has none).
 */

const businessId = 'b1' as Id<'businesses'>
const property = {
  _id: 'p1' as Id<'properties'>,
  addressLine: '14 Kewdale Road',
  suburb: 'Welshpool',
  state: 'WA',
  postcode: '6106',
  siteContactName: 'Priya Shah',
  siteContactPhone: '0412 345 678',
}
const ids = { businessId, propertyId: property._id }

function args(
  patch: Partial<ReturnType<typeof propertyFieldsOf>>,
  {
    clientKind = 'business',
    addressCheck = 'typed',
  }: {
    clientKind?: 'person' | 'business'
    addressCheck?: 'typed' | 'picked'
  } = {},
) {
  return propertyEditArgs({
    businessId,
    property,
    value: { ...propertyFieldsOf(property), ...patch },
    addressCheck,
    clientKind,
  })
}

describe('a property’s edit from the job sheet sends', () => {
  test('only its ids when nothing changed, so nothing is written', () => {
    expect(args({})).toEqual(ids)
    expect(args({}, { clientKind: 'person' })).toEqual(ids)
    // Spaces typed around a value are not a change.
    expect(args({ siteContactName: ' Priya Shah ' })).toEqual(ids)
  })

  test('the address as one, with how it came to be, when any part of it changed', () => {
    expect(args({ addressLine: '14A Kewdale Road' })).toEqual({
      ...ids,
      addressLine: '14A Kewdale Road',
      suburb: 'Welshpool',
      state: 'WA',
      postcode: '6106',
      addressCheck: 'typed',
    })
    expect(
      args(
        { addressLine: '2 Mulgul Road', suburb: 'Malaga', postcode: '6090' },
        { addressCheck: 'picked' },
      ),
    ).toMatchObject({
      addressLine: '2 Mulgul Road',
      suburb: 'Malaga',
      postcode: '6090',
      addressCheck: 'picked',
    })
  })

  test('a business’s site contact, each part only when it changed, and blank clears it', () => {
    expect(args({ siteContactName: 'Tom Lee' })).toEqual({
      ...ids,
      siteContactName: 'Tom Lee',
    })
    expect(args({ siteContactPhone: '0499 111 222 ' })).toEqual({
      ...ids,
      siteContactPhone: '0499 111 222',
    })
    expect(args({ siteContactName: '', siteContactPhone: '' })).toEqual({
      ...ids,
      siteContactName: '',
      siteContactPhone: '',
    })
  })

  test('never a homeowner’s site contact: theirs are hidden, so saving the address leaves them', () => {
    expect(
      args(
        { addressLine: '12A Wattle Street', siteContactName: '' },
        { clientKind: 'person' },
      ),
    ).not.toHaveProperty('siteContactName')
  })
})
