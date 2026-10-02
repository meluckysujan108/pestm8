import { describe, expect, test } from 'vitest'
import { deliveryState, withoutTabs } from './deliveryWords'

describe('withoutTabs', () => {
  // The sentences stored on delivery rows and audit entries before the tabs
  // went (30 Sept 2026), from convex/email.ts, lib/sendLimit.ts, reports.ts.
  test.each([
    [
      'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.',
      'Not sent: the PDF could not be prepared to attach. Open the PDF, then send it again.',
    ],
    [
      'Not sent: the report is too large to email, even with its photos made smaller. Share it from the PDF tab instead.',
      'Not sent: the report is too large to email, even with its photos made smaller. Use Share on the report instead.',
    ],
    [
      'Not sent: that is a lot of report emails in an hour. Send it again from the Email tab shortly.',
      'Not sent: that is a lot of report emails in an hour. Send it again shortly.',
    ],
    [
      'Not sent: the report was deleted before it went. If it is restored, send it again from its Email tab.',
      'Not sent: the report was deleted before it went. If it is restored, send it again.',
    ],
  ])('%s', (stored, shown) => {
    expect(withoutTabs(stored)).toBe(shown)
    expect(withoutTabs(stored)).not.toMatch(/\btab\b/i)
  })

  test('leaves a sentence with no tab in it alone', () => {
    const words = 'Marked as spam by the recipient'
    expect(withoutTabs(words)).toBe(words)
  })
})

describe('deliveryState', () => {
  const row = { waitingForEmailSetup: false }

  test('a sent email is sent, and nothing more is claimed', () => {
    expect(deliveryState({ ...row, status: 'sent' }, false)).toMatchObject({
      word: 'Sent',
      warn: false,
      retry: false,
    })
  })

  test('a queued email is on its way until it has plainly stopped', () => {
    expect(deliveryState({ ...row, status: 'queued' }, false)).toMatchObject({
      word: 'Sending…',
      sending: true,
      warn: false,
    })
    expect(deliveryState({ ...row, status: 'queued' }, true)).toMatchObject({
      word: 'Not sent',
      sending: false,
      warn: true,
      retry: true,
    })
  })

  test('with email not set up, it says so and offers no Send again', () => {
    const state = deliveryState(
      { status: 'queued', waitingForEmailSetup: true },
      true,
    )
    expect(state).toMatchObject({ word: 'Not sent', warn: true, retry: false })
    expect(state.next).toMatch(/isn’t set up/)
  })

  test('a failure says why, in words without the old tabs', () => {
    const state = deliveryState(
      {
        ...row,
        status: 'failed',
        error:
          'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.',
      },
      false,
    )
    expect(state).toMatchObject({ word: 'Failed', warn: true, retry: true })
    expect(state.next).toBe(
      'Not sent: the PDF could not be prepared to attach. Open the PDF, then send it again.',
    )
  })

  test('one an owner refused before approval was retired is not offered again', () => {
    expect(
      deliveryState({ ...row, status: 'failed', error: 'Not approved' }, false),
    ).toMatchObject({ word: 'Not approved', retry: false })
  })

  test('a bounce is a warning with a way to try again', () => {
    expect(deliveryState({ ...row, status: 'bounced' }, false)).toMatchObject({
      word: 'Bounced',
      warn: true,
      retry: true,
    })
  })
})
