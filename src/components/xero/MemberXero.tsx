import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Plug } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { RowPending } from '#/components/shell/Pending'
import { RowBadge, SettingsGroup, SettingsRow } from '#/components/settings/ui'
import { useCan } from '#/lib/access'
import { formatWhen } from '#/lib/format'
import { rq } from '#/lib/routeQueries'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * A member's own Xero on their page under Team, for the owner: which
 * organisation they connected, or that they haven't — read-only. Connecting
 * and disconnecting are the member's alone (the server takes them from
 * nobody else), and removing them from the team disconnects it.
 *
 * Said because every client in the business is copied into that
 * organisation, and stays there if they leave: the owner should be able to
 * see whose books hold the client list.
 *
 * The owner only (`business.manage`, which a switch into someone's account
 * drops), only for an active member who isn't the owner (whose Xero is the
 * business's), and only where this deployment is set up for Xero.
 */
export function MemberXero({
  businessId,
  membershipId,
  name,
  role,
  active,
  timezone,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  /** How they are named, for the footer. */
  name: string
  role: 'owner' | 'contractor' | 'subcontractor'
  active: boolean
  /** The business's, which "Since …" is told in. */
  timezone: string
}) {
  const canSee = useCan('business.manage')
  const applies = canSee && active && role !== 'owner'
  // The hub already holds this one: whether there is any Xero here at all.
  // 'skip' rather than `enabled` for both: a disabled query is still asked,
  // and `xero.memberStatus` refuses anyone but the owner.
  const xero = useQuery(
    applies ? rq.xeroStatus(businessId) : convexQuery(api.xero.status, 'skip'),
  ).data
  const shown = applies && xero?.configured === true && !xero.demo
  const theirs = useQuery(
    shown
      ? rq.xeroMemberStatus(businessId, membershipId)
      : convexQuery(api.xero.memberStatus, 'skip'),
  )

  if (!shown) return null

  return (
    <SettingsGroup
      title="Xero"
      footer={`Read-only. Only ${name} can connect or disconnect their Xero. It receives every client.`}
    >
      {theirs.data === undefined ? (
        theirs.isError ? (
          <div className="px-3.5 py-3">
            <LoadFailed what="their Xero" onRetry={() => theirs.refetch()} />
          </div>
        ) : (
          <RowPending label="Loading their Xero" />
        )
      ) : theirs.data === null || theirs.data.status === 'pending' ? (
        // Pending is a connect left half-way at Xero: nothing is connected
        // until they finish it.
        <SettingsRow icon={Plug} tint="grey" title="Not connected" />
      ) : theirs.data.status === 'needs_reconnect' ? (
        <SettingsRow
          icon={Plug}
          tint="amber"
          title={theirs.data.tenantName}
          badge={<RowBadge tone="amber">Reconnect needed</RowBadge>}
        />
      ) : (
        <SettingsRow
          icon={Plug}
          tint="blue"
          title={theirs.data.tenantName}
          subtitle={
            theirs.data.connectedAt === null
              ? undefined
              : `Since ${formatWhen(theirs.data.connectedAt, timezone)}`
          }
          value="Connected"
        />
      )}
    </SettingsGroup>
  )
}

/**
 * Whether removing this member takes a Xero connection with them, for the
 * line in the remove confirm. The owner's to know (`xero.memberStatus` is
 * owner-only); anyone else removing someone — a contractor, their own crew —
 * gets no line rather than a guess.
 */
export function useMemberXeroConnected(
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
  asking: boolean,
): boolean {
  const canSee = useCan('business.manage')
  // 'skip', not `enabled`: a disabled query is still asked, and refused.
  const theirs = useQuery(
    asking && canSee
      ? rq.xeroMemberStatus(businessId, membershipId)
      : convexQuery(api.xero.memberStatus, 'skip'),
  ).data
  return theirs?.status === 'connected' || theirs?.status === 'needs_reconnect'
}
