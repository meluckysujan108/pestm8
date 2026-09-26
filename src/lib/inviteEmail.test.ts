import { describe, expect, test } from 'vitest'
import { maskEmail } from '../../convex/lib/inviteTokens'
import { couldBeInvitee } from './inviteEmail'

/**
 * The invite pages' early warning. It must never turn away the invited
 * address — that would lock the owner-to-be out of their own link — and it
 * should catch an address the server is certain to refuse.
 */
describe('couldBeInvitee', () => {
  const invited = 'admin@getclientexperts.com.au'
  const hint = maskEmail(invited)

  test('accepts the invited address however it was typed', () => {
    expect(couldBeInvitee(invited, hint)).toBe(true)
    expect(couldBeInvitee('  Admin@GetClientExperts.com.au ', hint)).toBe(true)
  })

  test('refuses an address on another domain', () => {
    expect(couldBeInvitee('admin@gmail.com', hint)).toBe(false)
  })

  test('refuses another name on the same domain', () => {
    expect(couldBeInvitee('sujan@getclientexperts.com.au', hint)).toBe(false)
    // Same first letter, different length: the mask shows the length too.
    expect(couldBeInvitee('ab@getclientexperts.com.au', hint)).toBe(false)
  })

  test('refuses something that is not an address at all', () => {
    expect(couldBeInvitee('admin', hint)).toBe(false)
  })

  test('decides nothing without a hint', () => {
    expect(couldBeInvitee('anyone@anywhere.com', '')).toBe(true)
  })

  test('lets through an address the mask cannot tell apart', () => {
    // Same first letter, length and domain: passed here, refused by the
    // server. The check only ever claims "cannot be", never "is".
    expect(couldBeInvitee('abcde@getclientexperts.com.au', hint)).toBe(true)
  })
})
