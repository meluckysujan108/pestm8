import { Suspense } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import { EmptyState } from '#/components/primitives/EmptyState'
import {
  MemberSettings,
  memberName,
} from '#/components/settings/MemberAccessRow'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { TeamOwnerOnly } from '#/components/settings/TeamOwnerOnly'
import { useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'
import type { Id } from '../../../../../convex/_generated/dataModel'

/** How long the loader holds the navigation for its queries, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/team/$memberId')({
  // The management roster, which the page finds this person in — the same
  // entry the Team page reads, so coming from there it is already cached.
  // Only for whoever may read it (`access.me` is warm from the layout), and
  // never waited on past LOADER_WAIT_MS: with no signal a Convex query never
  // answers, and the page's placeholder is the better answer to that.
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    if (access?.caps['team.manage'] !== true) return
    return settleWithin(
      LOADER_WAIT_MS,
      warm(queryClient, rq.team(business._id), rq.invitations(business._id)),
    )
  },
  component: MemberPage,
})

function MemberPage() {
  // Live, not from the route: a switch into someone else's account drops
  // `team.manage` at the server, and the roster below with it.
  const canManageTeam = useCan('team.manage')

  if (!canManageTeam) {
    return (
      <MemberFrame title="Team member">
        <TeamOwnerOnly />
      </MemberFrame>
    )
  }
  // The header stays put while the roster loads — past the loader's two
  // seconds, with no signal, or after a Switch back that the loader never
  // warmed it for — rather than the whole page turning into its placeholder,
  // ‹ Team and all.
  return (
    <Suspense
      fallback={
        <MemberFrame title="Team member">
          <SectionPending />
        </MemberFrame>
      }
    >
      <MemberLoaded />
    </Suspense>
  )
}

function MemberLoaded() {
  const { business } = Route.useRouteContext()
  const { memberId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const { data: members } = useSuspenseQuery(rq.team(business._id))
  // Their unused links, which demoting or removing them withdraws. An older
  // backend sends no sender, so this reads as none.
  const { data: invitations } = useSuspenseQuery(rq.invitations(business._id))

  // By id from the address, so an old link, or someone since removed, lands
  // here rather than on another person's settings.
  const member = members.find((m) => m._id === (memberId as Id<'memberships'>))

  if (!member) {
    return (
      <MemberFrame title="Not found">
        <EmptyState
          title="They're no longer on your team."
          body="Whoever this link was for has left, or it was mistyped."
        />
      </MemberFrame>
    )
  }

  return (
    <MemberFrame title={memberName(member)}>
      <MemberSettings
        businessId={business._id}
        timezone={business.timezone}
        member={member}
        sentInvitations={
          invitations.filter(
            (i) =>
              i.state === 'valid' && i.invitedByMembershipId === member._id,
          ).length
        }
        others={members.filter(
          (m) => m._id !== member._id && m.status === 'active',
        )}
        onRemoved={() => {
          // Only from their page. The removal can resolve long after the
          // tap — on a slow connection, or queued offline and sent on
          // reconnect — and by then the owner may be somewhere else, which
          // this must not pull them away from (or replace in history).
          // latestLocation includes a navigation already under way.
          if (
            !router.latestLocation.pathname.endsWith(
              `/settings/team/${member._id}`,
            )
          ) {
            return
          }
          void navigate({
            to: '/$businessSlug/settings/team',
            params: { businessSlug: business.slug },
            // Their page is gone; back should not bring it up again.
            replace: true,
          })
        }}
      />
    </MemberFrame>
  )
}

/** The header and body every state of this page shares. */
function MemberFrame({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const { business } = Route.useRouteContext()
  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title={title}
        back={
          <BackLink
            to="/$businessSlug/settings/team"
            params={{ businessSlug: business.slug }}
          >
            Team
          </BackLink>
        }
      />
      <SettingsBody>{children}</SettingsBody>
    </>
  )
}
