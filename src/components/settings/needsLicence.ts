import type { Id } from '../../../convex/_generated/dataModel'
import type { Role } from '../../../convex/lib/capabilities'

/** The person looking, as the licence rules need them: the real person
 * (`useAccess`), which is who `memberships.setLicence` decides on. */
export type LicenceViewer = {
  membershipId: Id<'memberships'>
  role: Role
}

/**
 * Whether this viewer may type in this person's licence number — the server's
 * rule (`memberships.setLicence`): the owner sets anyone's, everyone else only
 * their own.
 */
export function canSetLicence(
  member: { _id: Id<'memberships'> },
  viewer: LicenceViewer,
): boolean {
  return viewer.role === 'owner' || member._id === viewer.membershipId
}

/**
 * Whether a person's missing licence number is something for this viewer to
 * do: they are on the team (active), and the viewer either may type it in
 * (`canSetLicence`) or manages them — an owner's whole team, a contractor's
 * own crew, who cannot type it in for them but is the one to chase it.
 *
 * One rule for the hub's "N need licence", the Team page's "No licence" and
 * the warning on a person's own page, so the count and the badges it counts
 * never disagree. A badge on someone else's crew, or on the owner, is a
 * licence somebody else has to chase: not something that needs doing here
 * (RowBadge's contract).
 */
export function needsLicence(
  member: {
    _id: Id<'memberships'>
    status: string
    canManage: boolean
    licenceNumber?: string
  },
  viewer: LicenceViewer,
): boolean {
  return (
    member.status === 'active' &&
    (canSetLicence(member, viewer) || member.canManage) &&
    !member.licenceNumber?.trim()
  )
}
