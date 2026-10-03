import { describe, expect, test } from 'vitest'
import { fieldsOf, getTemplate } from '#/lib/reportTemplates'
import {
  clientToggleOf,
  lockEmail,
  lockEmailSentences,
  sentenceText,
  typedAddressesOf,
  withAddress,
  answersFor,
  deliveryProblems,
  deliveryQuestionsOf,
  lockRecipients,
} from './lockEmail'
import { askedAtLock } from '#/lib/reportTemplates/delivery'
import type { SendingKnown } from './lockEmail'

/**
 * What the sheet that locks a report says about the email locking sends.
 *
 * The rule is the server's (`queueFormDeliveries`): who the form asks for,
 * less anyone who can never be delivered to, all in one email as soon as it
 * locks — nothing waits for an owner — with any address that is not on the
 * client's record pointed out; the business's copy rides blind on what goes.
 * These pin the sheet to that rule, and pin what it SAYS in each case — the
 * words are the feature.
 */

const template = getTemplate('serviceReport')

const known: SendingKnown = {
  addresses: ['jane@gmail.com', 'info@pestm8.com.au'],
  copy: 'info@pestm8.com.au',
}

/** `known`, with more of the client's contacts on file. */
function onFile(...addresses: Array<string>): SendingKnown {
  return { ...known, addresses: [...known.addresses, ...addresses] }
}

function say(
  data: Record<string, unknown>,
  clientEmail: string | undefined,
  answer: SendingKnown = known,
  emailReady = true,
) {
  return lockEmailSentences(
    lockEmail(template, data, clientEmail, answer),
    emailReady,
    {
      clientToggle: clientToggleOf(template, data, clientEmail),
      clientHasEmail: Boolean(clientEmail),
    },
  )
    .map(sentenceText)
    .join(' ')
}

describe('the switch on the sheet', () => {
  test('is the form’s own send-copy question, for the client on file', () => {
    expect(
      clientToggleOf(template, { sendCopy: true }, 'Jane@Gmail.com'),
    ).toEqual({
      key: 'sendCopy',
      address: 'jane@gmail.com',
      on: true,
      problem: null,
    })
  })

  test('is not offered when the client has no email to send to', () => {
    expect(clientToggleOf(template, { sendCopy: false }, undefined)).toBeNull()
  })

  test('knows an address that can never be delivered to', () => {
    expect(
      clientToggleOf(template, { sendCopy: true }, 'bob@gmail')?.problem,
    ).not.toBeNull()
  })
})

describe('what locking will email', () => {
  test('the client, with the business’s copy — the everyday case', () => {
    expect(
      lockEmail(template, { sendCopy: true }, 'jane@gmail.com', known),
    ).toEqual({
      sending: ['jane@gmail.com'],
      newAddresses: [],
      undeliverable: [],
      stillTyped: null,
      copy: 'info@pestm8.com.au',
    })
    expect(say({ sendCopy: true }, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com. A copy goes to info@pestm8.com.au.',
    )
  })

  test('switched off, nothing goes and nothing is copied', () => {
    const plan = lockEmail(
      template,
      { sendCopy: false },
      'jane@gmail.com',
      known,
    )
    expect(plan.sending).toEqual([])
    // A copy rides on an email; with no email there is no copy.
    expect(plan.copy).toBeNull()
    expect(say({ sendCopy: false }, 'jane@gmail.com')).toBe(
      'Not emailed. You can send it from the report once it’s locked.',
    )
  })

  test('switched off, but typed into “Email Report To” too — it still goes, and says why', () => {
    const data = { sendCopy: false, emailReportTo: ['jane@gmail.com'] }
    expect(lockEmail(template, data, 'jane@gmail.com', known).stillTyped).toBe(
      'jane@gmail.com',
    )
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com. jane@gmail.com is also in “Email Report To”, so it still gets it. A copy goes to info@pestm8.com.au.',
    )
  })

  test('the business’s copy is not added when the business is the one being emailed', () => {
    expect(
      lockEmail(template, { sendCopy: true }, 'info@pestm8.com.au', known).copy,
    ).toBeNull()
  })

  test('a business with no copy address says nothing about a copy', () => {
    expect(
      say({ sendCopy: true }, 'jane@gmail.com', { ...known, copy: null }),
    ).toBe('Once it’s locked, it’s emailed to jane@gmail.com.')
  })

  test('an address typed into the form joins the client, in the form’s order', () => {
    expect(
      say(
        {
          sendCopy: true,
          emailReportTo: ['strata@example.com', 'agent@example.com'],
        },
        'jane@gmail.com',
        onFile('strata@example.com', 'agent@example.com'),
      ),
    ).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com, strata@example.com and agent@example.com. A copy goes to info@pestm8.com.au.',
    )
  })

  test('an address nobody has on file goes with the client, and the sheet asks for a second look', () => {
    const data = { sendCopy: true, emailReportTo: ['strata@example.com'] }
    const plan = lockEmail(template, data, 'jane@gmail.com', known)
    // One email, nothing held: approval was retired on 29 Sept 2026.
    expect(plan.sending).toEqual(['jane@gmail.com', 'strata@example.com'])
    expect(plan.newAddresses).toEqual(['strata@example.com'])
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com and strata@example.com. strata@example.com isn’t on the client’s record — check it’s right. A copy goes to info@pestm8.com.au.',
    )
  })

  test('with the client switched off, a new address still goes, with the copy', () => {
    const data = { sendCopy: false, emailReportTo: ['strata@example.com'] }
    const plan = lockEmail(template, data, 'jane@gmail.com', known)
    expect(plan.sending).toEqual(['strata@example.com'])
    expect(plan.copy).toBe('info@pestm8.com.au')
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to strata@example.com. strata@example.com isn’t on the client’s record — check it’s right. A copy goes to info@pestm8.com.au.',
    )
  })

  test('two new addresses are asked about together', () => {
    const data = {
      sendCopy: true,
      emailReportTo: ['strata@example.com', 'agent@example.com'],
    }
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com, strata@example.com and agent@example.com. strata@example.com and agent@example.com aren’t on the client’s record — check they’re right. A copy goes to info@pestm8.com.au.',
    )
  })

  test('a new address, one still typed and one that can’t be delivered are said together, in order', () => {
    const data = {
      sendCopy: false,
      emailReportTo: ['jane@gmail.com', 'strata@example.com', 'bob@gmail'],
    }
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com and strata@example.com. jane@gmail.com is also in “Email Report To”, so it still gets it. strata@example.com isn’t on the client’s record — check it’s right. bob@gmail can’t receive email, so it’s left out. A copy goes to info@pestm8.com.au.',
    )
  })

  test('an address that can never be delivered to is left out, and says so', () => {
    const plan = lockEmail(template, { sendCopy: true }, 'bob@gmail', known)
    expect(plan.sending).toEqual([])
    expect(say({ sendCopy: true }, 'bob@gmail')).toBe(
      'Not emailed: bob@gmail can’t receive email. Fix the address, then send it from the report once it’s locked.',
    )
    expect(
      say(
        { sendCopy: true, emailReportTo: ['strata@example.com'] },
        'bob@gmail',
        onFile('strata@example.com'),
      ),
    ).toBe(
      'Once it’s locked, it’s emailed to strata@example.com. bob@gmail can’t receive email, so it’s left out. A copy goes to info@pestm8.com.au.',
    )
  })

  test('a client with no email is told why nothing goes', () => {
    expect(say({ sendCopy: false }, undefined)).toBe(
      'Not emailed: the client has no email address on file. You can send it from the report once it’s locked.',
    )
  })

  test('without email set up, nothing is promised', () => {
    expect(say({ sendCopy: true }, 'jane@gmail.com', known, false)).toBe(
      'Email isn’t set up for this business yet, so it won’t be emailed. Share the PDF from the report once it’s locked.',
    )
  })

  test('addresses are kept apart from the words, so they can be set bold', () => {
    const [sentence] = lockEmailSentences(
      lockEmail(template, { sendCopy: true }, 'jane@gmail.com', known),
      true,
      { clientToggle: null, clientHasEmail: true },
    )
    expect(sentence).toEqual([
      'Once it’s locked, it’s emailed to ',
      { address: 'jane@gmail.com' },
      '.',
    ])
  })
})

describe('the addresses typed into the form, on the sheet', () => {
  test('are listed once each, lower-cased, in the form’s order, with their box', () => {
    expect(
      typedAddressesOf(template, {
        emailReportTo: [
          ' Strata@Example.com',
          'agent@example.com',
          'strata@example.com',
          '',
        ],
      }),
    ).toEqual([
      { key: 'emailReportTo', address: 'strata@example.com' },
      { key: 'emailReportTo', address: 'agent@example.com' },
    ])
    // A form's first version kept one address as a plain string.
    expect(
      typedAddressesOf(template, { emailReportTo: 'agent@example.com' }),
    ).toEqual([{ key: 'emailReportTo', address: 'agent@example.com' }])
    expect(typedAddressesOf(template, {})).toEqual([])
  })

  test('can each be taken off, and put back', () => {
    const value = ['Strata@Example.com', 'agent@example.com']
    const off = withAddress(value, 'strata@example.com', false)
    expect(off).toEqual(['agent@example.com'])
    expect(withAddress(off, 'strata@example.com', true)).toEqual([
      'agent@example.com',
      'strata@example.com',
    ])
    expect(
      withAddress('agent@example.com', 'agent@example.com', false),
    ).toEqual([])
  })

  test('taken off, is not emailed when it locks', () => {
    const data = {
      sendCopy: true,
      emailReportTo: withAddress(
        ['strata@example.com'],
        'strata@example.com',
        false,
      ),
    }
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com. A copy goes to info@pestm8.com.au.',
    )
  })
})

describe('who it goes to, chosen on the sheet that locks it', () => {
  const people = [
    {
      address: 'jane@gmail.com',
      name: 'Jane Nguyen',
      kind: 'client' as const,
      role: null,
      primary: false,
    },
    {
      address: 'kim@coastalagents.com.au',
      name: 'Kim Wu',
      kind: 'contact' as const,
      role: 'Property manager',
      primary: false,
    },
    {
      address: 'bob@strata.com.au',
      name: 'Bob Lee',
      kind: 'contact' as const,
      role: null,
      primary: true,
    },
  ]
  const rows = (data: Record<string, unknown>, listed: Array<string> = []) =>
    lockRecipients({
      template,
      data,
      people,
      clientEmail: 'jane@gmail.com',
      knownAddresses: known.addresses,
      listed,
    })

  test('is not asked on the form: the send-copy question, the box, and its note', () => {
    const fields = fieldsOf(template)
    expect(
      fields.filter((field) => askedAtLock(field, fields)).map((f) => f.key),
    ).toEqual(['sendCopy', 'emailReportTo', 'emailReportToWarning'])
    const timber = getTemplate('timberPestInspection')
    const timberFields = fieldsOf(timber)
    expect(
      timberFields
        .filter((field) => askedAtLock(field, timberFields))
        .map((f) => f.key)
        .sort(),
    ).toEqual(['emailReportTo', 'emailReportToWarning', 'sendCopyToClient'])
  })

  test('offers the client, then their contacts, primary first, by name and role', () => {
    expect(
      rows({ sendCopy: true }).map((row) => [
        row.address,
        row.on,
        row.who?.name,
        row.who?.role,
      ]),
    ).toEqual([
      ['jane@gmail.com', true, 'Jane Nguyen', 'Client'],
      ['bob@strata.com.au', false, 'Bob Lee', 'Primary contact'],
      ['kim@coastalagents.com.au', false, 'Kim Wu', 'Property manager'],
    ])
  })

  test('lists anyone typed in, ticked, and keeps them listed once unticked', () => {
    const data = { sendCopy: false, emailReportTo: ['agent@example.com'] }
    const typed = rows(data).find((row) => row.address === 'agent@example.com')
    expect(typed).toMatchObject({ on: true, who: null, known: false })
    const off = rows({ sendCopy: false }, ['agent@example.com']).find(
      (row) => row.address === 'agent@example.com',
    )
    expect(off).toMatchObject({ on: false })
  })

  test('writes the client to the send-copy question, and everyone else into the box', () => {
    const questions = deliveryQuestionsOf(template, {})
    expect(questions).toEqual({
      sendCopyKey: 'sendCopy',
      boxKeys: ['emailReportTo'],
    })
    expect(
      answersFor(
        questions,
        {},
        { address: 'jane@gmail.com', isClient: true },
        true,
      ),
    ).toEqual({ sendCopy: true })
    expect(
      answersFor(
        questions,
        { emailReportTo: ['agent@example.com'] },
        { address: 'kim@coastalagents.com.au', isClient: false },
        true,
      ),
    ).toEqual({
      emailReportTo: ['agent@example.com', 'kim@coastalagents.com.au'],
    })
    expect(
      answersFor(
        questions,
        { emailReportTo: ['agent@example.com', 'kim@coastalagents.com.au'] },
        { address: 'agent@example.com', isClient: false },
        false,
      ),
    ).toEqual({ emailReportTo: ['kim@coastalagents.com.au'] })
  })

  test('unticking the client takes them out of the box too: off is off', () => {
    const questions = deliveryQuestionsOf(template, {})
    const data = { sendCopy: true, emailReportTo: ['Jane@Gmail.com'] }
    expect(rows(data)[0]).toMatchObject({ address: 'jane@gmail.com', on: true })
    const answers = answersFor(
      questions,
      data,
      { address: 'jane@gmail.com', isClient: true },
      false,
    )
    expect(answers).toEqual({ sendCopy: false, emailReportTo: [] })
    expect(say({ ...data, ...answers }, 'jane@gmail.com')).not.toContain(
      'jane@gmail.com',
    )
  })

  test('stops the lock for an address in the box that can never be delivered to', () => {
    expect(
      deliveryProblems(template, { emailReportTo: ['bob@gmail'] }),
    ).toEqual([
      'bob@gmail can’t receive email — untick it, or use the address meant.',
    ])
    expect(
      deliveryProblems(template, { emailReportTo: ['bob@gmail.com'] }),
    ).toEqual([])
  })
})

describe('a report with more photos than an email carries', () => {
  const sayLarge = (data: Record<string, unknown>) =>
    lockEmailSentences(
      lockEmail(template, data, 'jane@gmail.com', known),
      true,
      {
        clientToggle: clientToggleOf(template, data, 'jane@gmail.com'),
        clientHasEmail: true,
        largeForEmail: true,
      },
    )
      .map(sentenceText)
      .join(' ')

  test('says, before the lock sends it, that the email carries smaller photos', () => {
    expect(sayLarge({ sendCopy: true })).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com. A copy goes to info@pestm8.com.au. It’s too big to email as it is, so the email carries a copy with smaller photos. The report keeps them full size.',
    )
  })

  test('says nothing about it when nothing is emailed', () => {
    expect(sayLarge({ sendCopy: false })).toBe(
      'Not emailed. You can send it from the report once it’s locked.',
    )
  })
})
