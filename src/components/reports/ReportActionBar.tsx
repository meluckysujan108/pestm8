import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexAction } from '@convex-dev/react-query'
import { Segmented } from '../primitives/Segmented'
import { DownloadPdfButton } from './DownloadPdfButton'
import { api } from '../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'

const TABS = [
  { value: 'form' as const, label: 'Form' },
  { value: 'pdf' as const, label: 'PDF' },
  { value: 'email' as const, label: 'Email' },
  { value: 'logs' as const, label: 'Logs' },
]

type Tab = (typeof TABS)[number]['value']

/**
 * Only shown once a report is finalised — a draft has no PDF to view, no
 * finished document to email, and nothing worth logging yet.
 */
export function ReportActionBar({
  businessId,
  reportId,
  pdfUrl,
  fileName,
  children,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  pdfUrl: string | null
  fileName: string
  children: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('form')

  return (
    <>
      <div className="px-4 pt-4">
        <Segmented label="Report view" value={tab} options={TABS} onChange={setTab} />
      </div>

      {tab === 'form' && children}

      {tab === 'pdf' && (
        <div className="px-4 pt-5 pb-8">
          <DownloadPdfButton
            businessId={businessId}
            reportId={reportId}
            pdfUrl={pdfUrl}
            fileName={fileName}
          />
        </div>
      )}

      {tab === 'email' && (
        <EmailPanel businessId={businessId} reportId={reportId} />
      )}

      {tab === 'logs' && (
        <LogsPanel businessId={businessId} reportId={reportId} />
      )}
    </>
  )
}

const EMAIL_ERROR_MESSAGE: Record<string, string> = {
  EMAIL_NOT_CONFIGURED:
    'Email sending isn’t set up for this business yet.',
  REPORT_NOT_FINALISED: 'This report isn’t finalised yet.',
  PDF_UNAVAILABLE: 'Could not prepare the PDF to attach.',
  EMAIL_SEND_FAILED: 'The email failed to send. Check the log below.',
}

function EmailPanel({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}) {
  const hydrated = useHydrated()
  const [to, setTo] = useState('')

  const convexSend = useConvexAction(api.email.sendReportPdf)
  const send = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      to: string
    }) => convexSend(args),
  })

  const { data: logs } = useQuery(
    convexQuery(api.auditLog.forEntity, {
      businessId,
      entityType: 'reports',
      entityId: reportId,
    }),
  )
  const emailLogs = (logs ?? []).filter((entry) =>
    entry.action.startsWith('report.email'),
  )

  const errorMessage = send.error?.message ?? ''
  const errorCode = Object.keys(EMAIL_ERROR_MESSAGE).find((code) =>
    errorMessage.includes(code),
  )

  return (
    <div className="px-4 pt-5 pb-8">
      <h2 className="section-label mb-2">Send this report</h2>
      <form
        className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
        onSubmit={(e) => {
          e.preventDefault()
          send.mutate({ businessId, reportId, to })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Recipient email</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            type="email"
            required
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>
        <button
          type="submit"
          disabled={send.isPending || !hydrated}
          className="h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : send.isSuccess ? 'Sent' : 'Send'}
        </button>
        {send.isError && (
          <p role="alert" className="text-caption text-amber-ink">
            {(errorCode && EMAIL_ERROR_MESSAGE[errorCode]) ??
              'Could not send the email.'}
          </p>
        )}
      </form>

      <h2 className="section-label mb-2 mt-6">Email history</h2>
      {emailLogs.length === 0 ? (
        <p className="text-caption text-muted">Not sent yet.</p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {emailLogs.map((entry) => (
            <LogRow key={entry._id} entry={entry} />
          ))}
        </ul>
      )}
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
      <h2 className="section-label mb-2">Action history</h2>
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
}

function LogRow({
  entry,
}: {
  entry: { _id: string; action: string; meta: unknown; at: number }
}) {
  const meta = (entry.meta ?? {}) as { to?: string; detail?: string }
  return (
    <li className="px-3.5 py-3">
      <p className="text-body text-ink">
        {ACTION_LABEL[entry.action] ?? entry.action}
        {meta.to ? ` — ${meta.to}` : ''}
      </p>
      <p className="text-caption text-muted">
        {new Intl.DateTimeFormat('en-AU', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(entry.at))}
      </p>
      {meta.detail && (
        <p className="mt-1 text-caption text-amber-ink">{meta.detail}</p>
      )}
    </li>
  )
}
