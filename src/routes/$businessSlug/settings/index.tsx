import { Suspense, useEffect, useState } from 'react'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useRouteContext,
} from '@tanstack/react-router'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  Building2,
  FileText,
  IdCard,
  Info,
  ListChecks,
  ShieldCheck,
  SunMoon,
  User,
  Users,
} from 'lucide-react'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { Bone } from '#/components/shell/Pending'
import { ShowMyLicenceButton } from '#/components/settings/ShowMyLicence'
import { walletExpiry } from '#/components/settings/licenceExpiry'
import { needsLicence } from '#/components/settings/needsLicence'
import {
  useBusinessToday,
  useMyLicences,
} from '#/components/settings/useMyLicences'
import type { LicenceViewer } from '#/components/settings/needsLicence'
import {
  DANGER_ROW_CLASS,
  DangerGroup,
  ROW_CLASS,
  RowBadge,
  RowBody,
  SettingsBody,
  SettingsGroup,
  SettingsLinkRow,
} from '#/components/settings/ui'
import { useHiddenGuide } from '#/components/onboarding/SetupGuide'
import { useAccess, useActing, useCan } from '#/lib/access'
import { APP_VERSION } from '#/lib/appVersion'
import { roleLabel } from '#/lib/assignees'
import { authClient } from '#/lib/auth-client'
import { beginSignOut, forgetCachedPages } from '#/lib/rootState'
import { browserOnly, rq, settleWithin, warm } from '#/lib/routeQueries'
import { THEME_LABEL } from '#/lib/theme'
import { recoveryCodesUnsaved } from '#/lib/twoStepReminders'
import { useHydrated } from '#/lib/useHydrated'
import { useThemePref } from '#/lib/useTheme'
import type { Access } from '#/lib/access'
import type { Id } from '../../../../convex/_generated/dataModel'

/** How long the loader holds the navigation for its queries, at most. */
const LOADER_WAIT_MS = 2000

/**
 * Where each of the old tabs (`?seg=`) lives now. Bookmarks, the home-screen
 * app's last URL and links in old messages still carry them, and a redirect
 * is cheaper than a page that quietly ignores the part of the address that
 * said where to go.
 *
 * Profile was the old default tab — details, licence, two-step, Sign out —
 * and this hub is what took its place, not My details: that page has no
 * licence on it, and waits for the signed-in user, which with no signal
 * never answers. So it lands here, with the `seg` dropped.
 */
const SEGMENT_PAGE = {
  profile: '/$businessSlug/settings',
  team: '/$businessSlug/settings/team',
  prefs: '/$businessSlug/settings/business',
  reports: '/$businessSlug/settings/reports',
} as const

export const Route = createFileRoute('/$businessSlug/settings/')({
  validateSearch: z.object({
    // Lenient: a mistyped or stale tab opens the hub, not an error page.
    seg: z
      .enum(['profile', 'team', 'prefs', 'reports'])
      .optional()
      .catch(undefined),
  }),
  // Replaced, not pushed: Back from the page it lands on should leave
  // Settings, not bounce off this redirect again. Someone without the
  // capability lands on that page's own "only the owner" message. The search
  // goes, so the hub's own (profile) comes back through here with no `seg`.
  beforeLoad: ({ search, params }) => {
    if (search.seg) {
      throw redirect({
        to: SEGMENT_PAGE[search.seg],
        params: { businessSlug: params.businessSlug },
        search: {},
        replace: true,
      })
    }
  },
  // The signed-in user (the name and the rows' values), the licences "Show
  // my licence" opens (and the Licences row badges), for whoever may see it
  // the Team row's two lists, and for everyone but the owner the accounts
  // they may work in. `access.me` is already in the cache: the layout's
  // beforeLoad warms it, so reading the capability here costs nothing and
  // keeps a technician from asking for a roster they cannot have.
  //
  // Warmed, never waited on past LOADER_WAIT_MS: with no signal a Convex
  // query never answers, and this is where a technician on site opens the
  // licences kept on their phone to show an inspector. The page has its own
  // answer for late data (the name suspends on its own, every row's value
  // simply fills in, and the licence button falls back to the kept copy), so
  // the loader must not hold it back. The licences are warmed in the browser
  // only: they never go into the HTML (`keptOutOfHtml`), so on a full load
  // they arrive over the socket once the page is up.
  loader: ({ context: { queryClient, business, membership } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    const team = access?.caps['team.manage'] === true
    const owner = access?.caps['business.manage'] === true
    const switches = access !== undefined && !access.view
    return settleWithin(
      LOADER_WAIT_MS,
      warm(
        queryClient,
        rq.currentUser(),
        ...browserOnly(rq.memberLicences(business._id, membership._id)),
        ...(team ? [rq.team(business._id), rq.invitations(business._id)] : []),
        // The set-up guide's row, so it is there with the rest of the group
        // rather than arriving under a thumb.
        ...(owner ? [rq.setupGuide(business._id)] : []),
        ...(switches ? [rq.switchTargets(business._id)] : []),
      ),
    )
  },
  component: SettingsHub,
})

/**
 * Settings, as a list of places to go rather than a page of forms: who you
 * are (and whose accounts you may work in), then the pages about you, then
 * the business's (only those this person may use), then this device's
 * Appearance and About, and Sign out. Nothing here is edited in place; every
 * row opens its own page, and a row's value and badge say what is on it and
 * whether anything there needs doing, so the list can be read without opening
 * any of them.
 */
function SettingsHub() {
  const { business, membership } = Route.useRouteContext()
  const { businessSlug } = Route.useParams()
  const access = useAccess()
  const { isSwitched } = useActing()
  const canManageBusiness = useCan('business.manage')
  const canManageTeam = useCan('team.manage')
  const canManageTemplates = useCan('templates.manage')
  const hydrated = useHydrated()
  const { theme } = useRouteContext({ from: '__root__' })
  const [themePref] = useThemePref(theme)

  // The membership as it is now, not as the layout found it: route context is
  // a snapshot taken on the way in, so a licence number saved a moment ago on
  // its own page would still read "Missing" here. The layout's beforeLoad
  // already holds this query (and keeps it live), so reading it costs nothing.
  const live = useQuery(
    convexQuery(api.businesses.getBySlug, { slug: businessSlug }),
  ).data
  const me = live?.membership ?? membership
  const businessName = live?.name ?? business.name
  const licenceNumber = me.licenceNumber?.trim()
  const phone = me.phone?.trim()

  // This person's licences, live or — with no signal — as kept on this phone,
  // for Show my licence and the Licences row's badge. Read here, once, rather
  // than by each: the read is also what keeps the phone's copy up to date.
  const wallet = useMyLicences(business._id, membership._id).shown
  const today = useBusinessToday(live?.timezone ?? business.timezone)
  const expiring = walletExpiry(wallet?.licences ?? [], today)

  // Not suspended on, unlike the name at the top of the page: each row's value
  // fills in when it comes, and a row with no value yet still opens.
  const user = useQuery(rq.currentUser()).data
  const twoStepOn = user ? user.twoFactorEnabled === true : undefined

  // Codes shown at set-up but never confirmed saved (lib/twoStepReminders).
  // Read after hydration: the server has no browser storage to agree with.
  const [codesUnsaved, setCodesUnsaved] = useState(false)
  const userId = user?._id
  useEffect(() => {
    setCodesUnsaved(
      twoStepOn === true && userId !== undefined
        ? recoveryCodesUnsaved(userId)
        : false,
    )
  }, [twoStepOn, userId])

  // Each business row on the capability its page needs, not on a role: a
  // contractor manages their own team but not the business's details or
  // forms, so they get Team and nothing else. A row that opens onto a refusal
  // is worse than no row.
  const showReportsRow = canManageTemplates || canManageBusiness
  const hasBusinessRows = canManageBusiness || canManageTeam || showReportsRow

  // While a switch is open the server drops every administration capability,
  // so those rows are all gone; say why rather than leave an owner wondering
  // where his business went. Nobody else had any to lose.
  const switchedNote = !isSwitched
    ? null
    : access.role === 'owner'
      ? 'Switch back to your own account to change business settings.'
      : access.role === 'contractor'
        ? 'Switch back to your own account to manage your team.'
        : null

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker={businessName}
        title="Settings"
      />

      <SettingsBody>
        <SettingsGroup>
          <div className="px-3.5 py-3.5">
            <div className="flex items-center gap-3.5">
              {/* The name is the one thing on this page that waits for the
                  signed-in user, and with no signal that query never answers
                  — so it waits alone, and nothing else on the page (least of
                  all the licence button below) waits with it. */}
              <Suspense
                fallback={<Bone className="size-14 shrink-0 rounded-full" />}
              >
                <Avatar colour={me.colour} />
              </Suspense>
              <div className="min-w-0 flex-1">
                <Suspense
                  fallback={
                    <span className="flex h-[22px] items-center">
                      <Bone className="h-[17px] w-36" />
                    </span>
                  }
                >
                  <PersonName />
                </Suspense>
                <p className="truncate text-caption text-muted">
                  {roleLabel(access.role)} · {businessName}
                </p>
              </div>
            </div>
            {/* Straight from route context, never behind the name: this is
                what a technician on site with no signal taps to show an
                inspector their licence. Hidden when it renders nothing (no
                file to show), so the card is just the name. Its own boundary
                in case it ever reads with suspense, which must not take the
                page down with it. */}
            <div className="mt-3 empty:hidden">
              <Suspense fallback={null}>
                <ShowMyLicenceButton
                  businessId={business._id}
                  membershipId={membership._id}
                  wallet={wallet}
                  today={today}
                />
              </Suspense>
            </div>
          </div>
        </SettingsGroup>

        {/* The owner works in other accounts from the view menu beside the
            +, which lists every one of them; this is for everyone else. */}
        {!access.view && (
          <SwitchAccounts
            businessId={business._id}
            businessSlug={businessSlug}
          />
        )}

        <SettingsGroup title="You">
          <SettingsLinkRow
            to="/$businessSlug/settings/details"
            params={{ businessSlug }}
            icon={User}
            tint="blue"
            title="My details"
            value={phone || user?.email}
          />
          <SettingsLinkRow
            to="/$businessSlug/settings/licence"
            params={{ businessSlug }}
            icon={IdCard}
            tint="green"
            title="Licences"
            value={licenceNumber}
            // One badge, the most pressing first. The report number is
            // printed on every certificate they finalise, and finalising
            // refuses a blank one — so its absence outranks a licence that
            // has run out, which is a reminder and blocks nothing.
            badge={
              !licenceNumber ? (
                <RowBadge tone="amber">Missing</RowBadge>
              ) : expiring === 'expired' ? (
                <RowBadge tone="red">Expired</RowBadge>
              ) : expiring === 'soon' ? (
                <RowBadge tone="amber">Expiring</RowBadge>
              ) : undefined
            }
          />
          <SettingsLinkRow
            to="/$businessSlug/settings/sign-in"
            params={{ businessSlug }}
            icon={ShieldCheck}
            tint={twoStepOn ? 'green' : 'grey'}
            title="Two-step sign-in"
            value={
              twoStepOn === undefined ? undefined : twoStepOn ? 'On' : 'Off'
            }
            badge={
              codesUnsaved ? (
                <RowBadge tone="amber">Save codes</RowBadge>
              ) : undefined
            }
          />
        </SettingsGroup>

        {switchedNote && (
          <p className="mt-6 px-1 text-caption text-muted">{switchedNote}</p>
        )}

        {!isSwitched && hasBusinessRows && (
          <SettingsGroup title="Business">
            {canManageBusiness && (
              <GuideRow businessId={business._id} businessSlug={businessSlug} />
            )}
            {canManageBusiness && (
              <SettingsLinkRow
                to="/$businessSlug/settings/business"
                params={{ businessSlug }}
                icon={Building2}
                tint="orange"
                title="Business details"
                value={live?.state ?? business.state}
              />
            )}
            {canManageTeam && (
              <TeamRow
                businessId={business._id}
                businessSlug={businessSlug}
                viewer={access}
              />
            )}
            {showReportsRow && (
              <SettingsLinkRow
                to="/$businessSlug/settings/reports"
                params={{ businessSlug }}
                icon={FileText}
                tint="red"
                title="Reports"
              />
            )}
          </SettingsGroup>
        )}

        <SettingsGroup>
          <SettingsLinkRow
            to="/$businessSlug/settings/appearance"
            params={{ businessSlug }}
            icon={SunMoon}
            tint="blue"
            title="Appearance"
            value={THEME_LABEL[themePref]}
          />
          <SettingsLinkRow
            to="/$businessSlug/settings/about"
            params={{ businessSlug }}
            icon={Info}
            tint="grey"
            title="About"
            value={`Version ${APP_VERSION}`}
          />
        </SettingsGroup>

        <DangerGroup>
          <button
            type="button"
            // Before hydration this does nothing at all; disabled until it
            // can, like every other control that needs the script.
            disabled={!hydrated}
            onClick={async () => {
              // Before the request, so nothing kept on this phone for them
              // is written again while it is in flight (rootState.ts).
              beginSignOut()
              await authClient.signOut()
              await forgetCachedPages()
              // A full reload, not a soft navigation, so every cached query
              // and component tied to the old identity is gone rather than
              // briefly visible to whoever signs in next on this device.
              window.location.href = '/login'
            }}
            className={DANGER_ROW_CLASS}
          >
            Sign out
          </button>
        </DangerGroup>
      </SettingsBody>
    </>
  )
}

/**
 * The set-up guide, put away with work still left: one row to bring it back.
 * It returns to the schedule, where the guide lives, rather than opening a
 * page of its own here.
 */
function GuideRow({
  businessId,
  businessSlug,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
}) {
  const hidden = useHiddenGuide(businessId)
  const navigate = useNavigate()
  const setHidden = useConvexMutation(api.setupGuide.setHidden)
  const show = useMutation({
    mutationFn: () => setHidden({ businessId, hidden: false }),
    onSuccess: () =>
      navigate({ to: '/$businessSlug/schedule', params: { businessSlug } }),
  })
  if (!hidden) return null
  return (
    <button
      type="button"
      onClick={() => show.mutate()}
      disabled={show.isPending}
      className={ROW_CLASS}
    >
      <RowBody
        icon={ListChecks}
        tint="green"
        title="Set-up guide"
        subtitle={`${hidden.done} of ${hidden.total} done`}
        chevron
      />
    </button>
  )
}

/**
 * Team, with how many people are on it and the one thing most worth doing
 * there. Read without suspending: the row opens whether or not the counts
 * have arrived, and only someone who may manage the team reads the lists at
 * all (the server refuses them to anyone else).
 */
function TeamRow({
  businessId,
  businessSlug,
  viewer,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  /** The real person (`useAccess`), whom the licence rule is about. */
  viewer: LicenceViewer
}) {
  const members = useQuery(rq.team(businessId)).data
  const invitations = useQuery(rq.invitations(businessId)).data

  const active = members?.filter((m) => m.status === 'active')
  // Only people this person can do something about: an owner's whole team
  // and himself, a contractor's own crew and himself — the same rule the
  // Team page badges its rows by, so the count is what it shows.
  const needLicence =
    members?.filter((m) => needsLicence(m, viewer)).length ?? 0
  const invited = invitations?.length ?? 0

  return (
    <SettingsLinkRow
      to="/$businessSlug/settings/team"
      params={{ businessSlug }}
      icon={Users}
      tint="blue"
      title="Team"
      value={
        active === undefined
          ? undefined
          : `${active.length} ${active.length === 1 ? 'person' : 'people'}`
      }
      // One badge at most, the more pressing first: a technician who cannot
      // sign a certificate matters more than a link nobody has opened yet.
      badge={
        needLicence > 0 ? (
          <RowBadge tone="amber">
            {needLicence} {needLicence === 1 ? 'needs' : 'need'} licence
          </RowBadge>
        ) : invited > 0 ? (
          <RowBadge tone="grey">{invited} invited</RowBadge>
        ) : undefined
      }
    />
  )
}

/**
 * The accounts this person may work in — a contractor's own crew, or the
 * contractor a subcontractor has been let into — and nothing at all for
 * anyone with none. Also nothing while a switch is open: the server offers no
 * targets then (no chaining), and the banner carries the way back.
 *
 * A tap starts the switch and goes to the schedule, which is where their
 * account's work is; staying here would show only this person's own rows,
 * with the business ones gone. The banner that appears is the confirmation.
 */
function SwitchAccounts({
  businessId,
  businessSlug,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
}) {
  const navigate = useNavigate()
  const hydrated = useHydrated()
  const { data: targets } = useQuery(rq.switchTargets(businessId))

  // Nothing to invalidate afterwards: `access.me` and every gated query
  // resolve through `requireActor`, which reads the switch row, so the socket
  // re-pushes them the moment it is written.
  const convexStart = useConvexMutation(api.accountSwitches.start)
  const start = useMutation({
    mutationFn: (targetMembershipId: Id<'memberships'>) =>
      convexStart({ businessId, targetMembershipId }),
  })

  if (!targets || targets.length === 0) return null

  return (
    <SettingsGroup
      title="Work in another account"
      footer={
        start.isError ? (
          <span className="text-red-ink">
            That account couldn’t be opened. Try again.
          </span>
        ) : (
          'Work you do there is saved in their account, with a record that it was you.'
        )
      }
    >
      {targets.map((a) => (
        <button
          key={a.membershipId}
          type="button"
          // Also while one is starting, so a second tap cannot race the first.
          disabled={!hydrated || start.isPending}
          // The move to the schedule is on this call, not on the mutation: a
          // call's callbacks are dropped once this page unmounts, so a
          // switch that lands late — queued with no signal, say — does not
          // yank someone off whatever page they have gone on to.
          onClick={() =>
            start.mutate(a.membershipId, {
              onSuccess: () =>
                navigate({
                  to: '/$businessSlug/schedule',
                  params: { businessSlug },
                }),
            })
          }
          className={`${ROW_CLASS} disabled:opacity-50`}
        >
          <RowBody
            leading={
              <span
                aria-hidden
                className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
                style={{ backgroundColor: a.colour }}
              >
                {initialsOf(a.name) || '?'}
              </span>
            }
            title={a.name || roleLabel(a.role)}
            subtitle={a.name ? roleLabel(a.role) : undefined}
            value={
              start.isPending && start.variables === a.membershipId
                ? 'Opening…'
                : undefined
            }
            chevron
          />
        </button>
      ))}
    </SettingsGroup>
  )
}

/** The signed-in person as a round initial, in their schedule colour. */
function Avatar({ colour }: { colour?: string }) {
  const { data: user } = useSuspenseQuery(rq.currentUser())
  const initials = initialsOf(user.name || user.email)
  return (
    <span
      aria-hidden
      className={`flex size-14 shrink-0 items-center justify-center rounded-full text-[21px] font-semibold text-white ${colour ? '' : 'bg-blue'}`}
      style={colour ? { backgroundColor: colour } : undefined}
    >
      {initials || <User size={26} strokeWidth={1.8} />}
    </span>
  )
}

function PersonName() {
  const { data: user } = useSuspenseQuery(rq.currentUser())
  return (
    <p className="truncate text-row-title font-semibold text-ink">
      {user.name || user.email}
    </p>
  )
}

/** "Terence Hill" → "TH", "Kevin" → "K". */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = Array.from(words[0])[0] ?? ''
  const last =
    words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : ''
  return (first + last).toUpperCase()
}
