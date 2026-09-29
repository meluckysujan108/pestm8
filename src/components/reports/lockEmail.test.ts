import { describe, expect, test } from 'vitest'
import { getTemplate } from '#/lib/reportTemplates'
import {
  clientToggleOf,
  lockEmail,
  lockEmailSentences,
  sentenceText,
} from './lockEmail'
import type { SendingKnown } from './lockEmail'

/**
 * What the sheet that locks a report says about the email locking sends.
 *
 * The rule is the server's (`queueFormDeliveries`): who the form asks for,
 * less anyone who can never be delivered to; the addresses on file go at
 * once and any other waits for an owner, as a delivery of its own; the
 * business's copy rides blind on what goes. These pin the sheet to that rule,
 * and pin what it SAYS in each case — the words are the feature.
 */

const template = getTemplate('serviceReport')

const known: SendingKnown = {
  addresses: ['jane@gmail.com', 'info@pestm8.com.au'],
  unrestricted: false,
  copy: 'info@pestm8.com.au',
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
      held: [],
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
        { ...known, unrestricted: true },
      ),
    ).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com, strata@example.com and agent@example.com. A copy goes to info@pestm8.com.au.',
    )
  })

  test('an address nobody has on file waits for the owner, and the client’s copy does not wait with it', () => {
    const data = { sendCopy: true, emailReportTo: ['strata@example.com'] }
    const plan = lockEmail(template, data, 'jane@gmail.com', known)
    expect(plan.sending).toEqual(['jane@gmail.com'])
    expect(plan.held).toEqual(['strata@example.com'])
    // No approval is promised: the app has nowhere to give one. The owner
    // sending it from the report is what can actually happen.
    expect(say(data, 'jane@gmail.com')).toBe(
      'Once it’s locked, it’s emailed to jane@gmail.com. strata@example.com isn’t on the client’s record, so that email waits for the owner. They can send it from the report. A copy goes to info@pestm8.com.au.',
    )
  })

  test('with only a held address, nothing goes at once and nothing is copied yet', () => {
    const data = { sendCopy: false, emailReportTo: ['strata@example.com'] }
    const plan = lockEmail(template, data, 'jane@gmail.com', known)
    expect(plan.sending).toEqual([])
    expect(plan.copy).toBeNull()
    expect(say(data, 'jane@gmail.com')).toBe(
      'strata@example.com isn’t on the client’s record, so that email waits for the owner. They can send it from the report.',
    )
  })

  test('an owner is never held', () => {
    const data = { sendCopy: true, emailReportTo: ['strata@example.com'] }
    expect(
      lockEmail(template, data, 'jane@gmail.com', {
        ...known,
        unrestricted: true,
      }).held,
    ).toEqual([])
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
        { ...known, unrestricted: true },
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
