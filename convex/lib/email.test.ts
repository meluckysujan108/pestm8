import { ConvexError } from 'convex/values'
import { describe, expect, test } from 'vitest'
import {
  COMMON_EMAIL_DOMAINS,
  MAX_EMAIL_LENGTH,
  emailDomain,
  emailProblem,
  emailTypoFix,
  isValidEmail,
  normaliseEmail,
} from './email'

/**
 * Field verification: an email address is refused only when it can never be
 * delivered to, and a likely typo of a big provider is offered as a fix,
 * never forced. A compliance report sent to a typo is simply gone.
 */

describe('emailProblem: addresses that can never be delivered to', () => {
  test.each([
    'bob@gmail.com',
    'Bob.Smith@Gmail.COM',
    'bob+pests@gmail.com',
    "o'brien@iinet.net.au",
    'accounts@smith-pest.com.au',
    'a@b.co',
    'bob@mail.xn--p1ai',
    '  bob@gmail.com  ',
    '1234@123.com.au',
  ])('%j is fine', (email) => {
    expect(emailProblem(email)).toBeNull()
    expect(isValidEmail(email)).toBe(true)
  })

  test('blank is not a problem here: whether it may be blank is the form’s', () => {
    expect(emailProblem('')).toBeNull()
    expect(emailProblem('   ')).toBeNull()
    expect(isValidEmail('')).toBe(false)
    expect(isValidEmail('  ')).toBe(false)
  })

  test.each([
    // The browser's own type="email" check lets this one through.
    [
      'bob@gmail',
      'Add the rest of the address after "gmail", such as .com or .com.au.',
    ],
    ['bob', 'An email address has exactly one @ in it.'],
    ['bob@@gmail.com', 'An email address has exactly one @ in it.'],
    ['bob@smith@gmail.com', 'An email address has exactly one @ in it.'],
    ['bob smith@gmail.com', 'An email address has no spaces in it.'],
    ['bob@gmail .com', 'An email address has no spaces in it.'],
    ['@gmail.com', 'Add the part before the @.'],
    ['bob@', 'Add the part after the @, such as gmail.com.'],
    [
      '.bob@gmail.com',
      'The part before the @ cannot start or end with a dot, or have two in a row.',
    ],
    [
      'bob.@gmail.com',
      'The part before the @ cannot start or end with a dot, or have two in a row.',
    ],
    [
      'bob..smith@gmail.com',
      'The part before the @ cannot start or end with a dot, or have two in a row.',
    ],
    ['bob@gmail..com', 'The part after the @ is not a real domain.'],
    ['bob@gmail.com.', 'The part after the @ is not a real domain.'],
    ['bob@.gmail.com', 'The part after the @ is not a real domain.'],
    ['bob@-gmail.com', 'The part after the @ is not a real domain.'],
    ['bob@gmail-.com', 'The part after the @ is not a real domain.'],
    ['bob@gm_ail.com', 'The part after the @ is not a real domain.'],
    ['bob@gmail.c', '".c" is not a real ending for an email address.'],
    ['bob@gmail.123', '".123" is not a real ending for an email address.'],
    ['bob@gmail.c0m', '".c0m" is not a real ending for an email address.'],
  ])('%j: %s', (email, message) => {
    expect(emailProblem(email)).toBe(message)
    expect(isValidEmail(email)).toBe(false)
  })

  test('an address longer than RFC 5321 allows', () => {
    const domain = '@gmail.com'
    const longest = `${'a'.repeat(MAX_EMAIL_LENGTH - domain.length)}${domain}`
    expect(emailProblem(longest)).toBeNull()
    expect(emailProblem(`a${longest}`)).toBe('That email address is too long.')
  })

  test('spaces around the address are not counted against it', () => {
    const domain = '@gmail.com'
    const longest = `${'a'.repeat(MAX_EMAIL_LENGTH - domain.length)}${domain}`
    expect(emailProblem(`  ${longest}  `)).toBeNull()
  })
})

describe('normaliseEmail: as stored', () => {
  test('trimmed, the domain lower-cased, the part before the @ as typed', () => {
    expect(normaliseEmail('  Bob.Smith@Gmail.COM ')).toBe('Bob.Smith@gmail.com')
  })

  test('absent when not given or blank', () => {
    expect(normaliseEmail(undefined)).toBeUndefined()
    expect(normaliseEmail('')).toBeUndefined()
    expect(normaliseEmail('   ')).toBeUndefined()
  })

  test('refuses what emailProblem refuses, with a code the client can read', () => {
    expect(() => normaliseEmail('bob@gmail')).toThrow(ConvexError)
    try {
      normaliseEmail('bob@gmail')
    } catch (error) {
      expect((error as ConvexError<string>).data).toBe('INVALID_EMAIL')
    }
  })
})

describe('emailDomain: the only part the domain check sends anywhere', () => {
  test('lower-cased, trimmed', () => {
    expect(emailDomain(' Bob@Gmail.COM ')).toBe('gmail.com')
    expect(emailDomain('accounts@smith-pest.com.au')).toBe('smith-pest.com.au')
  })

  test('null for blank or an address that can never work', () => {
    expect(emailDomain('')).toBeNull()
    expect(emailDomain('   ')).toBeNull()
    expect(emailDomain('bob@gmail')).toBeNull()
    expect(emailDomain('bob')).toBeNull()
  })
})

describe('emailTypoFix: offered, never forced', () => {
  test.each([
    ['bob@gmial.com', 'bob@gmail.com'],
    ['bob@gmal.com', 'bob@gmail.com'],
    ['bob@gamil.com', 'bob@gmail.com'],
    ['bob@gmail.con', 'bob@gmail.com'],
    ['bob@gmail.cmo', 'bob@gmail.com'],
    ['bob@gmail.comm', 'bob@gmail.com'],
    ['bob@gmail.om', 'bob@gmail.com'],
    ['bob@gmail', 'bob@gmail.com'],
    ['bob@hotmail.con', 'bob@hotmail.com'],
    ['bob@hotmial.com', 'bob@hotmail.com'],
    ['bob@hotmail', 'bob@hotmail.com'],
    ['bob@outlok.com', 'bob@outlook.com'],
    ['bob@bigpond.con.au', 'bob@bigpond.com.au'],
    ['bob@bigpnd.com', 'bob@bigpond.com'],
    ['bob@bigpond.net.u', 'bob@bigpond.net.au'],
    ['bob@yahoo.com.u', 'bob@yahoo.com.au'],
    ['bob@yahoo.com.aus', 'bob@yahoo.com.au'],
    ['bob@iinet.net.au.', 'bob@iinet.net.au'],
    ['bob@icloud.co', 'bob@icloud.com'],
    // The part before the @ is kept exactly as typed; the domain is not.
    ['Bob.Smith@GMIAL.COM', 'Bob.Smith@gmail.com'],
    ['  bob@gmial.com  ', 'bob@gmail.com'],
  ])('%j → %j', (typed, fixed) => {
    expect(emailTypoFix(typed)).toBe(fixed)
  })

  test('a slipped ending is put right on any domain, not only the big ones', () => {
    expect(emailTypoFix('accounts@smithpest.con')).toBe(
      'accounts@smithpest.com',
    )
    expect(emailTypoFix('accounts@smithpest.com.u')).toBe(
      'accounts@smithpest.com.au',
    )
  })

  test.each([
    // The providers themselves.
    ...COMMON_EMAIL_DOMAINS.map((domain) => `bob@${domain}`),
    'bob@GMAIL.COM',
    // A small business's own domain is never "corrected" into a big one.
    'accounts@smithpest.com.au',
    'bob@perthpest.com',
    'bob@westnet.net.au',
    // Too far from anything.
    'bob@gmx.com',
    'bob@aol.com',
    'bob@bigpond.net',
    'bob@iinet.com.au',
    'bob@hotmail.co.uk',
    'bob@yahoo.co.uk',
    // Nothing to go on.
    '',
    'bob',
    'bob@',
    '@gmail.com',
    'bob smith@gmial.com',
  ])('%j is left alone', (typed) => {
    expect(emailTypoFix(typed)).toBeNull()
  })

  test('a short provider allows one slip, not two', () => {
    // me.com (6 letters): "mw.com" is one slip, "mac.com" two.
    expect(emailTypoFix('bob@mw.com')).toBe('bob@me.com')
    expect(emailTypoFix('bob@mac.com')).toBeNull()
  })

  test('the fix passes emailProblem', () => {
    for (const typed of ['bob@gmial.com', 'bob@gmail', 'bob@hotmail.con']) {
      expect(emailProblem(emailTypoFix(typed)!)).toBeNull()
    }
  })
})

describe('real providers and endings that look like slips', () => {
  test.each(['bob@mail.com', 'bob@email.com', 'bob@ymail.com', 'bob@aol.com'])(
    '%j is never "corrected"',
    (email) => {
      expect(emailTypoFix(email)).toBeNull()
    },
  )

  // Each of these was once offered a "fix" to a bigger provider (the one
  // after the arrow), which would have broken a working address.
  test.each([
    ['bob@y7mail.com', 'gmail.com'],
    ['bob@exemail.com.au', 'ozemail.com.au'],
    ['bob@tpgi.com.au', 'tpg.com.au'],
    ['bob@amnet.net.au', 'iinet.net.au'],
    ['bob@protonmail.ch', 'protonmail.com'],
  ])('%j is a real address, not a slip of %s', (email) => {
    expect(emailTypoFix(email)).toBeNull()
    expect(emailTypoFix(email.toUpperCase())).toBeNull()
  })

  test('a slipped ending on one of them is put right to it, not to gmail', () => {
    expect(emailTypoFix('bob@y7mail.con')).toBe('bob@y7mail.com')
    expect(emailTypoFix('bob@tpgi.com.u')).toBe('bob@tpgi.com.au')
  })

  test('an Oman address keeps its .om ending', () => {
    expect(emailTypoFix('bob@business.om')).toBeNull()
  })

  test('a domain typed in its own letters is a real address', () => {
    expect(emailProblem('bob@münchen.de')).toBeNull()
    expect(emailProblem('bob@xn--mnchen-3ya.de')).toBeNull()
  })
})
