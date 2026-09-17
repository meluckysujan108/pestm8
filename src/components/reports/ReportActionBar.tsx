import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexAction } from '@convex-dev/react-query'
import { Segmented } from '../primitives/Segmented'
import { DownloadPdfButton } from './DownloadPdfButton'
import { api } from '../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import { DeliveryHistory, SendSheet } from './SendSheet'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import { documentIdentity } from '#/lib/reportTemplates/documentModel'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { PresentContext } from '#/lib/reportTemplates/present'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

const LazyPdfViewer = lazy(() =>
  import('./pdf/PdfViewer').then((m) => ({ default: m.PdfViewer })),
)

const TABS = [
  { value: 'form' as const, label: 'Form' },
  { value: 'pdf' as const, label: 'PDF' },
  { value: 'email' as const, label: 'Email' },
  { value: 'logs' as const, label: 'Logs' },
]

type Tab = (typeof TABS)[number]['value']

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
 * Only shown once a report is finalised — a draft has no PDF to view, no
 * finished document to email, and nothing worth logging yet.
 */
export function ReportActionBar({
  businessId,
  reportId,
  pdfUrl,
  fileName,
  report,
  children,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  pdfUrl: string | null
  fileName: string
  /** Enough of the finalised report for the send sheet to know who it is for. */
  report: SendableReport
  children: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('form')
  // The finalised report is server-rendered: a tap on "PDF" before hydration
  // would land on a button with no handler and quietly do nothing.
  const hydrated = useHydrated()

  return (
    <>
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
        <PdfTab
          businessId={businessId}
          reportId={reportId}
          pdfUrl={pdfUrl}
          fileName={fileName}
        />
      )}

      {tab === 'email' && (
        <EmailPanel businessId={businessId} reportId={reportId} report={report} />
      )}

      {tab === 'logs' && (
        <LogsPanel businessId={businessId} reportId={reportId} />
      )}
    </>
  )
}

/**
 * `pdfUrl` is null until something has called `reportPdf.generate` at least
 * once — previously that "something" was only ever a click on
 * `DownloadPdfButton`. Opening the PDF tab is now itself that trigger, so the
 * viewer doesn't need a download click first; the resolved URL is then
 * handed to both the viewer and the download button rather than each
 * independently deciding whether to generate.
 */
function PdfTab({
  businessId,
  reportId,
  pdfUrl,
  fileName,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  pdfUrl: string | null
  fileName: string
}) {
  const hydrated = useHydrated()
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const requested = useRef(false)

  const convexGenerate = useConvexAction(api.reportPdf.generate)
  const generate = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
    }) => convexGenerate(args),
  })

  const url = pdfUrl ?? generatedUrl

  useEffect(() => {
    if (url || requested.current) return
    requested.current = true
    generate
      .mutateAsync({ businessId, reportId })
      .then((result) => {
        if (result.url) setGeneratedUrl(result.url)
        else setFailed(true)
      })
      .catch(() => setFailed(true))
    // `generate` is a fresh object every render (useMutation) — the `requested`
    // ref is the real guard against re-firing, not the dependency array.
  }, [url, businessId, reportId])

  return (
    <div className="px-4 pt-5 pb-8">
      {url ? (
        hydrated ? (
          <Suspense fallback={<PdfViewerSkeleton />}>
            <LazyPdfViewer businessId={businessId} reportId={reportId} url={url} />
          </Suspense>
        ) : (
          <PdfViewerSkeleton />
        )
      ) : failed ? (
        <p role="alert" className="text-center text-caption text-amber-ink">
          Could not prepare the PDF. Check your connection and try again.
        </p>
      ) : (
        <PdfViewerSkeleton />
      )}

      <div className="mt-4">
        <DownloadPdfButton
          businessId={businessId}
          reportId={reportId}
          pdfUrl={url}
          fileName={fileName}
        />
      </div>
    </div>
  )
}

function PdfViewerSkeleton() {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl border border-hairline bg-surface-3">
      <p className="text-caption text-muted">Preparing viewer…</p>
    </div>
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
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[17px] font-semibold text-surface transition active:scale-[.975] disabled:opacity-50"
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
  }
}) {
  const meta = (entry.meta ?? {}) as { to?: string | Array<string>; detail?: string }
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
          {entry.actorName ? `${entry.actorName} · ` : ''}
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
