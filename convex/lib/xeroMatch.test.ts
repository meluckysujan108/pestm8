import { describe, expect, test } from 'vitest'
import { accountNumberKey, matchClients, nameKey } from './xeroMatch'
import type { Id } from '../_generated/dataModel'
import type { ClientForMatch, Proposal, XeroContactForMatch } from './xeroMatch'

/**
 * The matcher's rules (lib/xeroMatch.ts), one at a time. Clients and contacts
 * are built from the fewest fields that make each case; everything else is
 * left blank so it can't help or hinder.
 */

const id = (n: string) => `client-${n}` as Id<'clients'>

function client(
  n: string,
  name: string,
  extra: Partial<Omit<ClientForMatch, 'clientId' | 'name'>> = {},
): ClientForMatch {
  return { clientId: id(n), name, emails: [], ...extra }
}

function contact(
  contactId: string,
  name: string,
  extra: Partial<Omit<XeroContactForMatch, 'contactId' | 'name'>> = {},
): XeroContactForMatch {
  return { contactId, name, status: 'ACTIVE', ...extra }
}

/** The proposals, as `clientId → outcome[:reason]@contactId`. */
function outcomes(proposals: Array<Proposal>): Record<string, string> {
  return Object.fromEntries(
    proposals.map((p) => [
      p.clientId,
      p.outcome === 'new'
        ? 'new'
        : p.outcome === 'linked'
          ? `linked@${p.contact.contactId}`
          : `review:${p.reason}@${p.contact.contactId}`,
    ]),
  )
}

const match = (
  clients: Array<ClientForMatch>,
  contacts: Array<XeroContactForMatch>,
) => outcomes(matchClients(clients, contacts))

describe('nameKey', () => {
  test('lower-case, punctuation gone, spaces collapsed', () => {
    expect(nameKey('  JOHN   Smith!! ')).toBe('john smith')
  })

  test('sorts the words, so surname-first agrees', () => {
    expect(nameKey('Smith, John')).toBe(nameKey('John Smith'))
    expect(nameKey('Smith, John')).toBe('john smith')
  })

  test('& is "and"', () => {
    expect(nameKey('Smith & Sons')).toBe(nameKey('Smith and Sons'))
    expect(nameKey('Smith&Sons')).toBe(nameKey('smith AND sons'))
  })

  test.each([
    'Acme Pty Ltd',
    'ACME',
    'Acme Pty. Ltd.',
    'Acme Pty Limited',
    'Acme Limited',
    'Acme Ltd',
    'Acme Pty',
    'acme, pty ltd',
  ])('a trailing company ending goes: %s', (name) => {
    expect(nameKey(name)).toBe('acme')
  })

  test('only one ending, and only at the end', () => {
    expect(nameKey('Ltd Holdings')).toBe('holdings ltd')
    expect(nameKey('Acme Ltd Ltd')).toBe('acme ltd')
  })

  test('apostrophes and full stops join; other punctuation separates', () => {
    expect(nameKey("O'Brien")).toBe('obrien')
    expect(nameKey('O’Brien')).toBe('obrien')
    expect(nameKey('A.B. Plumbing')).toBe('ab plumbing')
    expect(nameKey('Smith-Jones')).toBe(nameKey('Smith Jones'))
  })

  test('accents are dropped', () => {
    expect(nameKey('Kévin Nguyễn')).toBe(nameKey('Kevin Nguyen'))
  })

  test('nothing left is empty', () => {
    expect(nameKey('')).toBe('')
    expect(nameKey('  ,.;  ')).toBe('')
    expect(nameKey('Pty Ltd')).toBe('')
  })
})

describe('accountNumberKey', () => {
  test.each([
    ['42', 42],
    ['0042', 42],
    [' 1916 ', 1916],
    ['0', 0],
  ])('%j → %j', (raw, expected) => {
    expect(accountNumberKey(raw)).toBe(expected)
  })

  test.each([
    undefined,
    '',
    '   ',
    'A42',
    '42a',
    '4 2',
    '-42',
    '42.0',
    '1e3',
    '99999999999999999999',
  ])('%j → null', (raw) => {
    expect(accountNumberKey(raw)).toBeNull()
  })
})

describe('matchClients', () => {
  describe('account number', () => {
    test('number and name agree → linked', () => {
      expect(
        match(
          [client('a', 'John Smith', { clientNumber: 42 })],
          [contact('x1', 'Smith, John', { accountNumber: '42' })],
        ),
      ).toEqual({ [id('a')]: 'linked@x1' })
    })

    test('leading zeros: "0042" is client #42', () => {
      expect(
        match(
          [client('a', 'John Smith', { clientNumber: 42 })],
          [contact('x1', 'John Smith', { accountNumber: '0042' })],
        ),
      ).toEqual({ [id('a')]: 'linked@x1' })
    })

    test('number and an email agree, the name does not → linked', () => {
      expect(
        match(
          [
            client('a', 'J Smith', {
              clientNumber: 42,
              emails: ['accounts@smith.example'],
            }),
          ],
          [
            contact('x1', 'Smith Holdings', {
              accountNumber: '42',
              email: 'Accounts@Smith.example',
            }),
          ],
        ),
      ).toEqual({ [id('a')]: 'linked@x1' })
    })

    test('the number alone → to check', () => {
      expect(
        match(
          [client('a', 'John Smith', { clientNumber: 42 })],
          [contact('x1', 'Mary Jones', { accountNumber: '42' })],
        ),
      ).toEqual({ [id('a')]: 'review:account_number_only@x1' })
    })

    test('the number alone loses to another contact with email AND name', () => {
      expect(
        match(
          [
            client('a', 'John Smith', {
              clientNumber: 42,
              emails: ['john@smith.example'],
            }),
          ],
          [
            contact('x1', 'Mary Jones', { accountNumber: '42' }),
            contact('x2', 'John Smith', { email: 'john@smith.example' }),
          ],
        ),
      ).toEqual({ [id('a')]: 'linked@x2' })
    })

    test('a number two contacts hold is no evidence', () => {
      expect(
        match(
          [client('a', 'John Smith', { clientNumber: 42 })],
          [
            contact('x1', 'Mary Jones', { accountNumber: '42' }),
            contact('x2', 'Peter Brown', { accountNumber: '0042' }),
          ],
        ),
      ).toEqual({ [id('a')]: 'new' })
    })

    test('a duplicated number falls through to the name', () => {
      expect(
        match(
          [client('a', 'John Smith', { clientNumber: 42 })],
          [
            contact('x1', 'John Smith', { accountNumber: '42' }),
            contact('x2', 'Peter Brown', { accountNumber: '42' }),
          ],
        ),
      ).toEqual({ [id('a')]: 'review:name_only@x1' })
    })

    test('a client without a number never matches one', () => {
      expect(
        match(
          [client('a', 'John Smith')],
          [contact('x1', 'Mary Jones', { accountNumber: '42' })],
        ),
      ).toEqual({ [id('a')]: 'new' })
    })

    test('a number that is not all digits is no evidence', () => {
      expect(
        match(
          [client('a', 'John Smith', { clientNumber: 42 })],
          [contact('x1', 'Mary Jones', { accountNumber: 'CUST-42' })],
        ),
      ).toEqual({ [id('a')]: 'new' })
    })
  })

  describe('email', () => {
    test('a unique email and the name → linked', () => {
      expect(
        match(
          [client('a', 'Acme', { emails: ['office@acme.example'] })],
          [
            contact('x1', 'Acme Pty Ltd', {
              email: ' OFFICE@acme.example ',
            }),
          ],
        ),
      ).toEqual({ [id('a')]: 'linked@x1' })
    })

    test('the contact person’s email counts as the client’s', () => {
      expect(
        match(
          [
            client('a', 'Acme', {
              emails: ['office@acme.example', 'jo@acme.example'],
            }),
          ],
          [contact('x1', 'ACME', { email: 'jo@acme.example' })],
        ),
      ).toEqual({ [id('a')]: 'linked@x1' })
    })

    test('a unique email alone → to check', () => {
      expect(
        match(
          [client('a', 'John Smith', { emails: ['js@example.com'] })],
          [contact('x1', 'Smith Family Trust', { email: 'js@example.com' })],
        ),
      ).toEqual({ [id('a')]: 'review:email_only@x1' })
    })

    test('of two unique emails, the one whose name agrees wins', () => {
      expect(
        match(
          [
            client('a', 'Acme', {
              emails: ['office@acme.example', 'jo@acme.example'],
            }),
          ],
          [
            contact('x1', 'Jo Bloggs', { email: 'office@acme.example' }),
            contact('x2', 'Acme Pty Ltd', { email: 'jo@acme.example' }),
          ],
        ),
      ).toEqual({ [id('a')]: 'linked@x2' })
    })

    test('an email two contacts share leaves only the name', () => {
      const contacts = [
        contact('x1', 'John Smith', { email: 'shared@example.com' }),
        contact('x2', 'Jane Smith', { email: 'shared@example.com' }),
      ]
      expect(
        match(
          [client('a', 'John Smith', { emails: ['shared@example.com'] })],
          contacts,
        ),
      ).toEqual({ [id('a')]: 'review:name_only@x1' })
      expect(
        match(
          [client('b', 'Bob Brown', { emails: ['shared@example.com'] })],
          contacts,
        ),
      ).toEqual({ [id('b')]: 'new' })
    })
  })

  describe('name', () => {
    test('the name alone → to check', () => {
      expect(
        match([client('a', 'Smith, John')], [contact('x1', 'John Smith')]),
      ).toEqual({ [id('a')]: 'review:name_only@x1' })
    })

    test('"Acme Pty Ltd" and "ACME" agree', () => {
      expect(
        match([client('a', 'ACME')], [contact('x1', 'Acme Pty Ltd')]),
      ).toEqual({ [id('a')]: 'review:name_only@x1' })
    })

    test('a name two contacts share → to check, name_shared, with the first by id', () => {
      expect(
        match(
          [client('a', 'John Smith')],
          [contact('x9', 'John Smith'), contact('x2', 'Smith, John')],
        ),
      ).toEqual({ [id('a')]: 'review:name_shared@x2' })
    })

    test('…the one whose phone agrees, however each writes it', () => {
      expect(
        match(
          [client('a', 'John Smith', { phone: '(08) 9345 6789' })],
          [
            contact('x1', 'John Smith', { phone: '08 9111 2222' }),
            contact('x2', 'John Smith', { phone: '+61 8 9345 6789' }),
          ],
        ),
      ).toEqual({ [id('a')]: 'review:name_shared@x2' })
    })

    test('…or the one whose place is the client’s suburb', () => {
      expect(
        match(
          [client('a', 'John Smith', { suburb: 'Nightcliff ' })],
          [
            contact('x1', 'John Smith', { place: 'Darwin' }),
            contact('x2', 'John Smith', { place: 'nightcliff' }),
          ],
        ),
      ).toEqual({ [id('a')]: 'review:name_shared@x2' })
    })

    test('…and the first when the tie-break picks out more than one, or none', () => {
      expect(
        match(
          [
            client('a', 'John Smith', {
              phone: '0412 345 678',
              suburb: 'Nightcliff',
            }),
            client('b', 'Jane Doe', { phone: '12 34' }),
          ],
          [
            contact('x3', 'John Smith', { phone: '0412 345 678' }),
            contact('x2', 'John Smith', { place: 'Nightcliff' }),
            contact('x4', 'Jane Doe', { phone: '1234' }),
            contact('x5', 'Jane Doe', { phone: '12 34' }),
          ],
        ),
      ).toEqual({
        [id('a')]: 'review:name_shared@x2',
        // Fewer than eight digits is no phone to go by.
        [id('b')]: 'review:name_shared@x4',
      })
    })

    test('…never one already another client’s while one is free', () => {
      // A took x1 by the holder's word. B, of the same name, is asked about
      // x2 — not x1 again, where Same could only be refused.
      expect(
        match(
          [
            client('a', 'John Smith', {
              decided: { state: 'linked', xeroContactId: 'x1' },
            }),
            client('b', 'John Smith', { phone: '08 9345 6789' }),
          ],
          [
            contact('x1', 'John Smith', { phone: '08 9345 6789' }),
            contact('x2', 'Smith, John'),
          ],
        ),
      ).toEqual({ [id('b')]: 'review:name_shared@x2' })
    })

    test('…and, with every one of them taken, a contest over the first', () => {
      expect(
        match(
          [
            client('a', 'John Smith', {
              decided: { state: 'linked', xeroContactId: 'x1' },
            }),
            client('b', 'John Smith', {
              decided: { state: 'linked', xeroContactId: 'x2' },
            }),
            client('c', 'John Smith'),
          ],
          [contact('x1', 'John Smith'), contact('x2', 'John Smith')],
        ),
      ).toEqual({ [id('c')]: 'review:contested@x1' })
    })

    test('an empty name matches nothing', () => {
      expect(match([client('a', '...')], [contact('x1', '-')])).toEqual({
        [id('a')]: 'new',
      })
    })

    test('nothing in common → new', () => {
      expect(
        match(
          [
            client('a', 'John Smith', {
              clientNumber: 7,
              emails: ['john@example.com'],
            }),
          ],
          [
            contact('x1', 'Mary Jones', {
              accountNumber: '8',
              email: 'mary@example.com',
            }),
          ],
        ),
      ).toEqual({ [id('a')]: 'new' })
    })
  })

  describe('contacts that are never candidates', () => {
    test.each(['ARCHIVED', 'GDPRREQUEST'] as const)('%s', (status) => {
      expect(
        match(
          [
            client('a', 'John Smith', {
              clientNumber: 42,
              emails: ['john@example.com'],
            }),
          ],
          [
            contact('x1', 'John Smith', {
              status,
              accountNumber: '42',
              email: 'john@example.com',
            }),
          ],
        ),
      ).toEqual({ [id('a')]: 'new' })
    })

    test('an archived contact does not make an active one’s number or email ambiguous', () => {
      expect(
        match(
          [
            client('a', 'John Smith', {
              clientNumber: 42,
              emails: ['john@example.com'],
            }),
          ],
          [
            contact('x1', 'John Smith', {
              accountNumber: '42',
              email: 'john@example.com',
            }),
            contact('x0', 'John Smith', {
              status: 'ARCHIVED',
              accountNumber: '42',
              email: 'john@example.com',
            }),
          ],
        ),
      ).toEqual({ [id('a')]: 'linked@x1' })
    })
  })

  describe('contests', () => {
    test('one contact proposed for two clients → both contested', () => {
      expect(
        match(
          [
            client('a', 'John Smith', { clientNumber: 1 }),
            client('b', 'Smith, John', { clientNumber: 2 }),
          ],
          [contact('x1', 'John Smith', { accountNumber: '1' })],
        ),
      ).toEqual({
        [id('a')]: 'review:contested@x1',
        [id('b')]: 'review:contested@x1',
      })
    })

    test('a contest between a link and a question is still a contest', () => {
      expect(
        match(
          [
            client('a', 'Acme', { emails: ['office@acme.example'] }),
            client('b', 'Bloggs', { emails: ['office@acme.example'] }),
          ],
          [contact('x1', 'Acme', { email: 'office@acme.example' })],
        ),
      ).toEqual({
        [id('a')]: 'review:contested@x1',
        [id('b')]: 'review:contested@x1',
      })
    })

    test('other clients are untouched by a contest', () => {
      expect(
        match(
          [
            client('a', 'John Smith'),
            client('b', 'John Smith'),
            client('c', 'Mary Jones'),
          ],
          [contact('x1', 'John Smith'), contact('x2', 'Mary Jones')],
        ),
      ).toEqual({
        [id('a')]: 'review:contested@x1',
        [id('b')]: 'review:contested@x1',
        [id('c')]: 'review:name_only@x2',
      })
    })
  })

  describe('decisions', () => {
    test('a decided client is not proposed again', () => {
      const proposals = matchClients(
        [
          client('a', 'John Smith', {
            decided: { state: 'linked', xeroContactId: 'x1' },
          }),
          client('b', 'Mary Jones', { decided: { state: 'separate' } }),
        ],
        [contact('x1', 'John Smith'), contact('x2', 'Mary Jones')],
      )
      expect(proposals).toEqual([])
    })

    test('a decided link reserves its contact: another client is asked, not linked', () => {
      expect(
        match(
          [
            client('a', 'Someone Else', {
              decided: { state: 'linked', xeroContactId: 'x1' },
            }),
            client('b', 'John Smith', { clientNumber: 42 }),
          ],
          [contact('x1', 'John Smith', { accountNumber: '42' })],
        ),
      ).toEqual({ [id('b')]: 'review:contested@x1' })
    })

    test('a reserved contact turns a question into a contest too', () => {
      expect(
        match(
          [
            client('a', 'Someone Else', {
              decided: { state: 'linked', xeroContactId: 'x1' },
            }),
            client('b', 'John Smith'),
          ],
          [contact('x1', 'John Smith')],
        ),
      ).toEqual({ [id('b')]: 'review:contested@x1' })
    })

    test('Different reserves nothing', () => {
      expect(
        match(
          [
            client('a', 'John Smith', { decided: { state: 'separate' } }),
            client('b', 'John Smith', { clientNumber: 42 }),
          ],
          [contact('x1', 'John Smith', { accountNumber: '42' })],
        ),
      ).toEqual({ [id('b')]: 'linked@x1' })
    })
  })

  describe('determinism', () => {
    const clients = [
      client('c', 'Mary Jones', { emails: ['mary@example.com'] }),
      client('a', 'John Smith', { clientNumber: 42 }),
      client('b', 'John Smith'),
      client('d', 'Nobody'),
    ]
    const contacts = [
      contact('x3', 'Mary Jones', { email: 'mary@example.com' }),
      contact('x1', 'John Smith', { accountNumber: '42' }),
      contact('x2', 'Smith, John'),
      contact('x4', 'Archived', { status: 'ARCHIVED' }),
    ]

    test('ordered by client id, whatever order they came in', () => {
      const forwards = matchClients(clients, contacts)
      const backwards = matchClients(
        [...clients].reverse(),
        [...contacts].reverse(),
      )
      expect(backwards).toEqual(forwards)
      expect(forwards.map((p) => p.clientId)).toEqual(
        ['a', 'b', 'c', 'd'].map(id),
      )
    })

    test('the same answer every time', () => {
      expect(match(clients, contacts)).toEqual({
        // a is x1 by number and name, but b's name is shared by x1 and x2,
        // so b is asked about the first of them — x1 — and x1, proposed
        // for two clients, makes both a question.
        [id('a')]: 'review:contested@x1',
        [id('b')]: 'review:contested@x1',
        [id('c')]: 'linked@x3',
        [id('d')]: 'new',
      })
    })

    test('nothing in, nothing out', () => {
      expect(matchClients([], [])).toEqual([])
      expect(match([client('a', 'John Smith')], [])).toEqual({
        [id('a')]: 'new',
      })
    })
  })

  test('a proposal carries the contact as given', () => {
    const x1 = contact('x1', 'John Smith', {
      accountNumber: '42',
      email: 'john@example.com',
      phone: '08 9123 4567',
      place: 'Nightcliff',
    })
    expect(
      matchClients([client('a', 'John Smith', { clientNumber: 42 })], [x1]),
    ).toEqual([{ clientId: id('a'), outcome: 'linked', contact: x1 }])
  })
})
