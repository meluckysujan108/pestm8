import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import {
  convexQuery,
  useConvexAction,
  useConvexMutation,
} from '@convex-dev/react-query'
import { ChevronRight, LoaderCircle, Plug } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
} from '#/components/primitives/EmptyState'
import {
  LINK_BUTTON,
  NEUTRAL_BUTTON,
  NEUTRAL_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { BarMeter } from '#/components/primitives/BarMeter'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { useLatest } from '#/components/forms/SaveWarnings'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import {
  BackLink,
  DANGER_ROW_CLASS,
  DangerGroup,
  IconTile,
  ROW_CLASS,
  RowBadge,
  SettingsBody,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
} from '#/components/settings/ui'
import { useAccess, useActing, useCan } from '#/lib/access'
import { formatWhen } from '#/lib/format'
import { isOffline } from '#/lib/online'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import {
  DIFFERENT_CAPTION,
  DISCONNECT_ERROR_COPY,
  EXPLAINER,
  FINISH_ERROR_COPY,
  NOT_SENT_CAPTION,
  REMATCH_ERROR_COPY,
  SYNC_PAUSED,
  TWO_STEP_FIRST,
  TWO_STEP_SUGGESTED,
  backfillCopy,
  backfillHeldCopy,
  disclosureCopy,
  matchProblemCopy,
  matchRetry,
  pauseCopy,
  problemCopy,
  problemHeading,
  recentFooterCopy,
  startErrorCopy,
  syncProblemCopy,
  waitingCount,
  xeroReturnCopy,
} from './xeroCopy'
import { syncOf } from './syncView'
import type { MatchStage, XeroKind } from './xeroCopy'
import type { SyncProblem, SyncSummary } from './syncView'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'

/** What `xero.status` answers: never a token, only what the screen shows. */
export type XeroStatus = FunctionReturnType<typeof api.xero.status>
/** One connection, as the screen sees it (`XeroView` in convex/xero.ts). */
export type XeroView = NonNullable<XeroStatus['business']>

/** Where Xero's sign-in lives. The browser leaves for nowhere else. */
const XERO_SIGN_IN_ORIGIN = 'https://login.xero.com'

/** How long Connect Xero says "Opening Xero…" once it has Xero's address,
 * if the page is still here — Xero opened over it, and was closed. */
const OPENING_RESET_MS = 10_000

type Business = {
  _id: Id<'businesses'>
  slug: string
  name: string
  /** Where address suggestions lean, in a client opened from the page. */
  state: string
}

/**
 * A client's sheet, opened over the page from Recent problems, so a refused
 * email can be put right where it was read about. Loaded when first opened:
 * a Xero page opened to look never needs it.
 */
const ClientSheet = lazy(() =>
  import('#/components/clients/ClientSheet').then((m) => ({
    default: m.ClientSheet,
  })),
)

/** The search a Xero page is opened with on the way back from Xero. */
export type XeroSearch = {
  /** The finish token (`xero.finishConnect`): the callback accepted the
   * organisation, and this page finishes the connection as the person
   * signed in here. Single use, 15 minutes. */
  finish?: string
  /** Why Xero sent the browser back without one (`XERO_RETURN_COPY`). */
  xero?: string
}

/**
 * Settings → Xero (the business's organisation, the owner's to connect) and
 * Settings → My Xero (a member's own organisation, for invoicing from their
 * own books). One page for both: they differ only in who may use them and
 * in what connecting says it does.
 *
 * Release 1 connects and disconnects. Release 2 reads the organisation's
 * contacts once connected and says what it made of them, with the way to
 * the match page (`MatchReview.tsx`). Release 3 sends, once Start syncing
 * has been pressed there: from then on the page says how the sending
 * stands — how many clients are in Xero, what waits, what Xero refused —
 * where it said the match's counts. Before that it says nothing is sent.
 *
 * Connect Xero is a tap, not a hold (design system, Hold to act): it hands
 * over to Xero's own sign-in, which asks again before anything is shared. It
 * leaves in the same window, so Xero sends the browser back here — to the
 * callback first, which hands this page a single-use `finish` token. That
 * token is finished as whoever is signed in here, and the server refuses it
 * from anyone but the person who started (convex/xero.ts says what that does
 * and doesn't guard against).
 */
export function XeroPage({
  kind,
  business,
  search,
  onSearchDone,
}: {
  kind: XeroKind
  business: Business
  search: XeroSearch
  /** Clears `finish` and `xero` from the address, replacing the entry. */
  onSearchDone: () => void
}) {
  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title={kind === 'business' ? 'Xero' : 'My Xero'}
        back={
          <BackLink
            to="/$businessSlug/settings"
            params={{ businessSlug: business.slug }}
          >
            Settings
          </BackLink>
        }
      />
      <SettingsBody>
        <XeroSection
          kind={kind}
          business={business}
          search={search}
          onSearchDone={onSearchDone}
        />
      </SettingsBody>
    </>
  )
}

/**
 * The page's body, without its header (which needs the app's shell): what
 * the UI harness renders.
 *
 * Who may use the page is read from `access.me` first, which the layout
 * already holds, so "Owners only" and the switched messages never wait on
 * the Xero query.
 */
export function XeroSection({
  kind,
  business,
  search,
  onSearchDone,
}: {
  kind: XeroKind
  business: Business
  search: XeroSearch
  onSearchDone: () => void
}) {
  const access = useAccess()
  const canManageBusiness = useCan('business.manage')
  const { isSwitched } = useActing()

  if (kind === 'business' && !canManageBusiness) {
    // `business.manage` is the owner's, and a switch into someone's account
    // drops it — so an owner here is working in another account.
    return (
      <EmptyState
        title="Owners only"
        body={
          access.role === 'owner' && isSwitched
            ? 'Only the business owner can connect the business’s Xero. Switch back to your own account to open it.'
            : 'Only the business owner can connect the business’s Xero.'
        }
      />
    )
  }

  if (kind === 'member' && access.role === 'owner') {
    // The owner's organisation is the business's: every client goes there
    // already, so a second, personal one would only be a copy of it.
    return (
      <EmptyState
        title="Your Xero is the business’s"
        body="As the owner, you connect the business’s Xero, which every client is copied into."
        action={
          <Link
            to="/$businessSlug/settings/xero"
            params={{ businessSlug: business.slug }}
            className={EMPTY_ACTION_CLASS}
          >
            Go to the business’s Xero
          </Link>
        }
      />
    )
  }

  if (kind === 'member' && isSwitched) {
    // The server refuses a member's Connect, Finish and Disconnect while a
    // switch is open (`SWITCHED`): My Xero is the real person's, never the
    // account being worked in.
    return (
      <EmptyState
        title="Switch back to connect Xero"
        body="My Xero is yours, not the account you’re working in. Switch back to your own account to connect or change it."
      />
    )
  }

  return (
    <Suspense fallback={<SectionPending />}>
      <XeroConnection
        kind={kind}
        business={business}
        search={search}
        onSearchDone={onSearchDone}
      />
    </Suspense>
  )
}

function XeroConnection({
  kind,
  business,
  search,
  onSearchDone,
}: {
  kind: XeroKind
  business: Business
  search: XeroSearch
  onSearchDone: () => void
}) {
  const { data: status } = useSuspenseQuery(rq.xeroStatus(business._id))

  if (!status.configured) {
    return (
      <EmptyState
        title="Xero isn’t set up here"
        body="This copy of PestM8 isn’t linked to Xero, so there’s nothing to connect."
      />
    )
  }
  if (status.demo) {
    return (
      <EmptyState
        title="Not for the demo business"
        body="The demo business’s clients are made up, so it can’t be connected to Xero. Connect Xero from your own business."
      />
    )
  }

  return (
    <ConnectionStates
      kind={kind}
      business={business}
      view={kind === 'business' ? status.business : status.mine}
      timezone={status.timezone}
      twoStepOn={status.twoStepOn}
      twoStepNeeded={status.twoStepNeeded}
      paused={status.paused}
      search={search}
      onSearchDone={onSearchDone}
    />
  )
}

/**
 * The connection itself: finishing one, none, connected, or needing to be
 * reconnected — with anything the way back from Xero has to say above it.
 */
function ConnectionStates({
  kind,
  business,
  view,
  timezone,
  twoStepOn,
  twoStepNeeded,
  paused,
  search,
  onSearchDone,
}: {
  kind: XeroKind
  business: Business
  view: XeroView | null
  timezone: string
  /** Two-step sign-in is on: otherwise the page suggests it. */
  twoStepOn: boolean
  /** Connecting is refused until it is on, where the deployment asks for it
   * (`XERO_TWO_STEP_REQUIRED=on`, convex/xero.ts `requireTwoStep`). */
  twoStepNeeded: boolean
  /** The kill switch is on (`XERO_SYNC_PAUSED`). */
  paused: boolean
  search: XeroSearch
  onSearchDone: () => void
}) {
  const finish = useFinish(business._id, search.finish, onSearchDone)
  const owner = useOwnerName(business._id, kind)
  const disclosure = disclosureCopy(kind, business.name, owner)
  // Where focus goes once Disconnect has gone through: Connect Xero, which
  // takes the place of the group the confirm was opened from.
  const connectId = useId()
  // A client opened from Recent problems. The sheet stays mounted once
  // loaded, so closing it slides it away rather than cutting it off.
  const [openClient, setOpenClient] = useState<Id<'clients'> | null>(null)
  const [sheetLoaded, setSheetLoaded] = useState(false)
  const canManageClients = useCan('clients.manage')
  const canRenumber = useCan('business.manage')

  // Read from the address, so the server renders it and nothing moves when
  // the page hydrates. Still finishing until the token has gone from the
  // address: a success clears it, and the live status shows the rest.
  if (search.finish && !finish.isError) {
    return (
      <SettingsGroup>
        <div role="status">
          <SettingsRow
            leading={
              <LoaderCircle
                aria-hidden
                size={17}
                strokeWidth={2}
                className="mx-1.5 shrink-0 animate-spin text-muted-2"
              />
            }
            title="Connecting to Xero…"
          />
        </div>
      </SettingsGroup>
    )
  }

  const returned = search.xero ? xeroReturnCopy(search.xero) : null
  const alert = finish.isError ? (
    <FormAlert error={finish.error} copy={FINISH_ERROR_COPY} />
  ) : returned ? (
    <FormAlert>{returned}</FormAlert>
  ) : null

  const live =
    view && (view.status === 'connected' || view.status === 'needs_reconnect')
      ? view
      : null

  if (!live) {
    // A disconnect PestM8 could not finish at Xero (the sign-in had already
    // died): Xero still lists the app until the person removes it there.
    const leftover =
      view?.status === 'disconnected' && view.problem?.code === 'xero_side'
        ? view
        : null
    return (
      <>
        {alert}
        {leftover && (
          <SettingsGroup title="Still listed in Xero">
            <div className="px-3.5 py-3">
              <p className="text-body text-ink">{leftover.tenantName}</p>
              <p className="mt-0.5 text-caption text-amber-ink">
                {problemCopy('xero_side', leftover.tenantName)}
              </p>
            </div>
          </SettingsGroup>
        )}
        <SettingsGroup footer={<TermsLine />}>
          <div className="px-3.5 py-3.5">
            <p className="text-body text-ink">{EXPLAINER[kind]}</p>
            <p className="mt-2 text-caption text-ink-2">{disclosure}</p>
            <div className="mt-3.5">
              {twoStepNeeded ? (
                <TwoStepFirst id={connectId} slug={business.slug} />
              ) : (
                <>
                  <ConnectButton
                    id={connectId}
                    businessId={business._id}
                    kind={kind}
                    label="Connect Xero"
                  />
                  {!twoStepOn && <TwoStepSuggested slug={business.slug} />}
                </>
              )}
            </div>
          </div>
        </SettingsGroup>
      </>
    )
  }

  const since =
    live.connectedAt === null ? null : formatWhen(live.connectedAt, timezone)
  // The owner's page says who connected it, which is not always whoever is
  // looking; a member's is always their own.
  const connectedLine = [
    kind === 'business' ? `Connected by ${live.connectedByName}` : 'Connected',
    since,
  ]
    .filter(Boolean)
    .join(kind === 'business' ? ' · ' : ' ')

  return (
    <>
      {alert}
      {live.status === 'connected' ? (
        <>
          <SettingsGroup
            title="Organisation"
            // Once the match is in, its own group says this, with why the
            // checking is worth doing now.
            footer={
              live.match?.state === 'ready'
                ? undefined
                : 'PestM8 doesn’t send anything to Xero yet.'
            }
          >
            <OrgRow tint="blue" name={live.tenantName} detail={connectedLine} />
          </SettingsGroup>
          <MatchStatus
            kind={kind}
            businessId={business._id}
            businessSlug={business.slug}
            connection={live}
            paused={paused}
            timezone={timezone}
            canEditClients={canManageClients}
            onOpenClient={(clientId) => {
              setSheetLoaded(true)
              setOpenClient(clientId)
            }}
          />
        </>
      ) : (
        <SettingsGroup title="Organisation" footer={<TermsLine />}>
          <OrgRow
            tint="amber"
            name={live.tenantName}
            detail={connectedLine}
            badge={<RowBadge tone="amber">Reconnect needed</RowBadge>}
          />
          <div className="px-3.5 py-3.5">
            <p className="text-caption text-amber-ink">
              {problemCopy(live.problem?.code ?? 'reconnect', live.tenantName)}
            </p>
            <p className="mt-2 text-caption text-ink-2">{disclosure}</p>
            <div className="mt-3.5">
              {twoStepNeeded ? (
                <TwoStepFirst slug={business.slug} />
              ) : (
                <ConnectButton
                  businessId={business._id}
                  kind={kind}
                  label="Reconnect Xero"
                />
              )}
            </div>
          </div>
        </SettingsGroup>
      )}
      <Disconnect
        businessId={business._id}
        connection={live}
        afterDisconnect={() => document.getElementById(connectId)}
      />
      {sheetLoaded && (
        <Suspense fallback={null}>
          <ClientSheet
            businessId={business._id}
            timezone={timezone}
            businessSlug={business.slug}
            businessState={business.state}
            canManageClients={canManageClients}
            canRenumber={canRenumber}
            clientId={openClient}
            onClose={() => setOpenClient(null)}
          />
        </Suspense>
      )}
    </>
  )
}

/**
 * The organisation, as one row: its name and when and by whom it was
 * connected, both wrapping rather than cut short — on a phone a settings
 * row's one-line subtitle lost the time behind the name — and a badge for
 * what needs doing.
 */
function OrgRow({
  tint,
  name,
  detail,
  badge,
}: {
  tint: 'blue' | 'amber'
  name: string
  detail: string
  badge?: ReactNode
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5">
      <IconTile icon={Plug} tint={tint} />
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">{name}</p>
        <p className="text-caption text-muted">{detail}</p>
        {/* Under the words, not beside them: beside, it squeezed the
            detail into three lines on a phone. */}
        {badge && <div className="mt-1.5">{badge}</div>}
      </div>
    </div>
  )
}

/**
 * What PestM8 made of the organisation's contacts (Release 2): reading
 * them, the counts once it has, or why it couldn't — under the
 * organisation, in one group whose heading stays put while its rows change.
 *
 * Until Start syncing nothing is sent to Xero; the counts are what syncing
 * will act on, and the To check ones wait for the holder to say Same or
 * Different on the match page. Once it has started, the same group says how
 * the sending stands instead (`SyncStatus`).
 */
function MatchStatus({
  kind,
  businessId,
  businessSlug,
  connection,
  paused,
  timezone,
  canEditClients,
  onOpenClient,
}: {
  kind: XeroKind
  businessId: Id<'businesses'>
  businessSlug: string
  connection: XeroView
  paused: boolean
  timezone: string
  /** Whether the person looking may change clients: a problem's next step
   * is then theirs. */
  canEditClients: boolean
  onOpenClient: (clientId: Id<'clients'>) => void
}) {
  const match = connection.match
  const stage = useMatchStage(connection)
  const sync = syncOf(connection)
  const title = 'Your clients in Xero'

  if (sync) {
    return (
      <SyncStatus
        kind={kind}
        businessSlug={businessSlug}
        connection={connection}
        sync={sync}
        paused={paused}
        timezone={timezone}
        canEditClients={canEditClients}
        onOpenClient={onOpenClient}
      />
    )
  }

  if (stage.stage === 'reading') {
    return (
      <SettingsGroup title={title}>
        <MatchReading tenantName={connection.tenantName} />
      </SettingsGroup>
    )
  }

  if (stage.stage === 'failed' || !match) {
    return (
      <SettingsGroup title={title}>
        <MatchFailed
          kind={kind}
          businessId={businessId}
          businessSlug={businessSlug}
          connection={connection}
          problem={stage.stage === 'failed' ? stage.problem : null}
          paused={paused}
        />
      </SettingsGroup>
    )
  }

  const count = (n: number) => n.toLocaleString('en-AU')
  return (
    <SettingsGroup
      title={title}
      footer={
        <>
          PestM8 doesn’t send anything to Xero yet. Checking these now means
          Xero is ready when it does.{' '}
          <RematchLink
            businessId={businessId}
            connectionId={connection.connectionId}
          />
        </>
      }
    >
      {/* The match page's lists, one row each, with the same counts as its
          chips. New to Xero and Different both become new contacts in
          Xero (`fresh` counts them together). */}
      <SettingsRow title="Matched" value={count(match.linked)} />
      {/* Only when there are some, as Different: most books have none. */}
      {match.shared > 0 && (
        <SettingsRow title="Shared contact" value={count(match.shared)} />
      )}
      <SettingsRow title="To check" value={count(match.review)} />
      <SettingsRow
        title="New to Xero"
        value={count(Math.max(0, match.fresh - match.different))}
      />
      {match.different > 0 && (
        <SettingsRow title="Different" value={count(match.different)} />
      )}
      {/* Only when there are some: a business without leads has nothing
          waiting, and a row of nought says nothing. */}
      {match.leads > 0 && (
        <MatchCountRow
          title="Leads waiting"
          detail="Added once their first job is booked"
          value={count(match.leads)}
        />
      )}
      <SettingsLinkRow
        to={
          kind === 'business'
            ? '/$businessSlug/settings/xero/match'
            : '/$businessSlug/settings/my-xero/match'
        }
        params={{ businessSlug }}
        title="Match your clients"
        badge={
          match.review > 0 ? (
            <RowBadge tone="amber">{count(match.review)} to check</RowBadge>
          ) : undefined
        }
      />
    </SettingsGroup>
  )
}

/** A count with a line under it that must not be cut short, as a settings
 * row's one-line subtitle would on a phone. */
function MatchCountRow({
  title,
  detail,
  value,
}: {
  title: string
  detail: string
  value: string
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">{title}</p>
        <p className="text-caption text-muted">{detail}</p>
      </div>
      <span className="shrink-0 text-body text-muted">{value}</span>
    </div>
  )
}

/**
 * How sending to the organisation stands, from Start syncing on (Release 3):
 * anything holding it up first — PestM8's kill switch, or Xero asking it to
 * wait — then, while the book is still going in, how far it has got; then
 * the counts, a row each, with the ones that need someone amber; and the
 * clients Xero refused, each opening the client, so a bad email can be put
 * right where it was read about.
 *
 * Every count is the server's (`xeroSyncState.counts`), never worked out
 * here, so the page and the hub's badge always agree.
 */
function SyncStatus({
  kind,
  businessSlug,
  connection,
  sync,
  paused,
  timezone,
  canEditClients,
  onOpenClient,
}: {
  kind: XeroKind
  businessSlug: string
  connection: XeroView
  sync: SyncSummary
  /** The kill switch, `XERO_SYNC_PAUSED`: nothing goes, everything waits. */
  paused: boolean
  timezone: string
  canEditClients: boolean
  onOpenClient: (clientId: Id<'clients'>) => void
}) {
  const { counts } = sync
  const count = (n: number) => n.toLocaleString('en-AU')
  // Xero's own pause, judged against this device's clock: the server
  // can't put "now" in a query, and a pause that has run out says nothing.
  const pauseOver = usePassed(sync.pausedUntil)
  const pause =
    !paused && sync.pausedUntil !== null && !pauseOver
      ? pauseCopy(
          sync.pauseReason,
          connection.tenantName,
          formatWhen(sync.pausedUntil, timezone),
        )
      : null
  const { backfill } = sync
  const heldUntil = backfill?.heldUntil ?? null
  const heldOver = usePassed(heldUntil)
  // Said only while nothing else is holding everything up: under a pause,
  // the book waiting too goes without saying.
  const held =
    !paused && pause === null && heldUntil !== null && !heldOver
      ? backfillHeldCopy(formatWhen(heldUntil, timezone))
      : null
  const stalled = paused || pause !== null || held !== null
  const matchPath =
    kind === 'business'
      ? ('/$businessSlug/settings/xero/match' as const)
      : ('/$businessSlug/settings/my-xero/match' as const)

  return (
    <>
      <SettingsGroup
        title="Your clients in Xero"
        footer={`Syncing since ${formatWhen(sync.startedAt, timezone)}. PestM8 sends each change to ${connection.tenantName} as it’s made, and never deletes or archives anything there.`}
      >
        {paused && <SyncNotice>{SYNC_PAUSED}</SyncNotice>}
        {pause && <SyncNotice>{pause}</SyncNotice>}
        {backfill && (
          <div>
            <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5">
              {/* Turning only while it is moving: held, it would say
                something is happening that isn't. */}
              {!stalled && (
                <LoaderCircle
                  aria-hidden
                  size={17}
                  strokeWidth={2}
                  className="mx-1.5 shrink-0 animate-spin text-muted-2"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-body text-ink">Adding your clients…</p>
                {/* The words for the meter, which is drawn for the eye
                  only: "in Xero", since the matched ones are there
                  already, and the count starts with them. */}
                <p className="text-caption text-muted">
                  {backfillCopy(backfill.done, backfill.total)}
                </p>
              </div>
              {backfill.total > 0 && (
                <span className="shrink-0">
                  <BarMeter value={backfill.done} max={backfill.total} />
                </span>
              )}
            </div>
            {/* Under the row, across it: beside the meter it ran to four
              lines. */}
            {held && (
              <p className="-mt-1 px-3.5 pb-3 text-caption text-amber-ink">
                {held}
              </p>
            )}
          </div>
        )}
        <SettingsRow title="In Xero" value={count(counts.inXero)} />
        <SettingsRow
          title="To check"
          value={
            <Count needs={counts.review > 0}>{count(counts.review)}</Count>
          }
        />
        <SettingsRow
          title="Different in Xero"
          subtitle={counts.different > 0 ? DIFFERENT_CAPTION : undefined}
          value={
            <Count needs={counts.different > 0}>
              {count(counts.different)}
            </Count>
          }
        />
        <SettingsRow
          title="Not sent"
          subtitle={counts.failed > 0 ? NOT_SENT_CAPTION : undefined}
          value={
            <Count needs={counts.failed > 0}>{count(counts.failed)}</Count>
          }
        />
        <SettingsRow
          title="Waiting to send"
          value={waitingCount(counts.waiting)}
        />
        {sync.lastSentAt !== null && (
          // Not a SettingsRow: its value is cut at under half the row, and
          // the time is what the row is for.
          <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5">
            <span className="min-w-0 flex-1 text-body text-ink">Last sent</span>
            <span className="shrink-0 text-right text-body text-muted">
              {formatWhen(sync.lastSentAt, timezone)}
            </span>
          </div>
        )}
        <SettingsLinkRow
          to={matchPath}
          params={{ businessSlug }}
          title="Match your clients"
          badge={
            counts.review > 0 ? (
              <RowBadge tone="amber">{count(counts.review)} to check</RowBadge>
            ) : undefined
          }
        />
      </SettingsGroup>

      {/* The newest five, which the server picks: the ones worth doing
          something about. */}
      {sync.recent.length > 0 && (
        <SettingsGroup
          title="Recent problems"
          footer={
            recentFooterCopy(sync.recent.length, sync.problems) ?? undefined
          }
        >
          {sync.recent.map((problem) => (
            <ProblemRow
              key={`${problem.clientId}:${problem.at}`}
              problem={problem}
              canEdit={canEditClients}
              onOpen={() => onOpenClient(problem.clientId)}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )
}

/** A row's count, amber while it needs someone. */
function Count({ needs, children }: { needs: boolean; children: ReactNode }) {
  return needs ? (
    <span className="font-semibold text-amber-ink">{children}</span>
  ) : (
    <>{children}</>
  )
}

/** Something holding the sending up, at the top of the group: amber words
 * that wrap, since each says when it carries on. */
function SyncNotice({ children }: { children: ReactNode }) {
  return <p className="px-3.5 py-3 text-caption text-amber-ink">{children}</p>
}

/**
 * One client Xero refused: "Could not add {client}" (or "Could not update",
 * for one in Xero already; the name alone, for one only left short), and
 * why in words that say what to do, wrapping; a tap opens the client over
 * the page.
 */
function ProblemRow({
  problem,
  canEdit,
  onOpen,
}: {
  problem: SyncProblem
  canEdit: boolean
  onOpen: () => void
}) {
  const hydrated = useHydrated()
  return (
    <button
      type="button"
      disabled={!hydrated}
      onClick={onOpen}
      className={ROW_CLASS}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body text-ink [overflow-wrap:anywhere]">
          {problemHeading(problem)}
        </span>
        <span className="block text-caption text-amber-ink">
          {syncProblemCopy(problem.code, { canEdit })}
        </span>
      </span>
      <ChevronRight
        aria-hidden
        size={17}
        strokeWidth={2.2}
        className="shrink-0 text-muted-2"
      />
    </button>
  )
}

/**
 * "Reading the contacts in {org}…", while the match runs: in words that wrap,
 * since an organisation's name is often long, and with the reassurance that
 * leaving the page doesn't stop it — a big organisation takes a minute.
 * Shared with the match page.
 */
export function MatchReading({ tenantName }: { tenantName: string }) {
  return (
    <div
      role="status"
      className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5"
    >
      <LoaderCircle
        aria-hidden
        size={17}
        strokeWidth={2}
        className="mx-1.5 shrink-0 animate-spin text-muted-2"
      />
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">
          Reading the contacts in {tenantName}…
        </p>
        <p className="text-caption text-muted">
          It carries on if you leave this page.
        </p>
      </div>
    </div>
  )
}

/**
 * What the page makes of a connection's match (`MatchStage`): the run's own
 * state, except two it can't say itself. A read still "reading" once its
 * `staleAfter` has gone by on this device's clock belongs to a run that died
 * (killed by a deploy, past the action time limit): it is `stopped`, and
 * Check Xero again is offered — which the server then accepts. And a
 * connection with no match at all was connected before matching existed
 * (connecting asks for one in the same write): it is `not_read`.
 *
 * Shared with the match page, so both say the same.
 */
export function useMatchStage(connection: XeroView): MatchStage {
  const match = connection.match
  const stale = usePassed(match?.state === 'reading' ? match.staleAfter : null)
  if (!match) return { stage: 'failed', problem: 'not_read' }
  if (match.state === 'reading') {
    return stale
      ? { stage: 'failed', problem: 'stopped' }
      : { stage: 'reading' }
  }
  if (match.state === 'failed') {
    return { stage: 'failed', problem: match.problem }
  }
  return { stage: 'ready' }
}

/** The longest a browser timer waits (about 24 days). */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Whether `deadline` has gone by on this device's clock — and, while the
 * page stays open, from the moment it does. False until hydrated, so the
 * server's render and the first render here agree.
 */
export function usePassed(deadline: number | null): boolean {
  const hydrated = useHydrated()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (deadline === null) return
    const wait = deadline - Date.now()
    if (wait < 0) return
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      Math.min(wait + 50, MAX_TIMER_MS),
    )
    return () => clearTimeout(timer)
  }, [deadline])
  return hydrated && deadline !== null && Date.now() >= deadline
}

/**
 * Why the contacts couldn't be read, and what to do (`matchRetry`): Check
 * Xero again; Reconnect Xero, on the match page, when the connection needs
 * it first (the server refuses a check until then, and the Xero page has the
 * button); or nothing, where trying again can't help. The amber line is an
 * alert, so a page left open while it reads says when the read stopped.
 * Shared with the match page.
 */
export function MatchFailed({
  kind,
  businessId,
  businessSlug,
  connection,
  problem,
  paused,
}: {
  kind: XeroKind
  businessId: Id<'businesses'>
  businessSlug: string
  connection: XeroView
  problem: string | null
  paused: boolean
}) {
  const hydrated = useHydrated()
  const rematch = useRematch(businessId, connection.connectionId)
  const retry = matchRetry(problem, connection, paused)
  return (
    <div className="px-3.5 py-3.5">
      <p role="alert" className="text-caption text-amber-ink">
        {matchProblemCopy(problem, connection.tenantName)}
      </p>
      {retry === 'rematch' && (
        <>
          <button
            type="button"
            disabled={!hydrated || rematch.isPending}
            onClick={() => rematch.mutate()}
            className={`${NEUTRAL_BUTTON_COMPACT} mt-3.5 w-full`}
          >
            {rematch.isPending ? 'Checking…' : 'Check Xero again'}
          </button>
          <FormAlert
            error={rematch.isError ? rematch.error : null}
            copy={REMATCH_ERROR_COPY}
            className="mt-2"
          />
        </>
      )}
      {retry === 'reconnect' && (
        <Link
          to={
            kind === 'business'
              ? '/$businessSlug/settings/xero'
              : '/$businessSlug/settings/my-xero'
          }
          params={{ businessSlug }}
          className={`${LINK_BUTTON} mt-3.5 flex w-full items-center justify-center`}
        >
          Reconnect Xero
        </Link>
      )}
    </div>
  )
}

/**
 * Check Xero again, as a quiet word at the end of the match group's footer:
 * the counts are there, and reading Xero again is the rare thing to do —
 * after tidying contacts in Xero, say. Decisions already made are kept.
 */
function RematchLink({
  businessId,
  connectionId,
}: {
  businessId: Id<'businesses'>
  connectionId: Id<'xeroConnections'>
}) {
  const hydrated = useHydrated()
  const rematch = useRematch(businessId, connectionId)
  return (
    <>
      <button
        type="button"
        disabled={!hydrated || rematch.isPending}
        onClick={() => rematch.mutate()}
        className="relative tap-target font-semibold text-blue transition active:opacity-50 disabled:opacity-50"
      >
        {rematch.isPending ? 'Checking…' : 'Check Xero again'}
      </button>
      <FormAlert
        error={rematch.isError ? rematch.error : null}
        copy={REMATCH_ERROR_COPY}
        className="mt-2"
      />
    </>
  )
}

/**
 * Reads the organisation's contacts again (`xeroMatch.rematch`), which
 * marks the match as reading at once, so the page shows it. Fails fast with
 * no signal: held for the signal, a read of Xero would start long after the
 * tap seemed to do nothing.
 */
export function useRematch(
  businessId: Id<'businesses'>,
  connectionId: Id<'xeroConnections'>,
) {
  const convexRematch = useConvexMutation(api.xeroMatch.rematch)
  return useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      await convexRematch({ businessId, connectionId })
    },
  })
}

/**
 * In place of Connect Xero while two-step sign-in is off, on a deployment
 * that needs it for connecting (`XERO_TWO_STEP_REQUIRED=on`): why, and the
 * way to turn it on — a `LINK_BUTTON`, since it goes somewhere else. The
 * server refuses a connect without it (`requireTwoStep` in convex/xero.ts),
 * so offering the button would only lead to that refusal.
 */
function TwoStepFirst({ id, slug }: { id?: string; slug: string }) {
  return (
    <>
      <p className="text-caption text-ink-2">{TWO_STEP_FIRST}</p>
      <Link
        id={id}
        to="/$businessSlug/settings/sign-in"
        params={{ businessSlug: slug }}
        className={`${LINK_BUTTON} mt-3 flex w-full items-center justify-center`}
      >
        Turn on two-step sign-in
      </Link>
    </>
  )
}

/**
 * Under Connect Xero for someone without two-step sign-in, where connecting
 * doesn't need it: a suggestion, never in the way. One caption with its
 * link inline (a text button, as the terms line's are), so it reads as an
 * aside to the button above it rather than a second action beside it.
 */
function TwoStepSuggested({ slug }: { slug: string }) {
  return (
    <p className="mt-3 text-caption text-ink-2">
      {TWO_STEP_SUGGESTED}{' '}
      <Link
        to="/$businessSlug/settings/sign-in"
        params={{ businessSlug: slug }}
        className="relative tap-target font-semibold text-blue"
      >
        Turn on two-step sign-in
      </Link>
    </p>
  )
}

/**
 * Connect Xero, or Reconnect Xero: asks the server for Xero's sign-in
 * address and goes there in this window.
 *
 * A plain tap, ink not red: nothing is saved by it, and Xero's own screen is
 * where the person agrees. It fails fast with no signal — held for the
 * signal, the phone would leave for Xero whenever it came back, long after
 * the tap seemed to have done nothing.
 */
function ConnectButton({
  id,
  businessId,
  kind,
  label,
}: {
  id?: string
  businessId: Id<'businesses'>
  kind: XeroKind
  label: string
}) {
  const hydrated = useHydrated()
  const convexStart = useConvexAction(api.xero.startConnect)
  const start = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      const { url } = await convexStart({ businessId, kind })
      // Only ever to Xero's own sign-in: this address is about to take the
      // whole window.
      if (new URL(url).origin !== XERO_SIGN_IN_ORIGIN) {
        throw new Error('XERO_BAD_URL')
      }
      return url
    },
    onSuccess: (url) => window.location.assign(url),
  })

  // Back from Xero's sign-in can bring this page back exactly as it was left
  // (the back/forward cache), still saying "Opening Xero…" with its button
  // dead. A page restored that way starts over. So does one Xero's sign-in
  // only covered — an installed app can open it in a browser over itself,
  // and closing that never unloads or restores this page — when it is seen
  // again, or failing that after a while: a page really on its way to Xero
  // is long gone by then.
  const { reset } = start
  const left = start.isSuccess
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) reset()
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [reset])
  useEffect(() => {
    if (!left) return
    const seenAgain = () => {
      if (document.visibilityState === 'visible') reset()
    }
    const timer = window.setTimeout(reset, OPENING_RESET_MS)
    document.addEventListener('visibilitychange', seenAgain)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', seenAgain)
    }
  }, [left, reset])

  // Still "Opening…" once the address is in hand: the page is on its way
  // out, and a second tap would start a second sign-in.
  const opening = start.isPending || start.isSuccess
  return (
    <>
      <button
        id={id}
        type="button"
        disabled={!hydrated || opening}
        onClick={() => start.mutate()}
        className={`${NEUTRAL_BUTTON} w-full`}
      >
        {opening ? 'Opening Xero…' : label}
      </button>
      <FormAlert
        error={start.isError ? start.error : null}
        copy={startErrorCopy(kind)}
        className="mt-2"
      />
    </>
  )
}

/**
 * Finishes a connection on the way back from Xero, once: after hydration (a
 * call before it would be lost with the server's render), and never twice for
 * one token — the token is single use, so a second call could only fail and
 * cover the first's success with an error. Then clears the address, so a
 * reload or Back does not try a used token again.
 *
 * It waits for signal rather than failing fast: it only completes what the
 * person already agreed to at Xero, and the token keeps for 15 minutes.
 */
function useFinish(
  businessId: Id<'businesses'>,
  token: string | undefined,
  onDone: () => void,
) {
  const hydrated = useHydrated()
  const convexFinish = useConvexAction(api.xero.finishConnect)
  const finish = useMutation({
    mutationFn: (finishToken: string) =>
      convexFinish({ businessId, token: finishToken }),
  })
  const asked = useRef<string | null>(null)
  const done = useLatest(onDone)
  const { mutate } = finish

  useEffect(() => {
    if (!hydrated || !token || asked.current === token) return
    asked.current = token
    mutate(token, { onSettled: () => done.current() })
  }, [hydrated, token, mutate, done])

  return finish
}

/**
 * The owner's name for a member's disclosure ("Terence can see which
 * organisation you connected"), from the roster the route warms; "The
 * business owner" until it answers, or if it never does.
 */
function useOwnerName(businessId: Id<'businesses'>, kind: XeroKind): string {
  // 'skip', not `enabled`: a disabled query keeps its Convex subscription.
  const roster = useQuery(
    kind === 'member'
      ? rq.roster(businessId)
      : convexQuery(api.memberships.listForBusiness, 'skip'),
  ).data
  const name = roster?.find((m) => m.role === 'owner')?.name.trim()
  return name || 'The business owner'
}

/**
 * Disconnect, last on the page and asked first. Fails fast with no signal:
 * it lets go of the organisation at Xero, which nobody should find
 * happening hours later when the signal comes back.
 */
function Disconnect({
  businessId,
  connection,
  afterDisconnect,
}: {
  businessId: Id<'businesses'>
  connection: XeroView
  /** Where focus goes once it has gone through, when this group — and the
   * row the confirm was opened from — is no longer on the page. */
  afterDisconnect: () => HTMLElement | null
}) {
  const hydrated = useHydrated()
  const [confirming, setConfirming] = useState(false)
  const convexDisconnect = useConvexMutation(api.xero.disconnect)
  const disconnect = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      return convexDisconnect({
        businessId,
        connectionId: connection.connectionId,
      })
    },
    // On the mutation, not the call: by the time it resolves the page has
    // already swapped this group for Connect.
    onSuccess: () => setConfirming(false),
  })

  return (
    <>
      <DangerGroup>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => {
            disconnect.reset()
            setConfirming(true)
          }}
          className={DANGER_ROW_CLASS}
        >
          Disconnect Xero
        </button>
      </DangerGroup>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect Xero?"
        body={`PestM8 stops sending changes to ${connection.tenantName}. Contacts already in Xero stay there.`}
        confirm="Disconnect"
        cancel="Keep Xero"
        onConfirm={() => disconnect.mutate()}
        returnFocus={(confirmed) => (confirmed ? afterDisconnect() : null)}
        pending={disconnect.isPending}
        pendingLabel="Disconnecting…"
        closeOnConfirm={false}
        error={
          disconnect.isError
            ? describeError(disconnect.error, DISCONNECT_ERROR_COPY)
            : undefined
        }
      />
    </>
  )
}

/**
 * "By connecting, you agree to PestM8’s terms and privacy policy." Each opens
 * in a tab of its own: neither page has the app around it, and an installed
 * iPhone app has no Back button to return from one.
 */
function TermsLine() {
  return (
    <>
      By connecting, you agree to PestM8’s{' '}
      <a
        href="/terms"
        target="_blank"
        rel="noopener"
        className="relative tap-target font-semibold text-blue"
      >
        terms
      </a>{' '}
      and{' '}
      <a
        href="/privacy"
        target="_blank"
        rel="noopener"
        className="relative tap-target font-semibold text-blue"
      >
        privacy policy
      </a>
      .
    </>
  )
}
