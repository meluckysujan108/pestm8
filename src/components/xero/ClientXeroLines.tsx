import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { ExternalLink } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { DetailRow } from '#/components/primitives/DetailRow'
import { HoldButton } from '#/components/primitives/HoldButton'
import {
  LINK_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { describeError } from '#/components/forms/describeError'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { useCan } from '#/lib/access'
import { formatWhen } from '#/lib/format'
import { TOUCH_CLICK_WINDOW_MS } from '#/lib/holdGesture'
import { openMapTab } from '#/lib/maps'
import { isOffline } from '#/lib/online'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import {
  OVERWRITE_ERROR_COPY,
  differentCopy,
  fieldList,
  syncProblemCopy,
} from './xeroCopy'
import type { XeroKind, XeroLineState } from './xeroCopy'
import type { ReactNode, RefObject } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Where a client stands in one Xero organisation, as `xeroSync.clientLines`
 * gives it: the business's (for the owner) or the person's own (for a
 * member).
 */
export type XeroLine = {
  connectionId: Id<'xeroConnections'>
  /** Which Settings page holds it, and its match. */
  kind: XeroKind
  orgName: string
  state: XeroLineState
  lastSentAt: number | null
  /** The details Xero holds otherwise (`FieldKey`s), for `different`. */
  different: ReadonlyArray<string>
  /** Why Xero refused it, for `failed` — or, on a client that is in Xero,
   * what didn't go with it (an email Xero can't take, a sixth contact
   * person). Worded by `syncProblemCopy`. */
  problemCode: string | null
  /** The contact Xero may already have it as, for `to_check`. */
  candidateName: string | null
  /** The contact in Xero, once PestM8 knows both it and the
   * organisation's short code. */
  openUrl: string | null
  /** Whether the person looking may press "Send PestM8’s details": the
   * organisation's holder, not switched into someone else's account. */
  canOverwrite: boolean
}

/** Where Xero's own pages live. "Open in Xero" opens nowhere else. */
const XERO_WEB_ORIGIN = 'https://go.xero.com'

/** How long the fallback link stays, after a tab the browser would not open
 * (as Map's does). */
const FALLBACK_MS = 10_000

/**
 * The client sheet's Xero rows, in its Details card after the company
 * address (Release 3): one per organisation this person holds — the
 * business's for the owner, their own for a member — saying whether the
 * client is there, waiting, or why not, with what can be done about it.
 *
 * Nothing at all where Xero isn't set up, nothing is connected, or the
 * question can't be answered (a server without Release 3, no signal): the
 * rest of the card is the client's, and a Xero row that only says "could
 * not load" would be noise there. The query is asked for as the sheet
 * opens (`ClientSheet`), so it has usually answered before Details is
 * chosen.
 */
export function ClientXeroLines({
  businessId,
  businessSlug,
  clientId,
  clientName,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  clientId: Id<'clients'>
  clientName: string
  timezone: string
}) {
  const lines: ReadonlyArray<XeroLine> | undefined = useQuery(
    rq.xeroClientLines(businessId, clientId),
  ).data
  if (!lines || lines.length === 0) return null
  return (
    <XeroLineRows
      businessId={businessId}
      businessSlug={businessSlug}
      clientId={clientId}
      clientName={clientName}
      timezone={timezone}
      lines={lines}
    />
  )
}

/**
 * The rows themselves, for whatever lines there are: what the UI harness
 * renders, every state at once.
 */
export function XeroLineRows({
  businessId,
  businessSlug,
  clientId,
  clientName,
  timezone,
  lines,
  canEditClient,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  clientId: Id<'clients'>
  clientName: string
  timezone: string
  lines: ReadonlyArray<XeroLine>
  /** Whether the person looking may change the client — a problem's next
   * step is then theirs, else the business owner's to be asked. Their own
   * capability unless given (the UI harness). */
  canEditClient?: boolean
}) {
  const mayEdit = useCan('clients.manage')
  const named = lines.length > 1
  return (
    <>
      {lines.map((line) => (
        <XeroLineRow
          key={line.connectionId}
          businessId={businessId}
          businessSlug={businessSlug}
          clientId={clientId}
          clientName={clientName}
          timezone={timezone}
          line={line}
          named={named}
          canEdit={canEditClient ?? mayEdit}
        />
      ))}
    </>
  )
}

/**
 * One organisation's row. "Xero", or "Xero · {org}" when there are two, so
 * the two can be told apart; with one, the organisation goes under the
 * value instead.
 */
function XeroLineRow({
  businessId,
  businessSlug,
  clientId,
  clientName,
  timezone,
  line,
  named,
  canEdit,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  clientId: Id<'clients'>
  clientName: string
  timezone: string
  line: XeroLine
  named: boolean
  canEdit: boolean
}) {
  const label = named ? `Xero · ${line.orgName}` : 'Xero'
  const org = named ? null : line.orgName
  const sent =
    line.lastSentAt === null
      ? null
      : `sent ${formatWhen(line.lastSentAt, timezone)}`
  const open = line.openUrl ? (
    <OpenInXero url={line.openUrl} orgName={line.orgName} />
  ) : null
  // In Xero, but something didn't go with it: said under the row, with
  // Open in Xero to look.
  const note = line.problemCode ? (
    <Below>
      <Warning>{syncProblemCopy(line.problemCode, { canEdit })}</Warning>
      {open}
    </Below>
  ) : (
    open
  )
  const settings = line.kind === 'business' ? 'Xero' : 'My Xero'
  // The row itself, for focus to come back to once Send PestM8's details
  // has gone through: its button goes with the Different state, and the
  // same row stays, as Waiting.
  const row = useRef<HTMLDivElement>(null)
  // The fields asked about, while the confirm is open: kept as they were
  // when it opened, as the row moves on under it.
  const [asking, setAsking] = useState<ReadonlyArray<string> | null>(null)

  const element = (() => {
    switch (line.state) {
      case 'in_xero':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="In Xero"
            sub={sentence([org, sent])}
            below={note}
          />
        )
      case 'waiting':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Waiting to send"
            sub={org ?? undefined}
            below={note}
          />
        )
      case 'lead':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Lead"
            sub="Added to Xero when first booked"
          />
        )
      case 'to_check':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="To check"
            sub={org ?? undefined}
            below={
              <Below>
                <Warning>
                  {line.candidateName
                    ? `Xero already has “${line.candidateName}”. Decide in Settings → ${settings}.`
                    : `Xero may already have ${clientName}. Decide in Settings → ${settings}.`}
                </Warning>
                <MatchLink kind={line.kind} businessSlug={businessSlug} />
              </Below>
            }
          />
        )
      case 'archived':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Archived in Xero"
            sub={sentence([org, 'PestM8 no longer sends its changes there'])}
            below={open}
          />
        )
      case 'gdpr':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Removed in Xero"
            sub={sentence([org, 'For privacy, so PestM8 won’t send it again'])}
          />
        )
      case 'different':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Different in Xero"
            sub={sentence([org, sent])}
            below={
              <Below>
                <Warning>{differentCopy(line.different, clientName)}</Warning>
                {/* One above the other: side by side, "Send PestM8’s
                  details" ran to two lines on a phone. */}
                <div className="flex flex-col gap-2">
                  {line.canOverwrite && (
                    <SendOursButton onAsk={() => setAsking(line.different)} />
                  )}
                  {open}
                </div>
              </Below>
            }
          />
        )
      case 'failed':
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Not sent"
            sub={org ?? undefined}
            below={
              <Below>
                <Warning>
                  {syncProblemCopy(line.problemCode, { canEdit })}
                </Warning>
                {open}
              </Below>
            }
          />
        )
      default:
        return (
          <DetailRow
            focusRef={row}
            label={label}
            value="Not in Xero yet"
            sub={org ?? undefined}
          />
        )
    }
  })()

  return (
    <>
      {element}
      {/* Beside the row rather than in it, so it closes as a confirm should
          — focus back on the row — when the row stops being Different. */}
      <SendOursDialog
        businessId={businessId}
        clientId={clientId}
        clientName={clientName}
        line={line}
        fields={asking}
        onClose={() => setAsking(null)}
        row={row}
      />
    </>
  )
}

/** "Pest M8 Pest Control · sent Thu 16 Oct, 9:30am" — the parts there are,
 * the first one capitalised, as a row's line under its value. */
function sentence(parts: ReadonlyArray<string | null>): string | undefined {
  const line = parts.filter(Boolean).join(' · ')
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : undefined
}

function Below({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>
}

/** What needs someone, under the row: amber words (a warning, §2.2). */
function Warning({ children }: { children: ReactNode }) {
  return <p className="text-caption text-amber-ink">{children}</p>
}

/** The match page this organisation's To check is decided on. */
function MatchLink({
  kind,
  businessSlug,
}: {
  kind: XeroKind
  businessSlug: string
}) {
  return (
    <Link
      to={
        kind === 'business'
          ? '/$businessSlug/settings/xero/match'
          : '/$businessSlug/settings/my-xero/match'
      }
      params={{ businessSlug }}
      className={`${LINK_BUTTON_COMPACT} flex w-full items-center justify-center`}
    >
      Match your clients
    </Link>
  )
}

/**
 * Open in Xero: a hold, like Map, opening the contact in a new tab — never
 * this window, which would unload the installed app. Only to Xero's own
 * pages. Where the browser refuses the tab anyway, it becomes a plain link
 * for a few seconds, as Map does: a tap on a real link is never blocked.
 */
function OpenInXero({ url, orgName }: { url: string; orgName: string }) {
  const [refused, setRefused] = useState(false)
  const [blocked, setBlocked] = useState(false)

  // The link appears once the lift's own trailing click has passed: put in
  // the button's place at once, it would take that click and open Xero a
  // second time where the first did open.
  useEffect(() => {
    if (!refused) return
    const timer = window.setTimeout(() => {
      setRefused(false)
      setBlocked(true)
    }, TOUCH_CLICK_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [refused])
  useEffect(() => {
    if (!blocked) return
    const timer = window.setTimeout(() => setBlocked(false), FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [blocked])

  if (!isXeroUrl(url)) return null
  // A button only stretches across when told to.
  const className = `${LINK_BUTTON_COMPACT} flex w-full min-w-0 items-center justify-center`
  const word = (text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <ExternalLink aria-hidden size={15} strokeWidth={2} />
      {text}
    </span>
  )

  if (blocked) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open in Xero, in ${orgName}`}
        onClick={() => setBlocked(false)}
        className={className}
      >
        {word('Open')}
      </a>
    )
  }
  return (
    <HoldButton
      ariaLabel={`Open in Xero, in ${orgName}`}
      onComplete={() => {
        if (!openMapTab(url)) setRefused(true)
      }}
      hint={word('Hold to open Xero')}
      className={className}
    >
      {word('Open in Xero')}
    </HoldButton>
  )
}

function isXeroUrl(url: string): boolean {
  try {
    return new URL(url).origin === XERO_WEB_ORIGIN
  } catch {
    return false
  }
}

/**
 * "Send PestM8’s details", for a client whose details Xero holds otherwise:
 * asked first (`SendOursDialog`), since it replaces what someone typed into
 * the books, and nothing in PestM8 can put it back.
 */
function SendOursButton({ onAsk }: { onAsk: () => void }) {
  const hydrated = useHydrated()
  return (
    <button
      type="button"
      disabled={!hydrated}
      onClick={onAsk}
      className={`${SECONDARY_BUTTON_COMPACT} w-full`}
    >
      Send PestM8’s details
    </button>
  )
}

/**
 * Its confirm. Fails fast with no signal. Once it has gone through, the row
 * moves on to Waiting by itself (the query is live), and focus goes back to
 * the row: the button it was opened from is gone.
 */
function SendOursDialog({
  businessId,
  clientId,
  clientName,
  line,
  fields,
  onClose,
  row,
}: {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
  clientName: string
  line: XeroLine
  /** The fields asked about; null while it is closed. */
  fields: ReadonlyArray<string> | null
  onClose: () => void
  row: RefObject<HTMLDivElement | null>
}) {
  const convexOverwrite = useConvexMutation(api.xeroSync.overwrite)
  const overwrite = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      await convexOverwrite({
        businessId,
        connectionId: line.connectionId,
        clientId,
      })
    },
    onSuccess: onClose,
  })
  const open = fields !== null
  // A fresh ask starts without the last one's refusal.
  const { reset } = overwrite
  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Send PestM8’s details to Xero?"
      body={`${line.orgName} takes PestM8’s ${fieldList(fields ?? line.different)} for ${clientName} in place of its own. This can’t be undone from PestM8.`}
      confirm="Send"
      cancel="Keep Xero’s"
      onConfirm={() => overwrite.mutate()}
      returnFocus={(confirmed) => (confirmed ? row.current : null)}
      pending={overwrite.isPending}
      pendingLabel="Sending…"
      closeOnConfirm={false}
      error={
        overwrite.isError
          ? describeError(overwrite.error, OVERWRITE_ERROR_COPY)
          : undefined
      }
    />
  )
}
