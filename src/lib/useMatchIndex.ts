import { useMemo } from 'react'
import { areaCodeOf } from '../../convex/lib/contactKeys'
import { matchIndexFor, oursFor } from '../../convex/lib/clientMatch'
import type { MatchIndex } from '../../convex/lib/clientMatch'
import type { NormalisedDirectory } from '#/lib/directory'

/**
 * The match index over the client list (lib/clientMatch.ts), built once per
 * answer (`matchIndexFor`): what the pickers find a number or an email by.
 * Left out of it, as never anyone's own: the business's number and email,
 * the person's own, and, for someone who manages the team, every active
 * member's (`oursFor`). Anyone else passes only their own: the roster keeps
 * the team's numbers from them, and leaving those out would say which they
 * are.
 */
export function useMatchIndex(
  directory: NormalisedDirectory,
  business: {
    state: string
    phone?: string
    email?: string
    membership: { phone?: string }
  },
  members: ReadonlyArray<{
    _id: string
    phone?: string
    email?: string
    status: 'active' | 'invited' | 'removed'
  }>,
  access: { membershipId: string; caps: { 'team.manage': boolean } },
): MatchIndex {
  const self = members.find((m) => m._id === access.membershipId)
  const seesTeam = access.caps['team.manage']
  const selfPhone = self?.phone ?? business.membership.phone
  const selfEmail = self?.email
  const ours = useMemo(
    () =>
      oursFor({
        business: { phone: business.phone, email: business.email },
        self: { phone: selfPhone, email: selfEmail },
        seesTeam,
        team: seesTeam ? members : null,
      }),
    [business.phone, business.email, selfPhone, selfEmail, seesTeam, members],
  )
  return useMemo(
    () =>
      matchIndexFor(directory, { areaCode: areaCodeOf(business.state), ours }),
    [directory, business.state, ours],
  )
}
