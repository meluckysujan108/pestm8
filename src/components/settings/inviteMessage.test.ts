import { describe, expect, test } from 'vitest'
import { inviteMessage } from './InviteLinkCard'

const url = 'https://app.pestm8.test/join/abc'

describe('inviteMessage — the text an invite link goes out in', () => {
  test('says who is asking, and for which business', () => {
    expect(
      inviteMessage({
        url,
        businessName: 'Swan River Pest Co',
        inviterName: ' Jo Walker ',
      }),
    ).toBe(
      `Jo Walker has invited you to join Swan River Pest Co on PestM8. Set up your account here: ${url}`,
    )
  })

  test('the business alone, when the sender is not known', () => {
    expect(inviteMessage({ url, businessName: 'Swan River Pest Co' })).toBe(
      `You’re invited to join Swan River Pest Co on PestM8. Set up your account here: ${url}`,
    )
  })

  test('the plain wording, when neither is', () => {
    expect(inviteMessage({ url, inviterName: 'Jo', businessName: '  ' })).toBe(
      `Here’s your PestM8 invite: ${url}`,
    )
  })
})
