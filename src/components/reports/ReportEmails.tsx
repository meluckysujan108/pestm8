import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  Check,
  ChevronRight,
  LoaderCircle,
  Send,
  TriangleAlert,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import { Sheet } from '#/components/primitives/Sheet'
import {
  LINK_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'
import { RowPending } from '#/components/shell/Pending'
import { formatWhen } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { senderName } from './SendSheet'
import { deliveryState } from './deliveryWords'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'

type Delivery = FunctionReturnType<typeof api.deliveries.forReport>[number]

/**
 * Where a finished report went: every email of it, newest first — who it
 * went to, how it got on and, when it did not go, what to do. A row is a
 * line or two; tapping it shows the whole of that email (`DeliverySheet`).
 *
 * Locking is what sends a report — the form asks whether to send the client a
 * copy "when you submit this form" — so the page a technician lands on after
 * Finalise is where "did it go, and to whom?" is answered: "Sending…" for the
 * few seconds the PDF takes to draw, then who it went to and where the
 * business's copy went. Not emailed at all, it offers the client in one tap:
 * "can you email me that?" is asked at the door.
 *
 * Read from the delivery rows rather than the audit log: a row exists from the
 * moment someone asks, so a send still on its way, or one that died
 * mid-flight, appears here too, rather than only the ones that finished.
 *
 * "Sent" means the email service took it (no delivery webhook is registered),
 * so nothing here claims more than that.
 */
export function ReportEmails({
  businessId,
  reportId,
  hydrated,
  client,
  fileName,
  onSendAgain,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  hydrated: boolean
  /** The client and their address, offered when nothing has been sent. */
  client: { name: string; address: string } | null
  /** What the attachment is called (`documentIdentity`). */
  fileName: string
  /** Opens the Send sheet with these addresses chosen. */
  onSendAgain: (addresses: ReadonlyArray<string>) => void
}) {
  const timezone = useBusinessTimezone()
  const history = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )
  const rows = history.data
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<Delivery | null>(null)
  const now = useClock((rows ?? []).some((row) => row.status === 'queued'))
  const stuckOf = (row: Delivery) =>
    row.status === 'queued' &&
    !row.waitingForEmailSetup &&
    now - row.createdAt > STUCK_AFTER_MS

  // The business's copy is the same on every email of a report (one address,
  // `businessCopyAddress`), so it is said once under the list rather than on
  // every row — unless the rows disagree (an old row's visible cc), when each
  // email's sheet says its own.
  const copyLines = new Set(
    (rows ?? [])
      // Only sends that went or are still on their way: a copy of one that
      // never went went nowhere either.
      .filter(
        (row) =>
          row.status === 'sent' ||
          (row.status === 'queued' &&
            !row.waitingForEmailSetup &&
            !stuckOf(row)),
      )
      .map((row) => copiesOf(row).join(', ')),
  )
  const sharedCopy = copyLines.size === 1 ? ([...copyLines][0] ?? '') : null

  return (
    <section aria-labelledby="report-emails">
      <h2 id="report-emails" className="section-label mb-2">
        Email
      </h2>
      {rows === undefined && history.isError ? (
        <LoadFailed
          what="where this report was sent"
          onRetry={() => void history.refetch()}
        />
      ) : rows === undefined ? (
        // Loading is not the same as nothing: "Not emailed yet" under a report
        // the form already sent is a lie, and one a technician would act on by
        // sending it again.
        <div className="rounded-2xl border border-hairline bg-surface shadow-elevation">
          <RowPending />
        </div>
      ) : rows.length === 0 ? (
        <div className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface shadow-elevation">
          <p className="px-3.5 py-3 text-body text-grey-ink">Not emailed yet</p>
          {client && (
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => onSendAgain([client.address])}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-b-2xl px-3.5 py-2.5 text-left outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
            >
              <Send
                aria-hidden
                size={17}
                strokeWidth={2}
                className="shrink-0 text-blue"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-semibold text-blue">
                  Email {client.name}
                </span>
                <span className="block break-words text-caption text-grey-ink">
                  {client.address}
                </span>
              </span>
              <ChevronRight
                aria-hidden
                size={18}
                strokeWidth={2}
                className="shrink-0 text-muted-2"
              />
            </button>
          )}
        </div>
      ) : (
        <>
          <ul className="divide-y divide-hairline rounded-2xl border border-hairline bg-surface shadow-elevation">
            {(all ? rows : rows.slice(0, SHOWN)).map((row, index) => {
              const state = deliveryState(row, stuckOf(row))
              return (
                <li key={row._id}>
                  <button
                    type="button"
                    disabled={!hydrated}
                    onClick={() => setOpen(row)}
                    className={`flex w-full gap-2.5 px-3.5 pt-3 text-left outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue ${index === 0 ? 'rounded-t-2xl' : ''} ${state.retry ? 'pb-1' : 'pb-3'}`}
                  >
                    <span aria-hidden className="mt-0.5 shrink-0">
                      <StateGlyph warn={state.warn} sending={state.sending} />
                    </span>
                    <span className="min-w-0 flex-1">
                      {/* Whole, never cut off: the end of an address is where
                          a typo in its domain would be. */}
                      <span className="block break-words text-body text-ink">
                        {row.to.join(', ')}
                      </span>
                      {/* Polite, so "Sending…" turning into "Sent" is heard:
                          it changes by itself a few seconds after the page
                          opens. Grey-ink, not muted: who sent it is the
                          record an owner reads. */}
                      <span
                        aria-live="polite"
                        className="block text-caption text-grey-ink"
                      >
                        {state.word} ·{' '}
                        {formatWhen(row.sentAt ?? row.createdAt, timezone)}
                        {row.sentBy?.name
                          ? ` · ${senderName(row.sentBy.name, row.onBehalfOf?.name)}`
                          : ''}
                      </span>
                      {/* Pointed out, never held: the whole of it is in
                          the email's sheet. */}
                      {row.newAddresses && row.newAddresses.length > 0 && (
                        <span className="block text-caption text-ink-2">
                          {row.newAddresses.length === row.to.length
                            ? row.to.length === 1
                              ? 'Wasn’t on the client’s record'
                              : 'None were on the client’s record'
                            : `${row.newAddresses.join(', ')} ${row.newAddresses.length === 1 ? 'wasn’t' : 'weren’t'} on the client’s record`}
                        </span>
                      )}
                      {state.next && (
                        <span className="mt-1 block text-caption text-amber-ink">
                          {state.next}
                        </span>
                      )}
                    </span>
                    <ChevronRight
                      aria-hidden
                      size={16}
                      strokeWidth={2.2}
                      className="mt-1 shrink-0 text-muted-2"
                    />
                  </button>
                  {state.retry && (
                    <div className="pb-1 pl-[2.625rem]">
                      <button
                        type="button"
                        disabled={!hydrated}
                        onClick={() => onSendAgain(row.to)}
                        className="inline-flex min-h-11 items-center rounded-lg px-1 text-caption font-semibold text-blue outline-none transition active:opacity-50 focus-visible:ring-2 focus-visible:ring-blue"
                      >
                        Send again
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
            {rows.length > SHOWN && (
              <li>
                <button
                  type="button"
                  onClick={() => setAll((on) => !on)}
                  className="flex min-h-11 w-full items-center rounded-b-2xl px-3.5 text-body font-semibold text-blue outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
                >
                  {all ? 'Show fewer' : `Show all ${rows.length}`}
                </button>
              </li>
            )}
          </ul>
          {sharedCopy && (
            <p className="mt-2 break-words px-1 text-caption text-grey-ink">
              A copy of each goes to {sharedCopy}
            </p>
          )}
        </>
      )}

      <DeliverySheet
        row={open}
        stuck={open !== null && stuckOf(open)}
        fileName={fileName}
        onClose={() => setOpen(null)}
        onSendAgain={(addresses) => {
          setOpen(null)
          onSendAgain(addresses)
        }}
      />
    </section>
  )
}

function StateGlyph({ warn, sending }: { warn: boolean; sending: boolean }) {
  return warn ? (
    <TriangleAlert size={16} strokeWidth={2} className="text-amber-ink" />
  ) : sending ? (
    <LoaderCircle
      size={16}
      strokeWidth={2}
      className="animate-spin text-muted"
    />
  ) : (
    <Check size={16} strokeWidth={2.2} className="text-green" />
  )
}

/**
 * One email of the report, whole: who it went to and how it got on, who sent
 * it and why, the copy, the subject and attachment as the client got them,
 * which addresses were new to the client, and — when it did not go — why,
 * with Send again. The rows above stay a line or two because this is here.
 */
function DeliverySheet({
  row,
  stuck,
  fileName,
  onClose,
  onSendAgain,
}: {
  row: Delivery | null
  stuck: boolean
  fileName: string
  onClose: () => void
  onSendAgain: (addresses: ReadonlyArray<string>) => void
}) {
  const timezone = useBusinessTimezone()
  // Kept while the sheet slides away, so it does not empty as it closes.
  const [shown, setShown] = useState<Delivery | null>(row)
  useEffect(() => {
    if (row) setShown(row)
  }, [row])
  const state = shown ? deliveryState(shown, stuck) : null
  const copies = shown ? copiesOf(shown) : []

  return (
    <Sheet
      open={row !== null}
      onClose={onClose}
      title="Email"
      description={shown ? shown.to.join(', ') : undefined}
      footer={
        <div className="flex gap-2">
          {shown && state?.retry && (
            <button
              type="button"
              onClick={() => onSendAgain(shown.to)}
              className={`${LINK_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
            >
              <Send size={15} strokeWidth={2} />
              Send again
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Done
          </button>
        </div>
      }
    >
      {shown && state && (
        <>
          {state.next && <FormAlert className="mb-3">{state.next}</FormAlert>}
          <div className="rounded-xl border border-hairline bg-surface">
            <DetailRows>
              <DetailRow
                label={state.word}
                value={formatWhen(shown.sentAt ?? shown.createdAt, timezone)}
              />
              {shown.sentBy?.name && (
                <DetailRow
                  label="Sent by"
                  value={senderName(shown.sentBy.name, shown.onBehalfOf?.name)}
                  sub={
                    shown.trigger === 'finalise'
                      ? 'Asked for by the form, as it was finalised'
                      : undefined
                  }
                />
              )}
              <DetailRow label="Subject" value={shown.subject} />
              <DetailRow
                label="Attached"
                value={/\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`}
                sub={
                  shown.lighterCopy
                    ? 'Photos made smaller to fit an email'
                    : undefined
                }
              />
              {/* Only once it went (or while it is on its way): the copy of
                  one that did not go went nowhere either. */}
              {copies.length > 0 &&
                (shown.status === 'sent' || state.sending) && (
                  <DetailRow label="Business copy" value={copies.join(', ')} />
                )}
              {shown.newAddresses && shown.newAddresses.length > 0 && (
                <DetailRow
                  label="New to the client"
                  value={shown.newAddresses.join(', ')}
                  sub="Wasn’t on the client’s record when it was sent"
                />
              )}
            </DetailRows>
          </div>
        </>
      )}
    </Sheet>
  )
}

/** The newest few, before "Show all". */
const SHOWN = 3

/**
 * How long a delivery may sit queued before it is plainly not on its way.
 *
 * Five minutes, not two, since a report too big to email has its PDF drawn
 * and then a copy with smaller photos made before it goes (convex/emailCopy.ts)
 * — a minute or so for a big job, which two minutes cut close to calling
 * stuck while it was still on its way.
 */
const STUCK_AFTER_MS = 5 * 60_000

/**
 * The time, read again every fifteen seconds while `ticking` — so a page left
 * open stops saying "Sending…" once a queued row has plainly stopped.
 */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/**
 * Who else a delivery went to: the business's blind copy, and — on a row from
 * before copies were blind (29 Sept 2026), or one an API caller asked for —
 * its visible cc.
 */
function copiesOf(row: {
  cc: Array<string>
  bcc?: Array<string>
}): Array<string> {
  return [...new Set([...(row.bcc ?? []), ...row.cc])]
}
