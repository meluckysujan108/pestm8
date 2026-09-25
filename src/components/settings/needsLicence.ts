import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Whether a person's missing licence number is something for this viewer to
 * do: they are on the team (active), and the viewer is either the one who
 * manages them — an owner's whole team, a contractor's own crew — or them.
 *
 * One rule for the hub's "N need licence" and the Team page's "No licence",
 * so the count and the badges it counts never disagree. A badge on someone
 * else's crew, or on the owner, is a licence somebody else has to chase:
 * not something that needs doing here (RowBadge's contract).
 */
export function needsLicence(
  member: {
    _id: Id<'memberships'>
    status: string
    canManage: boolean
    licenceNumber?: string
  },
  viewerMembershipId: Id<'memberships'>,
): boolean {
  return (
    member.status === 'active' &&
    (member.canManage || member._id === viewerMembershipId) &&
    !member.licenceNumber?.trim()
  )
}
