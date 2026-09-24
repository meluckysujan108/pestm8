import { describe, expect, test } from 'vitest'
import { contactToCall, siteContactOf } from './siteContact'

/**
 * Prompt 6.3: who a visit's Call and Text reach. The rule the card and the job
 * sheet both lean on — so the failure worth pinning is a button that names one
 * person and dials another.
 */

const cafe = {
  clientKind: 'business' as const,
  clientName: 'Coastal Cafe Group',
  clientPhone: '08 9335 1000',
}

describe('who a visit calls', () => {
  test('a business site with its own number calls the site, under the site contact’s name', () => {
    expect(
      contactToCall({
        ...cafe,
        siteContactName: 'Jan Morris',
        siteContactPhone: '0400 111 222',
      }),
    ).toEqual({ name: 'Jan Morris', phone: '0400 111 222', atSite: true })
  })

  test('a site number with no name still calls the site, named for the client', () => {
    expect(
      contactToCall({ ...cafe, siteContactPhone: '0400 111 222' }),
    ).toEqual({
      name: 'Coastal Cafe Group',
      phone: '0400 111 222',
      atSite: true,
    })
    expect(
      contactToCall({
        ...cafe,
        siteContactName: '   ',
        siteContactPhone: '0400 111 222',
      }).name,
    ).toBe('Coastal Cafe Group')
  })

  test('a site contact with only a name calls the client — the client’s name with the client’s number', () => {
    expect(contactToCall({ ...cafe, siteContactName: 'Jan Morris' })).toEqual({
      name: 'Coastal Cafe Group',
      phone: '08 9335 1000',
      atSite: false,
    })
  })

  test.each(['', '   ', '\t'])(
    'a blank site number ("%s") is no site number',
    (blank) => {
      expect(
        contactToCall({
          ...cafe,
          siteContactName: 'Jan Morris',
          siteContactPhone: blank,
        }),
      ).toEqual({
        name: 'Coastal Cafe Group',
        phone: '08 9335 1000',
        atSite: false,
      })
    },
  )

  test('a person client’s site fields never override their own line', () => {
    // A client switched from business to person keeps its site contacts,
    // hidden: nobody should be dialled who is not on the screen.
    for (const clientKind of ['person', undefined] as const) {
      expect(
        contactToCall({
          clientKind,
          clientName: 'J. Nguyen',
          clientPhone: '0412 345 678',
          siteContactName: 'Jan Morris',
          siteContactPhone: '0400 111 222',
        }),
      ).toEqual({ name: 'J. Nguyen', phone: '0412 345 678', atSite: false })
    }
  })

  test('numbers and names are trimmed, and a blank client number is none', () => {
    expect(
      contactToCall({
        ...cafe,
        siteContactName: ' Jan Morris ',
        siteContactPhone: ' 0400 111 222 ',
      }),
    ).toEqual({ name: 'Jan Morris', phone: '0400 111 222', atSite: true })
    expect(
      contactToCall({ ...cafe, clientPhone: ' 08 9335 1000 ' }).phone,
    ).toBe('08 9335 1000')
    expect(contactToCall({ ...cafe, clientPhone: '  ' }).phone).toBeUndefined()
    expect(
      contactToCall({
        clientKind: 'business',
        clientName: 'Coastal Cafe Group',
      }),
    ).toEqual({ name: 'Coastal Cafe Group', phone: undefined, atSite: false })
  })
})

describe('the site contact a sheet shows', () => {
  test('is the business site’s, trimmed', () => {
    expect(
      siteContactOf({
        clientKind: 'business',
        siteContactName: ' Jan Morris ',
        siteContactPhone: ' 0400 111 222 ',
      }),
    ).toEqual({ name: 'Jan Morris', phone: '0400 111 222' })
  })

  test('is shown with only a name, or only a number', () => {
    expect(
      siteContactOf({ clientKind: 'business', siteContactName: 'Jan Morris' }),
    ).toEqual({ name: 'Jan Morris', phone: undefined })
    expect(
      siteContactOf({
        clientKind: 'business',
        siteContactName: '  ',
        siteContactPhone: '0400 111 222',
      }),
    ).toEqual({ name: undefined, phone: '0400 111 222' })
  })

  test('is nothing when both are blank or absent', () => {
    expect(siteContactOf({ clientKind: 'business' })).toBeNull()
    expect(
      siteContactOf({
        clientKind: 'business',
        siteContactName: ' ',
        siteContactPhone: '',
      }),
    ).toBeNull()
  })

  test('is nothing for a person client, whatever is stored', () => {
    for (const clientKind of ['person', undefined] as const) {
      expect(
        siteContactOf({
          clientKind,
          siteContactName: 'Jan Morris',
          siteContactPhone: '0400 111 222',
        }),
      ).toBeNull()
    }
  })
})
