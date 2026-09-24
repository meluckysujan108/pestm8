import { describe, expect, it } from 'vitest'
import { SEND_ERROR, sendErrorCode, suggestedRecipients } from './SendSheet'

describe('the addresses the send sheet offers', () => {
  it('never chooses one that can never be delivered to', () => {
    // Saved on the client before addresses were checked, and put on the
    // sheet by the form's "send a copy to the client". Chosen, it read
    // "Needs approval" and then failed with no reason given.
    const [bad, good] = suggestedRecipients(
      ['bob@gmail', 'strata@office.com.au'],
      [],
      [],
    )
    expect(bad).toMatchObject({
      address: 'bob@gmail',
      chosen: false,
      fix: 'bob@gmail.com',
    })
    expect(bad.problem).toMatch(/\.com/)
    expect(good).toMatchObject({ chosen: true, problem: null, fix: null })
  })

  it('still chooses only what the form asked for, once each', () => {
    const list = suggestedRecipients(
      ['a@x.com.au'],
      ['a@x.com.au', 'b@y.com.au'],
      ['a@x.com.au'],
    )
    expect(list.map((r) => [r.address, r.chosen, r.known])).toEqual([
      ['a@x.com.au', true, true],
      ['b@y.com.au', false, false],
    ])
  })
})

describe('what a failed send says', () => {
  it('names an address the server refused, not "could not send"', () => {
    expect(sendErrorCode({ data: 'INVALID_EMAIL' })).toBe('INVALID_EMAIL')
    expect(
      sendErrorCode(
        new Error(
          '[CONVEX A(email:sendReportPdf)] Uncaught ConvexError: INVALID_EMAIL',
        ),
      ),
    ).toBe('INVALID_EMAIL')
    expect(SEND_ERROR.INVALID_EMAIL).toMatch(/can’t receive email/)
  })

  it('keeps the codes it already knew, and UNKNOWN for the rest', () => {
    expect(sendErrorCode(new Error('EMAIL_NOT_CONFIGURED'))).toBe(
      'EMAIL_NOT_CONFIGURED',
    )
    expect(sendErrorCode(new Error('socket hang up'))).toBe('UNKNOWN')
    expect(sendErrorCode({ data: 'SOMETHING_NEW' })).toBe('UNKNOWN')
  })
})
