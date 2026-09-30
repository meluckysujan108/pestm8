import { useCallback, useEffect, useRef } from 'react'
import {
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { z } from 'zod'
import { leavingReports } from '#/lib/leavingReports'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { ReportBuilder } from '#/components/reports/ReportBuilder'
import {
  LicenceNotice,
  licenceFixFor,
} from '#/components/reports/LicenceNotice'
import { useAccess, useCan } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import { ReportDocument } from '#/components/reports/ReportDocument'
import { AmendmentNotice } from '#/components/reports/AmendmentNotice'
import { FinishedReport } from '#/components/reports/FinishedReport'
import { PageHeader } from '#/components/shell/PageHeader'
import { BackLink } from '#/components/settings/ui'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { FinishedView } from '#/components/reports/FinishedReport'
import type { HistoryState } from '@tanstack/react-router'
import type { Id } from '../../../../convex/_generated/dataModel'

export const Route = createFileRoute('/$businessSlug/reports/$reportId')({
  /**
   * Which section is open, by the template's own section id. In the URL so the
   * phone's back gesture leaves a section rather than the report, and so a
   * refresh mid-job comes back to the same screen.
   */
  validateSearch: z.object({
    s: z.string().optional(),
    /**
     * What is open over a finalised report: its PDF, full-screen, or its
     * Answers. In the URL for the same reason as `s`: the back gesture closes
     * it rather than leaving the report, and a refresh comes back to it.
     * Lenient, so a stale or mistyped link opens the report rather than an
     * error page.
     */
    view: z.enum(['pdf', 'answers']).optional().catch(undefined),
  }),
  // Without a loader the page suspends while it renders, and on an in-app
  // navigation that suspension blanks the whole app shell until the report
  // arrives. "Start again" navigates to a report no query has seen yet, so it
  // showed an empty screen for a second or more. Loading first keeps the
  // current screen up while the report is fetched — which `pendingMs` has to
  // say too, or the default page placeholder, shaped for a list page rather
  // than a report, would replace that screen after 200 ms. It still appears
  // once the page commits and waits on something of its own; ending that
  // means loading those with the report, not a longer wait here.
  pendingMs: Infinity,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      convexQuery(api.reports.get, {
        businessId: context.business._id,
        reportId: params.reportId as Id<'reports'>,
      }),
    ),
  component: ReportPage,
})

/** Marks a history entry as pushed by this page — see `useViewEntry`. */
const PUSHED_KEY = 'reportViewPushed'
const pushedState = () => ({ [PUSHED_KEY]: true }) as HistoryState

/**
 * Opening and closing the PDF viewer, or the Answers, through the address
 * bar, the way the Products page opens its PDFs.
 *
 * Opening PUSHES `?view=…`, so the phone's back gesture closes it first.
 * Closing from the app (Done, or "‹ Report") goes back the same way — but
 * only through an entry this page pushed, which it marks in the history
 * state: a link or a refresh that landed straight on it has nothing of ours
 * behind it, and going back there would leave the report, or the app. That
 * one closes by replacing the entry instead.
 */
function useViewEntry(current: FinishedView | undefined) {
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()

  // A second tap before the first has landed (View PDF twice) must not push
  // twice, or Done would only go back to the viewer again. Forgotten once the
  // page shows the change — not when the history moves, which the push itself
  // does, a render before `current` catches up.
  const opening = useRef(false)
  useEffect(() => {
    opening.current = false
  }, [current])

  // Nor may a second close (Done and Escape together) go back twice, out of
  // the page altogether. Forgotten once the history moves: the browser's
  // Forward can bring back the very entry that was closed, and it must close
  // again.
  const backingOutOf = useRef<string | null>(null)
  useEffect(
    () =>
      router.history.subscribe(() => {
        backingOutOf.current = null
      }),
    [router],
  )

  const open = useCallback(
    (view: FinishedView) => {
      if (current === view || opening.current) return
      opening.current = true
      void navigate({
        search: (prev) => ({ ...prev, view }),
        state: pushedState,
      })
    },
    [navigate, current],
  )

  const close = useCallback(() => {
    const { state, href } = router.history.location
    if ((state as { [PUSHED_KEY]?: unknown })[PUSHED_KEY] === true) {
      // Keyed by the history entry, not the address: reopening pushes a new
      // entry with the same address, and that one must close too.
      const entry = state.__TSR_key ?? state.key ?? href
      if (backingOutOf.current === entry) return
      backingOutOf.current = entry
      router.history.back()
    } else {
      void navigate({
        search: (prev) => ({ ...prev, view: undefined }),
        replace: true,
      })
    }
  }, [navigate, router])

  return { open, close }
}

function ReportPage() {
  const { business } = Route.useRouteContext()
  const { reportId } = Route.useParams()
  const { s: section, view } = Route.useSearch()
  const navigate = useNavigate()
  const viewEntry = useViewEntry(view)
  const access = useAccess()
  // A signed record is the owner's to throw away, and nobody else's
  // (`reports.softDelete`).
  const ownsRecords = useCan('business.manage')
  const hydrated = useHydrated()

  const { data: report } = useSuspenseQuery(
    convexQuery(api.reports.get, {
      businessId: business._id,
      reportId: reportId as Id<'reports'>,
    }),
  )

  // Mid-"Start again": the old draft is gone and the new one is a navigation
  // away. Render nothing rather than flash Not Found.
  if (!report && leavingReports.has(reportId)) return null
  if (!report) throw notFound()

  // One route, two faces: a draft is a form, a finalised report is a document.
  // The status is the single source of that truth, so a locked report has no
  // editable rendering to fall back to.
  if (report.status === 'finalised') {
    return (
      <FinishedReport
        // A different report is a different PDF: its render, its sheets and
        // its failure words start afresh ("Open the current version" stays on
        // this route and only changes the id).
        key={report._id}
        businessId={business._id}
        businessSlug={business.slug}
        report={report}
        ownsRecords={ownsRecords}
        hydrated={hydrated}
        view={view}
        onView={viewEntry.open}
        onCloseView={viewEntry.close}
        onDeleted={() =>
          void navigate({
            to: '/$businessSlug/reports',
            params: { businessSlug: business.slug },
            // Back must not return to a report that is not there.
            replace: true,
          })
        }
        renderHeader={(header) => (
          <PageHeader
            businessId={business._id}
            businessSlug={business.slug}
            title={header.title}
            back={header.back}
            action={header.action}
          />
        )}
      />
    )
  }

  if (!report.canEdit) {
    // Someone else's draft, to read: the document as it stands, under the
    // same header a finished report has.
    return (
      <>
        <PageHeader
          businessId={business._id}
          businessSlug={business.slug}
          title={
            resolveReportTemplate({
              template: report.template,
              templateVersion: report.templateVersion,
              customTemplate: report.customTemplate,
            }).name
          }
          back={
            <BackLink
              to="/$businessSlug/reports"
              params={{ businessSlug: business.slug }}
            >
              Reports
            </BackLink>
          }
        />
        <ReportDocument report={report} businessId={business._id} />
      </>
    )
  }

  const licenceFix = licenceFixFor({
    template: report.template,
    author: report.author ?? null,
    callerMembershipId: report.callerMembershipId,
    viewerIsOwner: access.role === 'owner',
  })

  return (
    <>
      {/* A correction is filled in as a draft like any other report, so the
          reason it exists has to be on the screen where the work happens —
          not only on the document once it is locked. */}
      <AmendmentNotice
        businessSlug={business.slug}
        supersedes={report.supersedesReportId}
        reason={report.amendmentReason}
        reportNumber={report.reportNumber}
        version={report.version}
      />
      {/* Said now, not at the last step: a certificate whose author has no
          licence number will be refused at Finalise. */}
      <LicenceNotice
        businessId={business._id}
        businessSlug={business.slug}
        state={business.state}
        template={report.template}
        author={report.author ?? null}
        callerMembershipId={report.callerMembershipId}
      />
      <ReportBuilder
        // Keyed by revision: the builder seeds its answers once, so switching a
        // draft to a newer form must remount it rather than let the old
        // revision's in-memory answers autosave back over the migrated ones.
        key={`${report._id}:${report.templateVersion}`}
        businessId={business._id}
        reportId={report._id}
        template={report.template}
        templateVersion={report.templateVersion}
        optionSets={report.optionSets}
        settings={report.settings}
        prefill={report.prefill}
        section={section}
        onSection={(next) =>
          navigate({
            to: '/$businessSlug/reports/$reportId',
            params: { businessSlug: business.slug, reportId: report._id },
            // A draft has no PDF viewer to keep open (its preview is local
            // to the finalise sheet), so `view` is never carried along.
            search: (prev) => ({ ...prev, s: next, view: undefined }),
          })
        }
        roster={report.roster}
        context={report.context}
        isCorrection={report.supersedesReportId !== undefined}
        upgrade={report.upgrade}
        onRestarted={(newReportId) =>
          navigate({
            to: '/$businessSlug/reports/$reportId',
            params: { businessSlug: business.slug, reportId: newReportId },
          })
        }
        customTemplate={report.customTemplate}
        initialData={(report.data ?? {}) as Record<string, unknown>}
        property={report.property}
        businessName={report.businessName}
        authorLicence={report.author?.licenceNumber}
        licenceFix={licenceFix}
        onFinalised={() =>
          navigate({
            to: '/$businessSlug/reports/$reportId',
            params: { businessSlug: business.slug, reportId },
          })
        }
      />
    </>
  )
}
