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
    ).toEqual({
      name: 'Jan Morris',
      phone: '0400 111 222',
      atSite: true,
      askFor: 'Jan Morris',
    })
  })

  test('a site number with no name still calls the site, named for the client', () => {
    expect(
      contactToCall({ ...cafe, siteContactPhone: '0400 111 222' }),
    ).toEqual({
      name: 'Coastal Cafe Group',
      phone: '0400 111 222',
      atSite: true,
      // Nobody to name: the card names no one its Call does not reach.
      askFor: undefined,
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
      askFor: undefined,
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
        askFor: undefined,
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
      ).toEqual({
        name: 'J. Nguyen',
        phone: '0412 345 678',
        atSite: false,
        askFor: undefined,
      })
    }
  })

  test('numbers and names are trimmed, and a blank client number is none', () => {
    expect(
      contactToCall({
        ...cafe,
        siteContactName: ' Jan Morris ',
        siteContactPhone: ' 0400 111 222 ',
      }),
    ).toEqual({
      name: 'Jan Morris',
      phone: '0400 111 222',
      atSite: true,
      askFor: 'Jan Morris',
    })
    expect(
      contactToCall({ ...cafe, clientPhone: ' 08 9335 1000 ' }).phone,
    ).toBe('08 9335 1000')
    expect(contactToCall({ ...cafe, clientPhone: '  ' }).phone).toBeUndefined()
    expect(
      contactToCall({
        clientKind: 'business',
        clientName: 'Coastal Cafe Group',
      }),
    ).toEqual({
      name: 'Coastal Cafe Group',
      phone: undefined,
      atSite: false,
      askFor: undefined,
    })
  })
})

/**
 * The client's contact person (lib/contactPerson.ts): the name the job card
 * shows beside the price, so whoever holds Call knows who to ask for. Asked
 * for by a technician ringing "Turbo Sushi" with no idea who to talk to.
 */
describe('who a visit asks for', () => {
  test('a contact person without a number is asked for on the business’s line', () => {
    expect(contactToCall({ ...cafe, contactPersonName: 'Sam Lee' })).toEqual({
      name: 'Coastal Cafe Group',
      phone: '08 9335 1000',
      atSite: false,
      askFor: 'Sam Lee',
    })
  })

  test('a contact person with their own number is rung, under their name', () => {
    expect(
      contactToCall({
        ...cafe,
        contactPersonName: 'Sam Lee',
        contactPersonPhone: '0411 222 333',
      }),
    ).toEqual({
      name: 'Sam Lee',
      phone: '0411 222 333',
      atSite: false,
      askFor: 'Sam Lee',
    })
  })

  test('a site with its own number comes before the contact person, and names its own', () => {
    const both = {
      ...cafe,
      contactPersonName: 'Sam Lee',
      contactPersonPhone: '0411 222 333',
      siteContactPhone: '0400 111 222',
    }
    expect(contactToCall({ ...both, siteContactName: 'Jan Morris' })).toEqual({
      name: 'Jan Morris',
      phone: '0400 111 222',
      atSite: true,
      askFor: 'Jan Morris',
    })
    // The site's number with no name: Sam is not at that number, so the card
    // names nobody rather than him.
    expect(contactToCall(both)).toEqual({
      name: 'Coastal Cafe Group',
      phone: '0400 111 222',
      atSite: true,
      askFor: undefined,
    })
  })

  test('a site contact with only a name gives way to the contact person', () => {
    // The business's line is rung, so who to ask for there is the person
    // head office deals with; the site's name is on the job sheet.
    expect(
      contactToCall({
        ...cafe,
        siteContactName: 'Jan Morris',
        contactPersonName: 'Sam Lee',
      }),
    ).toEqual({
      name: 'Coastal Cafe Group',
      phone: '08 9335 1000',
      atSite: false,
      askFor: 'Sam Lee',
    })
  })

  test('a contact person is named even when the business has no number', () => {
    expect(
      contactToCall({
        clientKind: 'business',
        clientName: 'Coastal Cafe Group',
        contactPersonName: 'Sam Lee',
      }),
    ).toEqual({
      name: 'Coastal Cafe Group',
      phone: undefined,
      atSite: false,
      askFor: 'Sam Lee',
    })
  })

  test('a person client asks for nobody — their name is the card’s heading', () => {
    // One switched from business keeps its contacts, hidden: nobody is named
    // or rung who is not on the screen.
    for (const clientKind of ['person', undefined] as const) {
      expect(
        contactToCall({
          clientKind,
          clientName: 'J. Nguyen',
          clientPhone: '0412 345 678',
          contactPersonName: 'Sam Lee',
          contactPersonPhone: '0411 222 333',
        }),
      ).toEqual({
        name: 'J. Nguyen',
        phone: '0412 345 678',
        atSite: false,
        askFor: undefined,
      })
    }
  })

  test('a sole trader’s contact person who is the business itself is not named twice', () => {
    const soleTrader = {
      clientKind: 'business' as const,
      clientName: 'Jan Morris',
      clientPhone: '0412 345 678',
    }
    // The heading already says it: no Contact line.
    expect(
      contactToCall({ ...soleTrader, contactPersonName: ' jan  morris ' }),
    ).toEqual({
      name: 'Jan Morris',
      phone: '0412 345 678',
      atSite: false,
      askFor: undefined,
    })
    // Their own number is still the one rung.
    expect(
      contactToCall({
        ...soleTrader,
        contactPersonName: 'Jan Morris',
        contactPersonPhone: '0400 999 888',
      }),
    ).toEqual({
      name: 'Jan Morris',
      phone: '0400 999 888',
      atSite: false,
      askFor: undefined,
    })
    // So is a site's, under the same rule.
    expect(
      contactToCall({
        ...soleTrader,
        siteContactName: 'Jan Morris',
        siteContactPhone: '0400 111 222',
      }).askFor,
    ).toBeUndefined()
  })

  test.each(['', '   '])(
    'a blank contact person ("%s") is nobody, and their number with them',
    (blank) => {
      expect(
        contactToCall({
          ...cafe,
          contactPersonName: blank,
          contactPersonPhone: '0411 222 333',
        }),
      ).toEqual({
        name: 'Coastal Cafe Group',
        phone: '08 9335 1000',
        atSite: false,
        askFor: undefined,
      })
    },
  )

  test('a contact person’s name and number are trimmed, and a blank number is none', () => {
    expect(
      contactToCall({
        ...cafe,
        contactPersonName: ' Sam Lee ',
        contactPersonPhone: ' 0411 222 333 ',
      }),
    ).toEqual({
      name: 'Sam Lee',
      phone: '0411 222 333',
      atSite: false,
      askFor: 'Sam Lee',
    })
    expect(
      contactToCall({
        ...cafe,
        contactPersonName: 'Sam Lee',
        contactPersonPhone: '  ',
      }),
    ).toEqual({
      name: 'Coastal Cafe Group',
      phone: '08 9335 1000',
      atSite: false,
      askFor: 'Sam Lee',
    })
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
