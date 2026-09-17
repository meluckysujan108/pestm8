import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexAction } from '@convex-dev/react-query'
import { Check, Plus, Send, ShieldAlert } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import { deliveryRecipients } from '#/lib/reportTemplates/delivery'
import type { ReportTemplate } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Sending a finished report to the people it is for.
 *
 * What this replaces was one empty email box. A technician who had just
 * finished a form that asks, in writing, whether to send a copy to the client
 * then had to remember the client's address and type it, on a phone, in a
 * driveway — and if they typed it wrong the document went nowhere and nothing
 * said so.
 *
 * So the addresses the form already asked for are offered as chips, already
 * chosen. Anyone else is one tap and a typed address away, and the sheet says
 * plainly — before Send, not after — when that address is one only an owner
 * can approve.
 */

type Recipient = { address: string; chosen: boolean; known: boolean }

const SEND_ERROR: Record<string, string> = {
  EMAIL_NOT_CONFIGURED: 'Email sending isn’t set up for this business yet.',
  RECIPIENT_NEEDS_APPROVAL:
    'Sent to the owner to approve — it will go once they say yes.',
  REPORT_NOT_FINALISED: 'This report isn’t finalised yet.',
  PDF_UNAVAILABLE: 'Could not prepare the PDF to attach.',
  EMAIL_SEND_FAILED: 'The email failed to send. The history below says why.',
  SEND_RATE_LIMITED:
    'That is a lot of reports in an hour. Try again shortly, or ask an owner.',
  NO_RECIPIENT: 'Choose at least one person to send it to.',
}

export function SendSheet({
  open,
  onClose,
  businessId,
  reportId,
  template,
  data,
  clientEmail,
  subject,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  /** The wording this report was signed against. */
  template: ReportTemplate
  data: Record<string, unknown>
  clientEmail?: string
  /** What the email will say it is — the document's own name. */
  subject: string
}) {
  const { data: known } = useQuery(
    convexQuery(api.deliveries.known, { businessId, reportId }),
  )
  const { data: history } = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )

  // `undefined` means "not yet", which is not the same as "nobody is on
  // file" — and the difference matters, because the second one puts a "Needs
  // approval" warning against the client's own address. The same mistake the
  // finalise sheet made about signatures.
  const settled = known !== undefined
  const knownAddresses = known?.addresses ?? []
  const unrestricted = known?.unrestricted ?? false

  /**
   * Who the form asked for, plus anyone this report has already gone to.
   * Chosen by default only where the form asked: a second copy to someone who
   * already has one is a decision, not a default.
   */
  const suggested = useMemo(() => {
    const asked = deliveryRecipients(template, data, { clientEmail }).to
    const before = (history ?? []).flatMap((row) => row.to)
    const seen = new Set<string>()
    const out: Array<Recipient> = []
    for (const address of [...asked, ...before]) {
      if (seen.has(address)) continue
      seen.add(address)
      out.push({
        address,
        chosen: asked.includes(address),
        known: knownAddresses.includes(address),
      })
    }
    return out
  }, [template, data, clientEmail, history, knownAddresses])

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [added, setAdded] = useState<Array<string>>([])
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  const recipients: Array<Recipient> = [
    ...suggested.map((entry) => ({
      ...entry,
      chosen: overrides[entry.address] ?? entry.chosen,
    })),
    ...added.map((address) => ({
      address,
      chosen: overrides[address] ?? true,
      known: knownAddresses.includes(address),
    })),
  ]
  const chosen = recipients.filter((entry) => entry.chosen)
  const needsApproval =
    settled && !unrestricted && chosen.some((entry) => !entry.known)

  const convexSend = useConvexAction(api.email.sendReportPdf)

  /**
   * One send per recipient, and one outcome per recipient.
   *
   * They genuinely can differ — a client's own address goes while a strata
   * office's waits for the owner — so a single pass/fail for the whole tap
   * would report one of them wrongly. Nothing throws: the summary below says
   * what happened to each.
   */
  const send = useMutation({
    mutationFn: async (addresses: Array<string>) => {
      const results: Array<{ address: string; code: string | null }> = []
      for (const address of addresses) {
        try {
          await convexSend({ businessId, reportId, to: address })
          results.push({ address, code: null })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          results.push({
            address,
            code:
              Object.keys(SEND_ERROR).find((code) => message.includes(code)) ??
              'UNKNOWN',
          })
        }
      }
      return results
    },
  })

  const outcomes = send.data ?? []
  const sent = outcomes.filter((result) => result.code === null)
  const held = outcomes.filter((result) => result.code === 'RECIPIENT_NEEDS_APPROVAL')
  const failed = outcomes.filter(
    (result) => result.code !== null && result.code !== 'RECIPIENT_NEEDS_APPROVAL',
  )

  function addTyped() {
    const address = draft.trim().toLowerCase()
    if (address === '' || !address.includes('@')) return
    if (!added.includes(address)) setAdded((prev) => [...prev, address])
    setDraft('')
    setAdding(false)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Send this report"
      description={subject}
      footer={
        <button
          type="button"
          disabled={chosen.length === 0 || send.isPending || !settled}
          onClick={() => send.mutate(chosen.map((entry) => entry.address))}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[17px] font-semibold text-surface transition active:scale-[.975] disabled:opacity-50"
        >
          <Send size={16} strokeWidth={2} />
          {send.isPending
            ? 'Sending…'
            : needsApproval
              ? 'Request approval'
              : `Send to ${chosen.length === 1 ? '1 person' : `${chosen.length} people`}`}
        </button>
      }
    >
      {recipients.length === 0 && !adding && (
        <p className="text-body text-muted">
          This form did not ask for a copy to go anywhere. Add an address
          below and it will go there.
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {recipients.map((entry) => (
          <li key={entry.address}>
            <button
              type="button"
              aria-pressed={entry.chosen}
              onClick={() =>
                setOverrides((prev) => ({
                  ...prev,
                  [entry.address]: !entry.chosen,
                }))
              }
              className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                entry.chosen
                  ? 'border-ink/15 bg-surface'
                  : 'border-hairline bg-surface-2 opacity-60'
              }`}
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-md ${
                  entry.chosen ? 'bg-ink text-surface' : 'bg-surface-3'
                }`}
              >
                {entry.chosen && <Check size={13} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-body text-ink">
                {entry.address}
              </span>
              {/* Said before Send, not after: a technician should know their
                  request is going to the owner before they make it. */}
              {settled && entry.chosen && !entry.known && !unrestricted && (
                <span className="flex shrink-0 items-center gap-1 text-caption text-amber-ink">
                  <ShieldAlert size={13} strokeWidth={2} />
                  Needs approval
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="mt-2 flex gap-2">
          <input
            autoFocus
            type="email"
            inputMode="email"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTyped()
              }
            }}
            aria-label="Email address"
            placeholder="name@example.com"
            className="h-11 min-w-0 flex-1 rounded-xl bg-surface-3 px-3 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
          <button
            type="button"
            onClick={addTyped}
            className="shrink-0 rounded-xl bg-surface-2 px-3.5 text-[15px] font-semibold text-ink"
          >
            Add
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 flex items-center gap-1.5 rounded-xl px-1 py-2 text-body font-semibold text-ink"
        >
          <Plus size={15} strokeWidth={2.2} />
          Send to someone else
        </button>
      )}

      {outcomes.length > 0 && (
        <div role="status" className="mt-3 flex flex-col gap-1.5">
          {sent.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              Sent to {sent.map((result) => result.address).join(', ')}.
            </p>
          )}
          {held.length > 0 && (
            <p className="rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-caption text-ink-2">
              {SEND_ERROR.RECIPIENT_NEEDS_APPROVAL}{' '}
              {held.map((result) => result.address).join(', ')}
            </p>
          )}
          {failed.map((result) => (
            <p
              key={result.address}
              className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
            >
              {result.address} —{' '}
              {(result.code && SEND_ERROR[result.code]) ??
                'Could not send the email.'}
            </p>
          ))}
        </div>
      )}
    </Sheet>
  )
}

/**
 * Every attempt to send this report, and how each one went.
 *
 * Read from the delivery rows rather than the audit log: a row exists from the
 * moment someone asks, so a send that is waiting on an owner or that died
 * mid-flight appears here too, rather than only the ones that finished.
 */
export function DeliveryHistory({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}) {
  const { data: rows } = useQuery(
    convexQuery(api.deliveries.forReport, { businessId, reportId }),
  )

  // Loading is not the same as nothing: "Not sent yet." under a report the
  // form already opened a delivery for is a lie, and one a technician would
  // act on by sending it again.
  if (rows === undefined) {
    return <p className="text-caption text-muted">Loading…</p>
  }
  if (rows.length === 0) {
    return <p className="text-caption text-muted">Not sent yet.</p>
  }

  return (
    <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
      {rows.map((row) => (
        <li key={row._id} className="px-3.5 py-3">
          <p className="text-body text-ink">
            {STATUS_LABEL[row.status]} — {row.to.join(', ')}
          </p>
          <p className="text-caption text-muted">
            {row.sentBy?.name ? `${row.sentBy.name} · ` : ''}
            {new Intl.DateTimeFormat('en-AU', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(row.sentAt ?? row.createdAt))}
            {row.trigger === 'finalise' ? ' · asked for by the form' : ''}
          </p>
          {row.status === 'pendingApproval' && row.approvedBy === null && (
            <p className="mt-1 text-caption text-amber-ink">
              Waiting for an owner to approve this address.
            </p>
          )}
          {row.error && (
            <p className="mt-1 text-caption text-amber-ink">{row.error}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  pendingApproval: 'Waiting for approval',
  sent: 'Sent',
  failed: 'Failed',
  bounced: 'Bounced',
}
