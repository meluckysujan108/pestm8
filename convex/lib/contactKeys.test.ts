import { describe, expect, test } from 'vitest'
import {
  addressNear,
  areaCodeOf,
  emailKey,
  emailKeys,
  isPlaceholderName,
  nameKey,
  nameNear,
  nameWords,
  phoneKeys,
  phoneKind,
  siteKey,
  streetKey,
  surnameOf,
} from './contactKeys'
import { siteKey as importSiteKey } from './clientImport'
import { nameKey as xeroNameKey } from './xeroMatch'

/**
 * The keys "is this caller already a client?" compares (lib/clientMatch.ts):
 * the same on the phone and on the server, so each rule is pinned here.
 */

const PERTH = '08'

describe('phoneKeys', () => {
  test('every way of writing one mobile is one key', () => {
    for (const raw of [
      '0412 345 678',
      '0412345678',
      '0412-345-678',
      '+61 412 345 678',
      '+61412345678',
      '+61 (0)412 345 678',
      '0061 412 345 678',
      '61412345678',
      '412 345 678',
    ]) {
      expect(phoneKeys(raw, PERTH), raw).toEqual(['0412345678'])
    }
  })

  test('every way of writing one landline is one key, a local number under the business’s area code', () => {
    for (const raw of [
      '(08) 9345 6789',
      '08 9345 6789',
      '+61 8 9345 6789',
      '+61 (0)8 9345 6789',
      '9345 6789',
      '93456789',
    ]) {
      expect(phoneKeys(raw, PERTH), raw).toEqual(['0893456789'])
    }
  })

  test('(02) and (08) numbers with the same last eight digits stay apart', () => {
    expect(phoneKeys('(02) 9345 6789', PERTH)).toEqual(['0293456789'])
    expect(phoneKeys('(08) 9345 6789', PERTH)).not.toEqual(
      phoneKeys('(02) 9345 6789', PERTH),
    )
    // A Sydney business's local number is a Sydney number.
    expect(phoneKeys('9345 6789', '02')).toEqual(['0293456789'])
  })

  test('a field holding two numbers gives both, once each', () => {
    const both = ['0412345678', '0893456789']
    for (const raw of [
      '0412 345 678 / 08 9345 6789',
      '0412 345 678, 08 9345 6789',
      '0412 345 678; 08 9345 6789',
      '0412 345 678 or 08 9345 6789',
      '0412 345 678 and 08 9345 6789',
      '0412 345 678 & 08 9345 6789',
    ]) {
      expect(phoneKeys(raw, PERTH), raw).toEqual(both)
    }
    expect(phoneKeys('0412 345 678 / 0412345678', PERTH)).toEqual([
      '0412345678',
    ])
  })

  test('an area code, the country’s code or a line’s written apart goes with the number after it', () => {
    // A Perth number in a Sydney business stays a Perth number, and never
    // becomes the Sydney one with the same eight digits.
    expect(phoneKeys('08/9345 6789', '02')).toEqual(['0893456789'])
    expect(phoneKeys('(08) / 9345 6789', '02')).toEqual(['0893456789'])
    expect(phoneKeys('02/9345 6789', PERTH)).toEqual(['0293456789'])
    expect(phoneKeys('+61 / 412 345 678', PERTH)).toEqual(['0412345678'])
    expect(phoneKeys('1300/123 456', PERTH)).toEqual(['line:1300123456'])
    expect(phoneKeys('0412 345 678 / 08 / 9345 6789', '02')).toEqual([
      '0412345678',
      '0893456789',
    ])
    // The next line's last four digits are not a start, and give no key.
    expect(phoneKeys('08 9345 6789/6790', PERTH)).toEqual(['0893456789'])
    expect(phoneKeys('08 9345 6789/6790 / 0412 345 678', PERTH)).toEqual([
      '0893456789',
      '0412345678',
    ])
  })

  test('a number nobody answers gives no key', () => {
    for (const raw of [
      '0400 000 000',
      '0400000000',
      '400 000 000',
      '0411 111 111',
      '0000 000 000',
      '(08) 0000 0000',
      '(08) 1111 1111',
      '2222 2222',
    ]) {
      expect(phoneKeys(raw, PERTH), raw).toEqual([])
    }
    expect(phoneKeys('0412 345 678 / 0400 000 000', PERTH)).toEqual([
      '0412345678',
    ])
    // Repeated digits that are a real number still are one.
    expect(phoneKeys('0412 222 222', PERTH)).toEqual(['0412222222'])
    expect(phoneKeys('(08) 9222 2222', PERTH)).toEqual(['0892222222'])
  })

  test('an extension is set aside', () => {
    expect(phoneKeys('08 9345 6789 ext 21', PERTH)).toEqual(['0893456789'])
    expect(phoneKeys('08 9345 6789 x21', PERTH)).toEqual(['0893456789'])
  })

  test('13 12 34, 1300 and 1800 are line numbers, whatever their length', () => {
    expect(phoneKeys('13 12 34', PERTH)).toEqual(['line:131234'])
    expect(phoneKeys('131234', PERTH)).toEqual(['line:131234'])
    expect(phoneKeys('1300 123 456', PERTH)).toEqual(['line:1300123456'])
    expect(phoneKeys('1800 123 456', PERTH)).toEqual(['line:1800123456'])
    expect(phoneKind('line:131234')).toBe('line')
  })

  test('another country’s number is a + and every digit', () => {
    expect(phoneKeys('+44 20 7946 0958', PERTH)).toEqual(['+442079460958'])
    expect(phoneKind('+442079460958')).toBe('foreign')
  })

  test('what is not a number gives no key', () => {
    for (const raw of [undefined, '', '  ', '12345', '0412 3456', 'none']) {
      expect(phoneKeys(raw, PERTH), String(raw)).toEqual([])
    }
  })

  test('the kind of a key', () => {
    expect(phoneKind('0412345678')).toBe('mobile')
    expect(phoneKind('0893456789')).toBe('landline')
    expect(phoneKind('0293456789')).toBe('landline')
  })

  test('the area code is the business’s state’s', () => {
    expect(areaCodeOf('WA')).toBe('08')
    expect(areaCodeOf('nsw')).toBe('02')
    expect(areaCodeOf('VIC')).toBe('03')
    expect(areaCodeOf('QLD')).toBe('07')
    expect(areaCodeOf(undefined)).toBe('08')
  })
})

describe('emailKeys', () => {
  test('trimmed, lower-cased, mailto: and brackets dropped', () => {
    expect(emailKeys('  Jane@Example.COM ')).toEqual(['jane@example.com'])
    expect(emailKeys('mailto:jane@example.com')).toEqual(['jane@example.com'])
    expect(emailKeys('Jane Nguyen <jane@example.com>')).toEqual([
      'jane@example.com',
    ])
  })

  test('split on commas, semicolons and spaces, keeping what holds an @', () => {
    expect(emailKeys('a@x.com; b@y.com, c@z.com d@w.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
      'd@w.com',
    ])
    expect(emailKeys('no address here')).toEqual([])
    expect(emailKeys(undefined)).toEqual([])
  })

  test('an address nobody reads gives no key', () => {
    for (const raw of [
      'noemail@noemail.com',
      'NoEmail@gmail.com',
      'none@none.com',
      'na@na.com',
      'n/a@pestm8.test',
      'noreply@example.com',
    ]) {
      expect(emailKeys(raw), raw).toEqual([])
    }
    expect(emailKeys('jane@example.com; none@none.com')).toEqual([
      'jane@example.com',
    ])
    // Only the whole part before the @ says so: this is somebody's.
    expect(emailKeys('nadia@example.com')).toEqual(['nadia@example.com'])
  })

  test('Gmail’s dots and +tags are left as they are', () => {
    expect(emailKeys('jane.nguyen@gmail.com')).not.toEqual(
      emailKeys('janenguyen@gmail.com'),
    )
    expect(emailKeys('jane+pest@gmail.com')).not.toEqual(
      emailKeys('jane@gmail.com'),
    )
  })

  test('the single email Xero compares', () => {
    expect(emailKey(' Jane@Example.com ')).toBe('jane@example.com')
    expect(emailKey('   ')).toBeNull()
  })
})

describe('names', () => {
  test('nameKey is the one Xero matching has always used', () => {
    expect(xeroNameKey).toBe(nameKey)
    expect(nameKey('Smith, John')).toBe(nameKey('John Smith'))
    expect(nameKey('Acme Pty Ltd')).toBe(nameKey('ACME'))
  })

  test('nameWords drops titles, "and", care of and company endings, in order', () => {
    expect(nameWords('Mr & Mrs J Nguyen')).toEqual(['j', 'nguyen'])
    expect(nameWords('Dr Jane Nguyen')).toEqual(['jane', 'nguyen'])
    expect(nameWords('Tom Lee c/- Ray White')).toEqual(['tom', 'lee'])
    expect(nameWords('Tom Lee C/O Ray White')).toEqual(['tom', 'lee'])
    expect(nameWords('c/- Ray White')).toEqual(['ray', 'white'])
    expect(nameWords('Smith and Sons Pty Ltd')).toEqual(['smith', 'sons'])
    expect(nameWords('José García')).toEqual(['jose', 'garcia'])
  })

  test('surnameOf: the words before a comma, else the last word', () => {
    expect(surnameOf('Smith, John')).toBe('smith')
    expect(surnameOf('Van Der Berg, Anna')).toBe('van der berg')
    expect(surnameOf('John Smith')).toBe('smith')
    expect(surnameOf('Mr & Mrs J Nguyen')).toBe('nguyen')
    expect(surnameOf('')).toBe('')
  })

  test('nameNear: initials, both ways', () => {
    expect(nameNear('J Nguyen', 'Jane Nguyen')).toBe(true)
    expect(nameNear('Jane Nguyen', 'J Nguyen')).toBe(true)
    expect(nameNear('J. Nguyen', 'Jane Nguyen')).toBe(true)
    expect(nameNear('Nguyen, J', 'Jane Nguyen')).toBe(true)
    expect(nameNear('José García', 'J Garcia')).toBe(true)
  })

  test('nameNear: households, both ways', () => {
    expect(nameNear('Mr & Mrs J Nguyen', 'Jane Nguyen')).toBe(true)
    expect(nameNear('Jane Nguyen', 'Mr & Mrs J Nguyen')).toBe(true)
    expect(nameNear('J & T Nguyen', 'Tom Nguyen')).toBe(true)
    expect(nameNear('Tom Nguyen', 'J & T Nguyen')).toBe(true)
    expect(nameNear('J + T Nguyen', 'Jane Nguyen')).toBe(true)
    expect(nameNear('J & T Nguyen', 'Lisa Nguyen')).toBe(false)
  })

  test('nameNear: the surname must be the shared word', () => {
    expect(nameNear('Tom Nguyen', 'Jane Nguyen')).toBe(false)
    expect(nameNear('Jane Smith', 'Jane Nguyen')).toBe(false)
    expect(nameNear('J Smith', 'Jane Nguyen')).toBe(false)
  })

  test('nameNear: a one-word name is never near anything', () => {
    expect(nameNear('Smith', 'John Smith')).toBe(false)
    expect(nameNear('John Smith', 'Smith')).toBe(false)
    expect(nameNear('Smith', 'Smith')).toBe(false)
    expect(nameNear('Mr & Mrs Nguyen', 'Jane Nguyen')).toBe(false)
  })

  test('nameNear: care of is dropped', () => {
    expect(nameNear('Tom Lee c/- Ray White', 'T Lee')).toBe(true)
    expect(nameNear('Tom Lee c/- Ray White', 'Ray White')).toBe(false)
  })

  test('nameNear: a business’s shorter name is in its longer one', () => {
    expect(nameNear('Ray White', 'Ray White Bayswater', 'business')).toBe(true)
    expect(nameNear('Ray White Bayswater', 'Ray White', 'business')).toBe(true)
    expect(
      nameNear('Smith Pest Control Pty Ltd', 'Smith Pest', 'business'),
    ).toBe(true)
    expect(
      nameNear('Ray White Morley', 'Ray White Bayswater', 'business'),
    ).toBe(false)
    // One word once the ending is gone.
    expect(nameNear('Acme Pty Ltd', 'Acme Pest Control', 'business')).toBe(
      false,
    )
  })

  test('placeholders are no name at all', () => {
    for (const name of [
      'The Owner',
      'owner',
      'TENANT',
      'The Occupier',
      'Owners Corporation',
      'Body Corporate',
      'Strata Plan',
      'Property Manager',
      'The Manager',
      'Unknown',
      'Customer',
      'Cash',
      'TBA',
      'N/A',
      'n/a',
      '',
      ' - ',
      // Any mix of the same words, as offices write them.
      'The Owner/Occupier',
      'Owner Occupier',
      'Owner/Occupiers',
      'Occupant',
      'The Tenants',
      'Tenant & Owner',
      'Resident',
      'Landlord',
      'Cash Sale',
      'Cash Customer',
      'New Client',
      'TBC',
      'n.a.',
      'Mr & Mrs',
      'The Owner c/- Ray White Bayswater',
    ]) {
      expect(isPlaceholderName(name), name).toBe(true)
    }
    for (const name of [
      'Jane Nguyen',
      'Owner Smith',
      'Strata Plan 12345',
      'Johnny Cash',
      'Mrs Smith',
      'The Smiths',
      'Ray White c/- The Owner',
    ]) {
      expect(isPlaceholderName(name), name).toBe(false)
    }
  })
})

describe('addresses', () => {
  const at = (
    addressLine: string,
    suburb = 'Bayswater',
    postcode = '6053',
  ) => ({
    addressLine,
    suburb,
    postcode,
  })

  test('siteKey is the client import’s', () => {
    expect(siteKey).toBe(importSiteKey)
    expect(siteKey(at('U3/12 Ocean Parade'))).toBe(
      siteKey(at('3/12 Ocean Pde')),
    )
    expect(siteKey(at('1 Smith St', 'Nightcliff', '810'))).toBe(
      siteKey(at('1 Smith St', 'Nightcliff', '0810')),
    )
  })

  test('streetKey leaves the suburb out', () => {
    expect(streetKey(at('12 Wattle Street', 'Bayswater'))).toBe(
      streetKey(at('12 Wattle St', 'Bayswatr')),
    )
    expect(streetKey(at('12 Wattle St', 'Bayswater', '6053'))).not.toBe(
      streetKey(at('12 Wattle St', 'Bayswater', '6054')),
    )
  })

  test('addressNear: a slip in the street name', () => {
    expect(addressNear(at('12 Watle St'), at('12 Wattle St'))).toBe(true)
    expect(addressNear(at('12 Wattle St'), at('12 Watle St'))).toBe(true)
  })

  test('addressNear: one line containing the other', () => {
    expect(
      addressNear(at('12 Ocean Pde'), at('Common Property 12 Ocean Pde')),
    ).toBe(true)
    expect(addressNear(at('12 Ocean Pde East'), at('12 Ocean Pde'))).toBe(true)
  })

  test('addressNear: a unit is never the building, nor another unit', () => {
    expect(addressNear(at('3/12 Ocean Pde'), at('12 Ocean Pde'))).toBe(false)
    expect(addressNear(at('3/12 Ocean Pde'), at('5/12 Ocean Pde'))).toBe(false)
    expect(addressNear(at('Unit 3, 12 Ocean Pde'), at('3/12 Ocean Pde'))).toBe(
      true,
    )
  })

  test('addressNear: 810 is 0810, and either the postcode or the suburb will do', () => {
    expect(
      addressNear(
        at('1 Smith St', 'Nightcliff', '810'),
        at('1 Smth St', 'Nightclif', '0810'),
      ),
    ).toBe(true)
    expect(
      addressNear(
        at('12 Watle St', 'Bayswater', '6053'),
        at('12 Wattle St', 'Bayswater', '6054'),
      ),
    ).toBe(true)
    expect(
      addressNear(
        at('12 Watle St', 'Morley', '6062'),
        at('12 Wattle St', 'Bayswater', '6053'),
      ),
    ).toBe(false)
  })

  test('addressNear: another street type is another street', () => {
    // An estate's Wattle St, Wattle Ct and Wattle Pl are three streets.
    expect(addressNear(at('12 Wattle Ct'), at('12 Wattle St'))).toBe(false)
    expect(addressNear(at('12 Wattle Pl'), at('12 Wattle Rd'))).toBe(false)
    expect(addressNear(at('12 Park Rd'), at('12 Park St'))).toBe(false)
    expect(addressNear(at('12 Watle Ct'), at('12 Wattle St'))).toBe(false)
    expect(addressNear(at('12 Ocean Pde East'), at('12 Ocean Pde West'))).toBe(
      false,
    )
    // A slip in the type itself, or no type written, is still the street.
    expect(addressNear(at('12 Ocean Prade'), at('12 Ocean Pde'))).toBe(true)
    expect(addressNear(at('12 Wattle'), at('12 Wattle Ct'))).toBe(true)
  })

  test('addressNear: a short street name allows fewer slips', () => {
    expect(addressNear(at('12 Elk St'), at('12 Elm St'))).toBe(false)
    expect(addressNear(at('12 Smth St'), at('12 Smith St'))).toBe(true)
    expect(addressNear(at('12 Smoth St'), at('12 Smith St'))).toBe(true)
    expect(addressNear(at('12 Smyth St'), at('12 Smoth St'))).toBe(true)
    expect(addressNear(at('12 Sm St'), at('12 Smith St'))).toBe(false)
    expect(addressNear(at('12 Banksai Ave'), at('12 Banksia Ave'))).toBe(true)
  })

  test('addressNear: a Lot, Shop or Level number is never the house number', () => {
    expect(addressNear(at('Lot 5 Smith Rd'), at('5 Smith Rd'))).toBe(false)
    expect(addressNear(at('Shop 3, 12 Ocean Pde'), at('3 Ocean Pde'))).toBe(
      false,
    )
    expect(addressNear(at('Level 2, 12 Smith St'), at('2 Smith St'))).toBe(
      false,
    )
    // A shop is not the building, as a unit is not.
    expect(addressNear(at('Shop 3, 12 Ocean Pde'), at('12 Ocean Pde'))).toBe(
      false,
    )
    // The same lot or shop, written two ways, still is.
    expect(addressNear(at('Lot 5 Smth Rd'), at('Lot 5 Smith Rd'))).toBe(true)
    expect(
      addressNear(at('Shop 3, 12 Ocean Prade'), at('Shop 3 12 Ocean Pde')),
    ).toBe(true)
    expect(
      addressNear(at('Shop 3/12 Ocean Pde'), at('Shop 3, 12 Ocean Pde')),
    ).toBe(true)
  })

  test('addressNear: another number, or no number, is another place', () => {
    expect(addressNear(at('14 Wattle St'), at('12 Wattle St'))).toBe(false)
    expect(addressNear(at('Lot 5 Smith Rd'), at('12 Smith Rd'))).toBe(false)
    expect(addressNear(at('Wattle Farm'), at('Wattle Farm Rd'))).toBe(false)
    expect(addressNear(at('12 Wattle St'), at('12 Banksia Ave'))).toBe(false)
  })
})
