import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from 'radix-ui'
import { Ellipsis, FilePenLine, Trash2 } from 'lucide-react'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import { BackLink } from '#/components/settings/ui'
import { formatJobDate, formatWhen, todayKey } from '#/lib/format'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import { documentIdentity } from '#/lib/reportTemplates/documentModel'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { forgetReportSignatures } from '#/lib/signature/kept'
import { dayKeyOf } from '../../../convex/lib/dates'
import {
  AmendSheet,
  AmendmentNotice,
  CorrectionUnderWay,
} from './AmendmentNotice'
import { DeleteReport } from './DeleteReport'
import { ReportActivity } from './ReportActivity'
import { ReportCover } from './ReportCover'
import { ReportDocument } from './ReportDocument'
import { ReportEmails } from './ReportEmails'
import { ReportPdfViewer } from './ReportPdfViewer'
import { ReportStatusPill } from './ReportRows'
import { emailProblem } from '../../../convex/lib/email'
import { SendSheet } from './SendSheet'
import type { Person } from './SendSheet'
import { SgarNotice } from './SgarNotice'
import { replacedBadge } from './reportPdfModel'
import { useReportPdf } from './useReportPdf'
import type { ReactNode } from 'react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/** A finalised report, as `reports.get` returns it. */
export type FinishedReportDoc = NonNullable<
  FunctionReturnType<typeof api.reports.get>
>

/** What the page's header shows; the route draws it (`PageHeader`). */
export type FinishedHeader = {
  title: string
  back: ReactNode
  action?: ReactNode
}

/** Which of the report's own screens is open over the page, from the URL. */
export type FinishedView = 'pdf' | 'answers'

/**
 * A finalised report: one page, in the order it is used.
 *
 *  1. What it is — the form, its number, where, for whom and when, and
 *     whether it has been sent — as a job's or a client's sheet opens.
 *  2. The document itself: a likeness of the PDF that opens it, and Send and
 *     Share beside it.
 *  3. The answers, a tap away, for reading the form without the PDF.
 *  4. Where it went (Email), the facts (Details) and what was done to it
 *     (Activity).
 *
 * It replaced four tabs — Form, PDF, Email and Logs — over a page with no
 * header. The PDF tab was a card with one button on it, the Email and Logs
 * tabs listed the same sends twice, and Issue a correction and Delete sat at
 * the foot of the Form tab, under the whole document. Apple keeps a segmented
 * control for views of the same thing; these were a document, an action and
 * a record.
 *
 * The rarer acts, Issue a correction and Delete, are in the header's "⋯".
 */
export function FinishedReport({
  businessId,
  businessSlug,
  report,
  ownsRecords,
  hydrated,
  view,
  onView,
  onCloseView,
  onDeleted,
  renderHeader,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  report: FinishedReportDoc
  /** The owner: a signed record is theirs to throw away (`reports.softDelete`). */
  ownsRecords: boolean
  hydrated: boolean
  view: FinishedView | undefined
  onView: (view: FinishedView) => void
  onCloseView: () => void
  /** The report is in Deleted: leave the page. */
  onDeleted: () => void
  renderHeader: (header: FinishedHeader) => ReactNode
}) {
  const timezone = useBusinessTimezone()
  const navigate = useNavigate()
  // Locked: nothing can be signed on it now, so a drawing this phone kept for
  // it, never saved (src/lib/signature/kept.ts), can only ever sit there.
  const reportId = report._id
  useEffect(() => {
    void forgetReportSignatures(reportId)
  }, [reportId])
  const [sending, setSending] = useState<{
    open: boolean
    /** Chosen as the sheet opens: the form's own, or a "Send again"'s. */
    chosen: ReadonlyArray<string>
  }>({ open: false, chosen: [] })
  const [amending, setAmending] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const sendRef = useRef<HTMLButtonElement>(null)

  const template = resolveReportTemplate({
    template: report.template,
    templateVersion: report.templateVersion,
    customTemplate: report.customTemplate,
    // The wording it was SIGNED against: the shared file's name, the viewer's
    // title and the send sheet's recipients all come from what the document
    // says, not from a form reworded since.
    templateSnapshot: report.templateSnapshot,
  })
  const identity = documentIdentity({
    template,
    property: report.property,
    businessName: report.businessName,
    finalisedAt: report.finalisedAt,
  })
  const pdf = useReportPdf({
    businessId,
    reportId: report._id,
    pdfUrl: report.pdfUrl ?? null,
  })
  const data = (report.data ?? {}) as Record<string, unknown>
  // Who the report is for, offered in one tap when nothing has been sent:
  // the client from their record as it is now, else as the document printed.
  const { data: known } = useQuery(
    convexQuery(api.deliveries.known, { businessId, reportId: report._id }),
  )
  const recordClient = (
    known as { people?: ReadonlyArray<Person> } | undefined
  )?.people?.find((person) => person.kind === 'client')
  const printedEmail = report.context.client?.email?.trim().toLowerCase()
  const clientFound = recordClient
    ? { name: recordClient.name, address: recordClient.address }
    : known !== undefined &&
        (known as { people?: unknown }).people === undefined &&
        printedEmail
      ? {
          name: report.context.client?.name ?? 'the client',
          address: printedEmail,
        }
      : null
  // Undefined while still looked up, so the row never pops in under a thumb;
  // never for an address that cannot be delivered to, nor on a document a
  // correction has replaced.
  const clientToEmail =
    known === undefined
      ? undefined
      : clientFound &&
          emailProblem(clientFound.address) === null &&
          report.supersededByReportId === undefined
        ? clientFound
        : null

  const openSend = (chosen: ReadonlyArray<string> = []) =>
    setSending({ open: true, chosen })

  // As the document prints them: frozen at finalise.
  const clientName =
    report.property?.client?.name ?? report.contextSnapshot?.client?.name ?? ''
  const suburb =
    report.property?.suburb ?? report.contextSnapshot?.property?.suburb ?? ''
  const replaced = report.supersededByReportId !== undefined

  // The rarer acts, in the header's "⋯". Offered only where the server would
  // allow them: correcting a document that has already been replaced, or
  // that already has a correction under way, would fork its number into two
  // live documents.
  const canCorrect = report.canAmend && !report.openAmendmentId
  const menu =
    canCorrect || ownsRecords ? (
      <MoreMenu
        hydrated={hydrated}
        onCorrect={canCorrect ? () => setAmending(true) : undefined}
        onDelete={ownsRecords ? () => setDeleting(true) : undefined}
      />
    ) : undefined

  // What anyone reading it must know first: it has been replaced, it
  // replaces another, or a correction is under way — on the page and on its
  // Answers alike, so nobody reads the old document without being told.
  const amendments = (
    <>
      <AmendmentNotice
        businessSlug={businessSlug}
        supersededBy={report.supersededByReportId}
        supersedes={report.supersedesReportId}
        reason={report.amendmentReason}
        reportNumber={report.reportNumber}
        version={report.version}
        className=""
      />
      {report.openAmendmentId && (
        <CorrectionUnderWay
          businessSlug={businessSlug}
          amendmentId={report.openAmendmentId}
        />
      )}
    </>
  )

  if (view === 'answers') {
    return (
      <>
        {renderHeader({
          title: 'Answers',
          back: (
            <BackLink
              to="/$businessSlug/reports/$reportId"
              params={{ businessSlug, reportId: report._id }}
              search={{}}
              // The report itself, not this page: without the search, the
              // router would mark it as the page it is on.
              activeOptions={{ includeSearch: true }}
              onClick={(event) => {
                // Back the way it came, so the phone's Back and this agree
                // (see the route's `useViewEntry`).
                event.preventDefault()
                onCloseView()
              }}
            >
              Report
            </BackLink>
          ),
        })}
        <div className="lg:mx-auto lg:max-w-[720px]">
          <p className="px-4 pt-4 text-caption text-grey-ink">
            {template.name}
            {suburb ? ` · ${suburb}` : ''} · as recorded when it was finalised
          </p>
          <div className="flex flex-col gap-2 px-4 pt-3 empty:hidden">
            {amendments}
          </div>
          <ReportDocument
            report={report}
            businessId={businessId}
            variant="answers"
          />
        </div>
      </>
    )
  }

  const finalisedDay =
    report.finalisedAt !== undefined
      ? formatJobDate(
          dayKeyOf(report.finalisedAt, timezone),
          todayKey(timezone),
        )
      : null
  const technician = report.context.technician?.name ?? report.author?.name
  const jobNumber = report.context.job?.number

  return (
    <>
      {renderHeader({
        // The number a client quotes over the phone, and short enough never
        // to be cut off beside the header's buttons; the form's name is the
        // first line under it.
        title:
          report.reportNumber !== undefined
            ? `Report #${report.reportNumber}`
            : template.name,
        back: (
          <BackLink to="/$businessSlug/reports" params={{ businessSlug }}>
            Reports
          </BackLink>
        ),
        action: menu,
      })}

      <div className="px-4 pb-6 pt-4 lg:mx-auto lg:max-w-[1040px]">
        {/* What it is, as a job's sheet opens: the form, the place, the
            status as its pill, and for whom and when. */}
        <div>
          <p className="text-caption text-grey-ink">
            {template.name}
            {(report.version ?? 1) > 1 ? ` · Version ${report.version}` : ''}
          </p>
          <p className="mt-0.5 break-words text-row-title text-ink">
            {report.property
              ? `${report.property.addressLine}, ${report.property.suburb}`
              : suburb || template.name}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ReportStatusPill report={report} size="page" />
            <span className="min-w-0 text-caption text-grey-ink">
              {[clientName, finalisedDay].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>

        {/* Then anything to know first, a rodent treatment due to be gone
            back to included. */}
        <div className="mt-3 flex flex-col gap-2 empty:hidden">
          {amendments}
          <SgarNotice
            businessSlug={businessSlug}
            template={template}
            data={data}
            finalisedAt={report.finalisedAt}
          />
        </div>

        {/* Two columns from lg, the document's never narrower than its two
            buttons need side by side. */}
        <div className="mt-4 flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(22rem,5fr)_minmax(0,7fr)] lg:items-start">
          <ReportCover
            logoUrl={report.business?.logoUrl}
            pdf={pdf}
            title={identity.title}
            fileName={identity.fileName}
            hydrated={hydrated}
            replaced={replaced}
            onView={() => onView('pdf')}
            onAnswers={() => onView('answers')}
            onSend={() => openSend()}
            sendRef={sendRef}
          />

          <div className="flex flex-col gap-6">
            <ReportEmails
              businessId={businessId}
              reportId={report._id}
              hydrated={hydrated}
              client={clientToEmail}
              fileName={identity.fileName}
              onSendAgain={(addresses) => openSend(addresses)}
            />

            <section aria-labelledby="report-details">
              <h2 id="report-details" className="section-label mb-2">
                Details
              </h2>
              <div className="rounded-2xl border border-hairline bg-surface shadow-elevation">
                <DetailRows>
                  {technician && (
                    <DetailRow label="Technician" value={technician} />
                  )}
                  {report.finalisedAt !== undefined && (
                    <DetailRow
                      label="Finalised"
                      value={formatWhen(report.finalisedAt, timezone)}
                      sub="Locked: it can’t be edited"
                    />
                  )}
                  <DetailRow label="Standard" value={report.legalBasis} />
                  {report.jobId && (
                    <DetailRow
                      label="Job"
                      value={
                        <Link
                          to="/$businessSlug/schedule"
                          params={{ businessSlug }}
                          search={{ jobId: report.jobId }}
                          className="relative tap-target text-blue"
                        >
                          {jobNumber ? `Job #${jobNumber}` : 'Open the job'}
                        </Link>
                      }
                    />
                  )}
                </DetailRows>
              </div>
            </section>

            <ReportActivity businessId={businessId} reportId={report._id} />
          </div>
        </div>
      </div>

      <SendSheet
        open={sending.open}
        onClose={() => setSending((now) => ({ ...now, open: false }))}
        businessId={businessId}
        reportId={report._id}
        template={template}
        data={data}
        clientEmail={report.context.client?.email}
        clientName={report.context.client?.name}
        subject={identity.title}
        chosen={sending.chosen}
        replaced={report.supersededByReportId !== undefined}
        // Back to the page's Send, which is always there: the viewer's, which
        // may have opened it, is gone.
        returnFocusRef={sendRef}
      />

      {canCorrect && (
        <AmendSheet
          open={amending}
          onClose={() => setAmending(false)}
          businessId={businessId}
          businessSlug={businessSlug}
          reportId={report._id}
        />
      )}

      {ownsRecords && (
        <DeleteReport
          businessId={businessId}
          reportId={report._id}
          report={{
            status: report.status,
            templateName: template.name,
            clientName,
            suburb,
            reportNumber: report.reportNumber,
            version: report.version,
            replaced,
            correcting: report.correcting,
          }}
          leavesPage
          onDeleted={onDeleted}
          open={deleting}
          onOpenChange={setDeleting}
        />
      )}

      {hydrated && view === 'pdf' && (
        <ReportPdfViewer
          businessId={businessId}
          reportId={report._id}
          title={identity.title}
          fileName={identity.fileName}
          pdf={pdf}
          badge={replaced ? replacedBadge(report.version) : undefined}
          onBadge={
            report.supersededByReportId
              ? () =>
                  void navigate({
                    to: '/$businessSlug/reports/$reportId',
                    params: {
                      businessSlug,
                      reportId: report.supersededByReportId as Id<'reports'>,
                    },
                  })
              : undefined
          }
          onSend={() => {
            // A sheet can't rise over the viewer (it sits above every
            // sheet), so the viewer steps aside for it.
            onCloseView()
            openSend()
          }}
          onClose={onCloseView}
        />
      )}
    </>
  )
}

/**
 * The header's "⋯": Issue a correction, and — for the owner — Delete report.
 * A menu, as the note editor's is: a list of commands.
 */
function MoreMenu({
  hydrated,
  onCorrect,
  onDelete,
}: {
  hydrated: boolean
  onCorrect?: () => void
  onDelete?: () => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        type="button"
        aria-label="More actions for this report"
        disabled={!hydrated}
        className="relative tap-target flex size-9 items-center justify-center rounded-full bg-surface-2 text-ink-2 outline-none transition active:scale-[.95] focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-50"
      >
        <Ellipsis size={18} strokeWidth={1.7} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-60 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {onCorrect && (
            <MenuItem
              icon={<FilePenLine size={17} strokeWidth={2} />}
              onSelect={onCorrect}
            >
              Issue a correction
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem
              icon={<Trash2 size={17} strokeWidth={2} />}
              onSelect={onDelete}
              destructive
            >
              Delete report
            </MenuItem>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function MenuItem({
  icon,
  children,
  onSelect,
  destructive,
}: {
  icon: ReactNode
  children: ReactNode
  onSelect: () => void
  destructive?: boolean
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`flex min-h-11 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-body font-semibold outline-none data-[highlighted]:bg-surface-2 ${
        destructive ? 'text-red' : 'text-ink'
      }`}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  )
}
