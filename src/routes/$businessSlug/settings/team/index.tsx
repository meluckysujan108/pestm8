import { Suspense, useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Plus } from 'lucide-react'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import { TeamSection } from '#/components/settings/TeamSection'
import { TeamOwnerOnly } from '#/components/settings/TeamOwnerOnly'
import { BackLink, SettingsBody } from '#/components/settings/ui'
import { useCan } from '#/lib/access'
import { rq, settleWithin, warm } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { Access } from '#/lib/access'

/** How long the loader holds the navigation for its queries, at most. */
const LOADER_WAIT_MS = 2000

export const Route = createFileRoute('/$businessSlug/settings/team/')({
  // Opens the invite sheet on arrival — the set-up guide's "Invite your
  // team". Taken out of the URL as it opens, so Back does not reopen it.
  validateSearch: z.object({
    invite: z.boolean().optional().catch(undefined),
  }),
  // The roster and the invitations, which the page reads one after the other
  // — for whoever may see them. `access.me` is already in the cache (the
  // layout's beforeLoad warms it), so reading the capability here costs
  // nothing and keeps a technician from asking for a roster they cannot have.
  //
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and the page has its own placeholder for late data.
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
  component: TeamPage,
})

function TeamPage() {
  const { business } = Route.useRouteContext()
  // Read live, not from the route: an owner who switches into someone else's
  // account loses `team.manage` at the server that instant, and this follows.
  const canManageTeam = useCan('team.manage')
  const hydrated = useHydrated()
  const [inviteOpen, setInviteOpen] = useState(false)
  const { invite } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  useEffect(() => {
    if (!invite || !hydrated) return
    if (canManageTeam) setInviteOpen(true)
    void navigate({ search: {}, replace: true })
  }, [invite, hydrated, canManageTeam, navigate])

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Team"
        back={
          <BackLink
            to="/$businessSlug/settings"
            params={{ businessSlug: business.slug }}
          >
            Settings
          </BackLink>
        }
        action={
          canManageTeam && (
            // Disabled until hydrated: a tap before then opens nothing, and
            // the e2e suite waits on it turning enabled.
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => setInviteOpen(true)}
              className="relative tap-target flex h-9 items-center gap-1 rounded-full bg-red pl-2.5 pr-3.5 text-body font-semibold text-white shadow-red transition active:scale-[.95] disabled:opacity-50"
            >
              <Plus aria-hidden size={18} strokeWidth={2.2} />
              Invite
            </button>
          )
        }
      />

      <SettingsBody>
        {canManageTeam ? (
          // The header stays put while the roster loads.
          <Suspense fallback={<SectionPending />}>
            <TeamSection
              businessId={business._id}
              businessSlug={business.slug}
              inviteOpen={inviteOpen}
              onInviteOpenChange={setInviteOpen}
            />
          </Suspense>
        ) : (
          <TeamOwnerOnly />
        )}
      </SettingsBody>
    </>
  )
}
