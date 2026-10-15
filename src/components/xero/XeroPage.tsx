import { Suspense, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useConvexAction, useConvexMutation } from '@convex-dev/react-query'
import { LoaderCircle, Plug } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { SectionPending } from '#/components/shell/Pending'
import {
  EMPTY_ACTION_CLASS,
  EmptyState,
} from '#/components/primitives/EmptyState'
import { LINK_BUTTON, NEUTRAL_BUTTON } from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { useLatest } from '#/components/forms/SaveWarnings'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import {
  BackLink,
  DANGER_ROW_CLASS,
  DangerGroup,
  IconTile,
  RowBadge,
  SettingsBody,
  SettingsGroup,
  SettingsRow,
} from '#/components/settings/ui'
import { useAccess, useActing, useCan } from '#/lib/access'
import { formatWhen } from '#/lib/format'
import { isOffline } from '#/lib/online'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import {
  DISCONNECT_ERROR_COPY,
  EXPLAINER,
  FINISH_ERROR_COPY,
  TWO_STEP_FIRST,
  disclosureCopy,
  problemCopy,
  startErrorCopy,
  xeroReturnCopy,
} from './xeroCopy'
import type { XeroKind } from './xeroCopy'
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

type Business = { _id: Id<'businesses'>; slug: string; name: string }

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
 * Release 1 connects and disconnects, and nothing else: no contact is sent
 * to Xero yet, and the page says so.
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
  search,
  onSearchDone,
}: {
  kind: XeroKind
  business: Business
  view: XeroView | null
  timezone: string
  /** Connecting needs two-step sign-in on (convex/xero.ts). */
  twoStepOn: boolean
  search: XeroSearch
  onSearchDone: () => void
}) {
  const finish = useFinish(business._id, search.finish, onSearchDone)
  const owner = useOwnerName(business._id, kind)
  const disclosure = disclosureCopy(kind, business.name, owner)
  // Where focus goes once Disconnect has gone through: Connect Xero, which
  // takes the place of the group the confirm was opened from.
  const connectId = useId()

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
              {twoStepOn ? (
                <ConnectButton
                  id={connectId}
                  businessId={business._id}
                  kind={kind}
                  label="Connect Xero"
                />
              ) : (
                <TwoStepFirst id={connectId} slug={business.slug} />
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
        <SettingsGroup
          title="Organisation"
          footer="PestM8 doesn’t send anything to Xero yet."
        >
          <OrgRow tint="blue" name={live.tenantName} detail={connectedLine} />
        </SettingsGroup>
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
              {twoStepOn ? (
                <ConnectButton
                  businessId={business._id}
                  kind={kind}
                  label="Reconnect Xero"
                />
              ) : (
                <TwoStepFirst slug={business.slug} />
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
 * In place of Connect Xero while two-step sign-in is off: why, and the way to
 * turn it on — a `LINK_BUTTON`, since it goes somewhere else. The server refuses a connect without it (`requireTwoStep` in
 * convex/xero.ts), so offering the button would only lead to that refusal.
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
  const roster = useQuery({
    ...rq.roster(businessId),
    enabled: kind === 'member',
  }).data
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
