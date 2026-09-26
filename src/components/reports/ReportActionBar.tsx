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
import { DeliveryHistory, SendSheet } from './SendSheet'
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

  const day = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
  }).format(new Date(due.dueBy))

  return (
    <div className="mx-4 mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-line bg-amber-bg px-3.5 py-3">
      <CalendarClock
        size={16}
        strokeWidth={1.9}
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
          search={{ date: dayKey(due.dueBy) }}
          className="mt-1 inline-block text-caption font-semibold text-amber-ink underline"
        >
          Open that week
        </Link>
      </div>
    </div>
  )
}

/** `2026-10-22` — the shape the schedule's `?date=` takes. */
function dayKey(at: number): string {
  const when = new Date(at)
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(
    when.getDate(),
  ).padStart(2, '0')}`
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

function LogsPanel({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}) {
  const { data: logs } = useQuery(
    convexQuery(api.auditLog.forEntity, {
      businessId,
      entityType: 'reports',
      entityId: reportId,
    }),
  )

  return (
    <div className="px-4 pt-5 pb-8">
      <h2 className="section-label mb-2">Activity</h2>
      {!logs || logs.length === 0 ? (
        <p className="text-caption text-muted">Nothing logged yet.</p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {logs.map((entry) => (
            <LogRow key={entry._id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<string, string> = {
  'report.create': 'Started',
  'report.edit': 'Edited',
  'report.finalise': 'Finalised',
  'report.email.sent': 'Emailed',
  'report.email.failed': 'Email failed',
  'report.email.pending_approval': 'Held for approval',
  'report.email.approved': 'Approved to send',
  'report.email.rejected': 'Not approved',
  'report.edit.byOwner': 'Edited by the owner',
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
  const meta = (entry.meta ?? {}) as {
    to?: string | Array<string>
    detail?: string
  }
  const to = Array.isArray(meta.to) ? meta.to.join(', ') : meta.to
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
          {ACTION_LABEL[entry.action] ?? entry.action}
          {to ? ` — ${to}` : ''}
        </p>
        <p className="text-caption text-muted">
          {/* Who, not just what: "Emailed" beside a colour dot tells an owner
              nothing, and who did it is the question a history answers. */}
          {entry.actorName
            ? entry.onBehalfOfName
              ? `${entry.actorName}, in ${entry.onBehalfOfName}’s account · `
              : `${entry.actorName} · `
            : ''}
          {new Intl.DateTimeFormat('en-AU', {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(entry.at))}
        </p>
        {meta.detail && (
          <p className="mt-1 text-caption text-amber-ink">{meta.detail}</p>
        )}
      </div>
    </li>
  )
}
