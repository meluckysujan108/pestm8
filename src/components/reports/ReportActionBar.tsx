import { useState } from 'react'
import { CalendarClock, Send } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { sgarFollowUp } from '#/lib/reportTemplates/sgar'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Segmented } from '../primitives/Segmented'
import { api } from '../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import {
  DeliveryHistory,
  LatestDelivery,
  SendSheet,
  newAddressLine,
  senderName,
} from './SendSheet'
import { ReportPdfCard } from './ReportPdfCard'
import { ReportPdfViewer } from './ReportPdfViewer'
import { replacedBadge } from './reportPdfModel'
import { useReportPdf } from './useReportPdf'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import { documentIdentity } from '#/lib/reportTemplates/documentModel'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { PresentContext } from '#/lib/reportTemplates/present'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'
import { NEUTRAL_BUTTON } from '#/components/primitives/buttons'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { RowPending } from '#/components/shell/Pending'
import { formatWhen } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { dateTimeFormat, dayKeyOf } from '../../../convex/lib/dates'

const TABS = [
  { value: 'form' as const, label: 'Form' },
  { value: 'pdf' as const, label: 'PDF' },
  { value: 'email' as const, label: 'Email' },
  { value: 'logs' as const, label: 'Logs' },
]

type Tab = (typeof TABS)[number]['value']

/**
 * When a rodent treatment has to be gone back to.
 *
 * The APVMA suspended second-generation anticoagulant rodenticides on 24 March
 * 2026 with replacement label instructions, one of which is an evaluation
 * within 35 days. The Service Report's method list carries that instruction
 * verbatim, so a finished report already knows — and the person who needs to
 * act on it is looking at the report, not at a calendar.
 *
 * It says so and links to the day. Booking the visit is a decision with a
 * price and a person attached, and this knows neither.
 */
function SgarNotice({
  businessSlug,
  report,
}: {
  businessSlug: string
  report: SendableReport
}) {
  const timezone = useBusinessTimezone()
  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    templateSnapshot: report.templateSnapshot,
  })
  const due = sgarFollowUp(
    template,
    (report.data ?? {}) as Record<string, unknown>,
    report.finalisedAt,
  )
  if (!due) return null

  const day = dateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(new Date(due.dueBy))

  return (
    <div className="mx-4 mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-line bg-amber-bg px-3.5 py-3">
      <CalendarClock
        size={16}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-amber-ink"
      />
      <div className="min-w-0 flex-1">
        <p className="text-caption text-amber-ink">
          {/* A suspension with replacement label instructions — never a "ban",
              never "new legislation". */}
          This treatment used an SGAR. APVMA label instructions require an
          evaluation within 35 days, so by {day}
          {due.daysRemaining < 0 ? ' — which has passed' : ''}.
        </p>
        <Link
          to="/$businessSlug/schedule"
          params={{ businessSlug }}
          search={{ date: dayKeyOf(due.dueBy, timezone) }}
          className="mt-1 inline-block text-caption font-semibold text-amber-ink underline"
        >
          Open that week
        </Link>
      </div>
    </div>
  )
}

/** What the send sheet needs from `reports.get`, and nothing more. */
export type SendableReport = {
  template: TemplateId | 'custom'
  templateVersion?: number
  customTemplate?: CustomTemplateShape | null
  templateSnapshot?: CustomTemplateShape | null
  data: unknown
  context?: PresentContext | null
  businessName: string
  finalisedAt?: number
  property: { addressLine: string; suburb: string } | null
}

/**
 * Only shown once a report is finalised — a draft has no finished document to
 * email and nothing worth logging yet, and its PDF is a watermarked preview
 * opened from the sheet that locks it (`ReportBuilder`), not a tab.
 *
 * The PDF opens full-screen, and the address says so (`?view=pdf`): the route
 * owns getting there and back, so the phone's back gesture closes the viewer
 * rather than leaving the report. This owns the PDF itself — the one render
 * the tab and the viewer share — and mounts the viewer once hydrated.
 */
export function ReportActionBar({
  businessId,
  businessSlug,
  reportId,
  pdfUrl,
  title,
  fileName,
  report,
  replaced,
  viewing,
  onView,
  onCloseView,
  children,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  reportId: Id<'reports'>
  pdfUrl: string | null
  /** The document's title, as the PDF prints it. */
  title: string
  fileName: string
  /** Enough of the finalised report for the send sheet to know who it is for. */
  report: SendableReport
  /** Set when a correction has replaced this document. */
  replaced?: {
    supersededBy: Id<'reports'>
    reportNumber?: number
    version?: number
  }
  /** The PDF is open full-screen (`?view=pdf`). */
  viewing: boolean
  onView: () => void
  onCloseView: () => void
  children: ReactNode
}) {
  // Straight onto the PDF tab when the page opened on the viewer (a refresh,
  // a shared link), so closing it lands where View PDF lives.
  const [tab, setTab] = useState<Tab>(() => (viewing ? 'pdf' : 'form'))
  // The finalised report is server-rendered: a tap on "PDF" before hydration
  // would land on a button with no handler and quietly do nothing.
  const hydrated = useHydrated()
  const pdf = useReportPdf({ businessId, reportId, pdfUrl })

  return (
    <>
      <SgarNotice businessSlug={businessSlug} report={report} />

      {/* Where it went, above every tab: locking sends it, and this is the
          page that opens straight after. */}
      <LatestDelivery
        businessId={businessId}
        reportId={reportId}
        onOpen={() => setTab('email')}
      />

      <div className="px-4 pt-4">
        <Segmented
          label="Report view"
          value={tab}
          options={TABS}
          onChange={setTab}
          disabled={!hydrated}
        />
      </div>

      {tab === 'form' && children}

      {tab === 'pdf' && (
        <ReportPdfCard
          businessSlug={businessSlug}
          title={title}
          pdf={pdf}
          hydrated={hydrated}
          onView={onView}
          replaced={replaced}
        />
      )}

      {tab === 'email' && (
        <EmailPanel
          businessId={businessId}
          reportId={reportId}
          report={report}
        />
      )}

      {tab === 'logs' && (
        <LogsPanel businessId={businessId} reportId={reportId} />
      )}

      {hydrated && viewing && (
        <ReportPdfViewer
          businessId={businessId}
          reportId={reportId}
          title={title}
          fileName={fileName}
          pdf={pdf}
          badge={replaced ? replacedBadge(replaced.version) : undefined}
          onClose={onCloseView}
        />
      )}
    </>
  )
}

/**
 * What the Email tab is now: what has happened, and one way to make more
 * happen. The form it replaced was an empty box that a technician had to type
 * a remembered address into, on a phone, having just answered a question on
 * the form about who should get a copy.
 */
function EmailPanel({
  businessId,
  reportId,
  report,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  report: SendableReport
}) {
  const hydrated = useHydrated()
  const [sending, setSending] = useState(false)

  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    // The wording it was SIGNED against: a report sent after the form was
    // reworded must not offer recipients a different form asked for.
    templateSnapshot: report.templateSnapshot,
  })

  return (
    <div className="px-4 pb-8 pt-5">
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => setSending(true)}
        className={`${NEUTRAL_BUTTON} flex w-full items-center justify-center gap-2`}
      >
        <Send size={16} strokeWidth={2} />
        Send this report
      </button>

      <h2 className="section-label mb-2 mt-6">Delivery history</h2>
      <DeliveryHistory businessId={businessId} reportId={reportId} />

      <SendSheet
        open={sending}
        onClose={() => setSending(false)}
        businessId={businessId}
        reportId={reportId}
        template={template}
        data={(report.data ?? {}) as Record<string, unknown>}
        clientEmail={report.context?.client?.email}
        subject={
          documentIdentity({
            template,
            property: report.property,
            businessName: report.businessName,
            finalisedAt: report.finalisedAt,
          }).title
        }
      />
    </div>
  )
}

/**
 * A report's Logs tab: everything done to it, newest first — who started,
 * edited and finalised it, and every email of it, with who it went to, where
 * the business's copy went, and which addresses were new to the client.
 * Exported for the UI harness.
 */
export function LogsPanel({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}) {
  const logs = useQuery(
    convexQuery(api.auditLog.forEntity, {
      businessId,
      entityType: 'reports',
      entityId: reportId,
    }),
  )
  const entries = logs.data

  return (
    <div className="px-4 pt-5 pb-8">
      <h2 className="section-label mb-2">Activity</h2>
      {entries === undefined && logs.isError ? (
        <LoadFailed what="the activity" onRetry={() => void logs.refetch()} />
      ) : entries === undefined ? (
        // Loading is not the same as nothing: "Nothing logged yet." under a
        // report that was finalised and emailed is a lie an owner checking
        // who sent it where would believe.
        <RowPending className="py-1" />
      ) : entries.length === 0 ? (
        <p className="text-caption text-muted">Nothing logged yet.</p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {entries.map((entry) => (
            <LogRow key={entry._id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** Every action a report's history can hold, in words: a code on screen
 * tells an owner reading who did what nothing. */
const ACTION_LABEL: Record<string, string> = {
  'report.create': 'Started',
  'report.edit': 'Edited',
  'report.edit.byOwner': 'Edited by the owner',
  'report.optionRenamed': 'An answer was renamed with its list',
  'report.switchVersion': 'Moved to the current form',
  'report.restart': 'Started again on the current form',
  'report.amend': 'Started as a correction',
  'report.delete': 'Moved to Recently Deleted',
  'report.restore': 'Restored',
  'report.purge': 'Deleted for good',
  'report.finalise': 'Finalised',
  'report.email': 'Emailed',
  'report.email.sent': 'Emailed',
  'report.email.failed': 'Email failed',
  'report.email.bounced': 'Email bounced',
  // Written before approval was retired (29 Sept 2026), and kept as they
  // happened: nothing writes them now.
  'report.email.pending_approval': 'Held for approval',
  'report.email.approved': 'Approved to send',
  'report.email.rejected': 'Not approved',
}

function LogRow({
  entry,
}: {
  entry: {
    _id: string
    action: string
    meta: unknown
    at: number
    actorName?: string
    actorColour?: string
    /** The account it was done in, when that was not the actor's own.
     * Absent from a backend older than switching's audit rows. */
    onBehalfOfName?: string
  }
}) {
  const timezone = useBusinessTimezone()
  // What `email.deliver` records about a send (`addressedTo`): an older row
  // has only `to`.
  const meta = (entry.meta ?? {}) as {
    to?: string | Array<string>
    cc?: Array<string>
    bcc?: Array<string>
    newAddresses?: Array<string>
    trigger?: 'finalise' | 'manual'
    /** On a provider event: a bounce, or the recipient marking it spam. */
    event?: 'bounced' | 'complained'
    detail?: string
  }
  const to = Array.isArray(meta.to) ? meta.to.join(', ') : meta.to
  // The business's blind copy, and a visible cc on a row from before copies
  // were blind — as the Email tab lists them.
  const copies = [...new Set([...(meta.bcc ?? []), ...(meta.cc ?? [])])]
  return (
    <li className="flex gap-2.5 px-3.5 py-3">
      {/* The member's own colour, as the schedule and the notes list use it. */}
      {entry.actorColour && (
        <span
          aria-hidden
          className="mt-1.5 size-2 shrink-0 rounded-full"
          style={{ background: entry.actorColour }}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">
          {entry.action === 'report.email.bounced' &&
          meta.event === 'complained'
            ? 'Marked as spam'
            : (ACTION_LABEL[entry.action] ?? entry.action)}
          {to ? ` — ${to}` : ''}
        </p>
        {/* Grey-ink, not muted: with no approval step, who did it — and in
            whose account — is the record an owner reads. */}
        <p className="text-caption text-grey-ink">
          {/* Who, not just what: "Emailed" beside a colour dot tells an owner
              nothing, and who did it is the question a history answers. */}
          {entry.actorName
            ? `${senderName(entry.actorName, entry.onBehalfOfName)} · `
            : ''}
          {formatWhen(entry.at, timezone)}
          {meta.trigger === 'finalise' ? ' · asked for by the form' : ''}
        </p>
        {/* Only on a send that went: on a failure it would read as though
            the copy had gone when nothing did. */}
        {entry.action === 'report.email.sent' && copies.length > 0 && (
          <p className="text-caption text-muted">Copy to {copies.join(', ')}</p>
        )}
        {/* Nothing waits for an owner any more; this is how one sees that a
            report went somewhere the client's record does not have. */}
        {meta.newAddresses && meta.newAddresses.length > 0 && (
          <p className="text-caption text-ink-2">
            {newAddressLine(meta.newAddresses)}
          </p>
        )}
        {/* A line from before approval was retired, which nothing will ever
            follow up: `migrations/heldDeliveriesV1` wrote no line of its own. */}
        {entry.action === 'report.email.pending_approval' && (
          <p className="text-caption text-ink-2">
            Approval isn’t needed any more. The Email tab shows whether it went.
          </p>
        )}
        {meta.detail && (
          <p className="mt-1 text-caption text-amber-ink">{meta.detail}</p>
        )}
      </div>
    </li>
  )
}
