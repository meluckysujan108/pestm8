import { useMemo } from 'react'
import { canBookOnto } from '../../convex/lib/capabilities'
import { useAccess, useActing } from '#/lib/access'
import type { Role } from '../../convex/lib/capabilities'
import type { Id } from '../../convex/_generated/dataModel'

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  contractor: 'Contractor',
  subcontractor: 'Subcontractor',
}

export function roleLabel(role: Role): string {
  return ROLE_LABEL[role]
}

/** A person as a picker names them: their name, or their role when they have
 * not set one. Never their email — the roster does not carry it for everyone. */
export function personLabel(person: { name: string; role: Role }): string {
  return person.name || roleLabel(person.role)
}

/**
 * Who the caller may put a job onto, and which of those to preselect.
 *
 * Filtered by the roster's `bookable` flag, which the server computes with
 * `canDispatchTo` — the function the job mutations enforce — on the account
 * being worked in. So every option offered is one the server will accept: an
 * owner inside Kevin's account is offered Kevin, and a contractor their team.
 *
 * A backend from before that flag existed sends no `bookable` and enforces the
 * older rule instead, owner-or-yourself on the real person (`canBookOnto`), so
 * that is the fallback. The two deploy separately (CLAUDE.md), and a picker
 * that offered the newer, wider set to the older server would be offering
 * contractors their team only to have every booking refused.
 *
 * The default is the account being worked in when the caller may book onto
 * it, and the caller otherwise. It used to be the first row of the roster,
 * which is the oldest member: fine while the owner was hidden from everyone
 * else, and a refused booking for every subcontractor the moment he was not.
 */
export function useAssigneeOptions<
  T extends {
    _id: Id<'memberships'>
    role: Role
    status: string
    bookable?: boolean
  },
>(
  members: ReadonlyArray<T> | undefined,
): { options: Array<T>; preferred: string } {
  const access = useAccess()
  const acting = useActing()

  return useMemo(() => {
    const me = { _id: access.membershipId, role: access.role }
    const options = (members ?? []).filter(
      (m) => m.status === 'active' && (m.bookable ?? canBookOnto(me, m._id)),
    )
    const preferred =
      options.find((m) => m._id === acting.membershipId)?._id ??
      options.find((m) => m._id === me._id)?._id ??
      options.at(0)?._id ??
      ''
    return { options, preferred }
  }, [members, access.membershipId, access.role, acting.membershipId])
}
