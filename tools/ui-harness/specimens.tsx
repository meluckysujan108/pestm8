import { useEffect, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { ErrorComponent } from '@tanstack/react-router'
import { ErrorScreen as AppErrorScreen } from '#/components/shell/ErrorScreen'
import { ReachNotice } from '#/components/shell/ConnectionNotice'
import { publishReachNotice } from '#/lib/reach'
import type { ReachNoticeModel } from '#/lib/reach'
import { MobileDock } from '#/components/shell/MobileDock'
import { SetupGuideCard } from '#/components/onboarding/SetupGuide'
import { ReportPreview } from '#/components/onboarding/ReportPreview'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { EmailInput } from '#/components/forms/EmailInput'
import { JobCard } from '#/components/schedule/JobCard'
import { RecurringServices } from '#/components/schedule/RecurringServices'
import { useBusinessDay } from '#/lib/useBusinessDay'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { ClientSheet } from '#/components/clients/ClientSheet'
import { RecycleBinList } from '#/components/settings/RecycleBin'
import { JobTypesSection } from '#/components/settings/JobTypesSection'
import { ReportSettingsForm } from '#/components/settings/ReportSettingsForm'
import { BusinessSection } from '#/components/settings/BusinessSection'
import { LicenceFields } from '#/components/settings/LicenceFields'
import { StagedLicenceFiles } from '#/components/settings/StagedLicenceFiles'
import type { StagedFiles } from '#/components/settings/StagedLicenceFiles'
import type { LicenceDraft } from '#/components/settings/LicenceFields'
import { ReportSigning } from '#/components/reports/fields/ReportSigning'
import { SignatureRow } from '#/components/reports/fields/SignatureRow'
import { MySignature } from '#/components/settings/MySignature'
import { keepSignature } from '#/lib/signature/kept'
import { seedRootState } from '#/lib/rootState'
import { FinaliseSheet } from '#/components/reports/FinaliseSheet'
import { TemplateSettingsSheet } from '#/components/reports/TemplateSettingsSheet'
import { SendSheet } from '#/components/reports/SendSheet'
import { FinishedReport } from '#/components/reports/FinishedReport'
import { ReportEmails } from '#/components/reports/ReportEmails'
import type {
  FinishedHeader,
  FinishedView,
} from '#/components/reports/FinishedReport'
import { ReportsLibrary } from '#/components/reports/ReportsLibrary'
import type { Segment } from '#/components/reports/ReportsLibrary'
import { getTemplate } from '#/lib/reportTemplates'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import { SearchBox } from '#/components/primitives/SearchBox'
import { LoadMore } from '#/components/primitives/LoadMore'
import { CardCells } from '#/components/shell/Pending'
import { useRevealMore } from '#/lib/useRevealMore'
import {
  EmptyState,
  EmptyStateButton,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { StatusPill } from '#/components/primitives/StatusPill'
import { ScheduleFilterBar } from '#/components/schedule/ScheduleFilterBar'
import { ClientFilterBar } from '#/components/clients/ClientFilterBar'
import { clientFacets } from '../../convex/lib/clientFacets'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../convex/_generated/api'
import { ClientCard } from '#/components/clients/ClientCard'
import { useClientFilters } from '#/lib/clientFilters'
import { usePagedList } from '#/lib/usePagedList'
import { CLIENTS_PAGE, clientsFirstPage, rq } from '#/lib/routeQueries'
import { FormAlert } from '#/components/forms/FormAlert'
import { SwitchBanner } from '#/components/shell/SwitchBanner'
import { AccessProvider } from '#/lib/access'
import {
  BackLink,
  DANGER_ROW_CLASS,
  DangerGroup,
  FieldRow,
  SaveBar,
  SettingsBody,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  RowBadge,
} from '#/components/settings/ui'
import {
  KeyRound,
  Palette,
  Plug,
  Repeat,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react'
import type { StatusFilter } from '#/lib/scheduleFilters'
import type {
  KindFilter,
  StatusFilter as ClientStatusFilter,
} from '#/lib/clientFilters'
import { InstallSteps } from '#/components/install/InstallSteps'
import { InstallSettings } from '#/components/install/InstallSettings'
import { InstallCardView } from '#/components/install/InstallCard'
import { InstallSheet } from '#/components/install/InstallSheet'
import { InstallLink } from '#/components/install/InstallLink'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { XeroSection } from '#/components/xero/XeroPage'
import type { XeroSearch } from '#/components/xero/XeroPage'
import { MatchSection } from '#/components/xero/MatchReview'
import type { MatchFilter } from '#/components/xero/xeroCopy'
import { MemberXero } from '#/components/xero/MemberXero'
import { XeroLineRows } from '#/components/xero/ClientXeroLines'
import { XeroBadge, xeroRowValue } from '#/components/xero/XeroBadge'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import { UndoDialog, useUndoImport } from '#/components/clients/import/undo'
import { MemberSettings } from '#/components/settings/MemberAccessRow'
import type { Member } from '#/components/settings/MemberAccessRow'
import type { InstallMethod } from '#/lib/installMethod'
import type { InstallProgress } from '#/lib/installPrompt'
import {
  BIZ,
  JOBS,
  MEMBERS,
  SAMPLE_LOGO,
  TZ,
  finishedReport,
  resolveFixture,
  state,
} from './fixtures'
import { EVERY_XERO_LINE, TWO_XERO_LINES, XERO_BIZ } from './xeroFixtures'
import {
  BUSY_CLIENT_ID,
  BUSY_JOB_ID,
  BUSY_PROJECTED,
  BUSY_SERIES,
  busyServices,
} from './busyFixtures'

const bizId = BIZ as never

function Phone({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-[460px] bg-canvas">
      {children}
    </div>
  )
}

function Header({ kicker, title }: { kicker?: string; title: string }) {
  // PageHeader needs the sidebar provider; this is its markup, for context only.
  return (
    <header className="chrome-blur sticky top-0 z-30 flex items-end justify-between gap-3 border-b border-hairline px-4 pb-3 pt-3">
      <div className="min-w-0 flex-1">
        {kicker && <p className="section-label mb-0.5 truncate">{kicker}</p>}
        <h1 className="truncate text-page-title text-ink">{title}</h1>
      </div>
    </header>
  )
}

function Dock() {
  return (
    <Phone>
      <Header kicker="Swan River Pest Co" title="Job" />
      <div className="p-4 text-body text-muted">
        On the Job page (behind More). Which tab is lit?
      </div>
      <MobileDock businessSlug="demo" unreadNotes={2} overdueJobs={3} />
    </Phone>
  )
}

function JobCards() {
  return (
    <Phone>
      <Header kicker="Friday 26 September" title="Schedule" />
      <div className="flex flex-col gap-3 p-4">
        {JOBS.map((job) => (
          <JobCard
            key={job._id}
            job={job as never}
            timezone={TZ}
            onOpen={() => {}}
            hideTechnician
            // The last card has the hop from the job before it as well as a
            // Contact line, so the two are seen stacked beside the price.
            travel={job._id === 'j5' ? '≈ 4 km → Leederville' : undefined}
          />
        ))}
      </div>
    </Phone>
  )
}

function jobDetail(jobId: string) {
  return function JobDetail() {
    return (
      <Phone>
        {/* The edit form asks who may be booked, which reads access. */}
        <AccessProvider businessId={bizId}>
          <Header title="Schedule" />
          <JobDetailSheet
            businessId={bizId}
            businessSlug="demo"
            timezone={TZ}
            jobId={jobId}
            canReassign
            canDelete
            onClose={() => {}}
          />
        </AccessProvider>
      </Phone>
    )
  }
}

/** A job with no note and one service. */
const JobDetail = jobDetail('j2')
/** A job for three services, with a note. */
const JobDetailServices = jobDetail('j1')
/** A business job with a contact person and no site contact. */
const JobDetailContact = jobDetail('j5')

function JobDetailLoading() {
  return (
    <Phone>
      <Header title="Schedule" />
      <JobDetailSheet
        businessId={bizId}
        businessSlug="demo"
        timezone={TZ}
        jobId="loading"
        canReassign
        canDelete
        onClose={() => {}}
      />
    </Phone>
  )
}

function Client() {
  state.technician = false
  state.actingAs = false
  return (
    <Phone>
      {/* The sheet's Xero line asks who is looking (Release 3). */}
      <AccessProvider businessId={bizId}>
        <Header title="Client" />
        <ClientSheet
          businessId={bizId}
          timezone={TZ}
          businessSlug="demo"
          businessState="WA"
          canManageClients
          clientId="c1"
          onClose={() => {}}
        />
      </AccessProvider>
    </Phone>
  )
}

/** The busy commercial client (busyFixtures.ts). */
function ClientBusy() {
  state.technician = false
  state.actingAs = false
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <Header title="Clients" />
        <ClientSheet
          businessId={bizId}
          timezone={TZ}
          businessSlug="demo"
          businessState="WA"
          canManageClients
          clientId={BUSY_CLIENT_ID}
          onClose={() => {}}
        />
      </AccessProvider>
    </Phone>
  )
}

const JobDetailBusy = jobDetail(BUSY_JOB_ID)

/** The Recurring Job view's markup over the busy client's projections. */
/** The Recurring Job page by service: one card per service, the weekly one
 * opened. */
function RecurringServicesBusy() {
  const day = useBusinessDay(TZ)
  return (
    <Phone>
      <Header kicker="Job" title="Recurring Job" />
      <section className="px-4 pt-3 pb-6">
        <RecurringServices
          data={busyServices() as never}
          day={day}
          roster={MEMBERS as never}
          businessSlug="demo"
          onOpenJob={() => {}}
        />
      </section>
    </Phone>
  )
}

function RecurringBusy() {
  return (
    <Phone>
      <Header kicker="Job" title="Recurring Job" />
      <section className="px-4 pt-3 pb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-4 py-3 shadow-elevation">
          <span className="flex items-center gap-2">
            <Repeat size={18} strokeWidth={1.7} className="text-ink-2" />
            <span className="text-row-title tabular-nums text-ink">
              {BUSY_SERIES.length} Recurring Jobs
            </span>
          </span>
          <span className="text-caption tabular-nums text-muted">
            {BUSY_PROJECTED.length} visits booked in the next 6 months
          </span>
        </div>
        <div className="flex flex-col gap-2.5">
          {BUSY_PROJECTED.map((job) => (
            <JobCard
              key={job._id}
              job={job as never}
              timezone={TZ}
              hideActions
              onOpen={() => {}}
            />
          ))}
        </div>
      </section>
    </Phone>
  )
}

/** The technician's own pad: turned on a phone held upright, with their
 * saved signature one tap away. */
function Sign() {
  return (
    <Phone>
      <ReportSigning
        open
        onClose={() => {}}
        businessId={bizId}
        reportId={'r1' as never}
        slot="technician"
        label="Technician's Signature"
        ownSignature
        onSigned={() => {}}
      />
    </Phone>
  )
}

/** A client's pad, which asks their name: upright, where the keyboard fits,
 * with the statement they are agreeing to above it. */
function SignClient() {
  return (
    <Phone>
      <ReportSigning
        open
        onClose={() => {}}
        businessId={bizId}
        reportId={'r1' as never}
        slot="client"
        label="Client Signature"
        statement="The Client acknowledges receipt of this Certificate of Installation and agrees to maintain the property in accordance with the recommendations to preserve system effectiveness and warranty."
        askName
        ownSignature={false}
        onSigned={() => {}}
      />
    </Phone>
  )
}

/** The technician's own slot on the form, with a saved signature: one tap
 * signs with it, or they draw instead. */
function SignRowSaved() {
  return (
    <Phone>
      <div className="p-4">
        <SignatureRow
          businessId={bizId}
          reportId={'r_unsigned' as never}
          slot="technician"
          label="Technician's Signature"
          ownSignature
          onSigned={() => {}}
        />
      </div>
    </Phone>
  )
}

/** A drawing this phone kept because it could not be saved: the form offers
 * it until it is saved or discarded. */
function SignRowWaiting() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void (async () => {
      // A drawing is kept as the signed-in person's: a stand-in session,
      // whose token says only who it is.
      seedRootState({
        token: `x.${btoa(JSON.stringify({ sub: 'harness-user' }))}.x`,
        theme: 'system',
      })
      const canvas = document.createElement('canvas')
      canvas.width = 600
      canvas.height = 180
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.strokeStyle = '#1C1C1E'
        ctx.lineWidth = 6
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(30, 130)
        ctx.bezierCurveTo(120, 20, 180, 20, 240, 110)
        ctx.bezierCurveTo(300, 170, 380, 160, 460, 60)
        ctx.bezierCurveTo(500, 30, 540, 70, 570, 90)
        ctx.stroke()
      }
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      )
      if (blob) {
        await keepSignature({
          reportId: 'r_waiting',
          slot: 'technician',
          png: await blob.arrayBuffer(),
          strokes: {
            version: 1,
            pad: { width: 600, height: 180 },
            strokes: [],
          },
          // Drawn at 10:42 this morning, with no signal under the house.
          drawnAt: new Date().setHours(10, 42, 0, 0),
          keepAsMine: false,
        })
      }
      setReady(true)
    })()
  }, [])
  return (
    <Phone>
      <div className="p-4">
        {ready && (
          <SignatureRow
            businessId={bizId}
            reportId={'r_waiting' as never}
            slot="technician"
            label="Technician's Signature"
            ownSignature
            onSigned={() => {}}
          />
        )}
      </div>
    </Phone>
  )
}

/** Settings → My signature, with one saved. */
function MySignatureSpecimen() {
  return (
    <Phone>
      <MySignature businessId={bizId} />
    </Phone>
  )
}

function SheetPrimitive() {
  return (
    <Phone>
      <Sheet open onClose={() => {}} title="Choose a product">
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl bg-surface">
          {[
            'Termidor HE',
            'Advion Cockroach Gel',
            'Demand CS',
            'Contrac Blox',
          ].map((p) => (
            <li key={p} className="px-3.5 py-3 text-body text-ink">
              {p}
            </li>
          ))}
        </ul>
      </Sheet>
    </Phone>
  )
}

function Warnings() {
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <SwitchBanner businessId={bizId} />
      </AccessProvider>
      <div className="flex flex-col gap-4 p-4">
        <p className="section-label">Amber box (as used in 27 places)</p>
        <p className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink">
          Finalise this job’s report first — your business asks for one before a
          job is marked complete.
        </p>
        <p className="section-label">FormAlert (already fixed)</p>
        <FormAlert>
          Finalise this job’s report first — your business asks for one before a
          job is marked complete.
        </FormAlert>
      </div>
    </Phone>
  )
}

function Filters() {
  const [status, setStatus] = useState<StatusFilter>('all')
  const [staffId, setStaffId] = useState('all')
  const [kind, setKind] = useState<KindFilter>('all')
  const [suburb, setSuburb] = useState('all')
  const [clientStatus, setClientStatus] = useState<ClientStatusFilter>('all')
  const [tag, setTag] = useState('all')
  const [seg, setSeg] = useState('day')
  const [q, setQ] = useState('crawley')
  return (
    <Phone>
      <div className="flex flex-col gap-4 p-4">
        <p className="section-label">Segmented</p>
        <Segmented
          label="View"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
        <p className="section-label">Schedule filter bar</p>
        <ScheduleFilterBar
          jobs={JOBS as never}
          members={MEMBERS}
          status={status}
          setStatus={setStatus}
          staffId={staffId}
          setStaffId={setStaffId}
        />
        <p className="section-label">Client filter bar</p>
        <ClientFilterBar
          facets={clientFacets([
            {
              client: { status: 'lead', tags: ['GPC', 'Real estate'] },
              properties: [{ suburb: 'Subiaco' }],
            },
            { client: { tags: ['GPC'] }, properties: [{ suburb: 'Crawley' }] },
          ])}
          kind={kind}
          setKind={setKind}
          suburb={suburb}
          setSuburb={setSuburb}
          status={clientStatus}
          setStatus={setClientStatus}
          tag={tag}
          setTag={setTag}
          filtered={
            kind !== 'all' ||
            suburb !== 'all' ||
            clientStatus !== 'all' ||
            tag !== 'all'
          }
          onClear={() => {
            setKind('all')
            setSuburb('all')
            setClientStatus('all')
            setTag('all')
          }}
        />
        <p className="section-label">Search box</p>
        <SearchBox value={q} onChange={setQ} label="Search clients" />
        <p className="section-label">Status pills</p>
        <div className="flex flex-wrap gap-2">
          {[
            'recurring',
            'pending',
            'booked',
            'completed',
            'invoiced',
            'cancelled',
          ].map((s) => (
            <StatusPill key={s} status={s} />
          ))}
        </div>
      </div>
    </Phone>
  )
}

function Settings() {
  return (
    <Phone>
      <header className="chrome-blur sticky top-0 z-30 border-b border-hairline px-4 pb-3 pt-3">
        <BackLink
          to="/$businessSlug/settings"
          params={{ businessSlug: 'demo' }}
        >
          Settings
        </BackLink>
        <h1 className="truncate text-page-title text-ink">My details</h1>
      </header>
      <SettingsBody>
        <SettingsGroup title="You">
          <SettingsLinkRow
            to="/"
            icon={User}
            title="My details"
            value="Terence"
          />
          <SettingsLinkRow
            to="/"
            icon={KeyRound}
            tint="green"
            title="Licences & insurance"
            badge={<RowBadge tone="amber">Expiring</RowBadge>}
          />
          <SettingsLinkRow
            to="/"
            icon={ShieldCheck}
            tint="grey"
            title="Two-step sign-in"
            value="Off"
          />
        </SettingsGroup>
        <SettingsGroup title="Business" footer="Only the owner sees these.">
          <SettingsLinkRow
            to="/"
            icon={Users}
            tint="orange"
            title="Team"
            value="3 people"
          />
          <SettingsRow
            icon={Palette}
            tint="red"
            title="Appearance"
            value="System"
          />
        </SettingsGroup>
        <SettingsGroup title="Your details">
          <FieldRow id="n" label="Name">
            <input
              id="n"
              defaultValue="Terence Walsh"
              className="h-11 w-full rounded-xl bg-surface-3 px-3 text-body text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </FieldRow>
        </SettingsGroup>
        <DangerGroup>
          <button type="button" className={DANGER_ROW_CLASS}>
            Sign out
          </button>
        </DangerGroup>
        <SaveBar visible pending={false} label="Save" />
      </SettingsBody>
    </Phone>
  )
}

function ErrorScreen() {
  return (
    <Phone>
      {new URLSearchParams(location.search).get('old') ? (
        <ErrorComponent
          error={new Error('[CONVEX Q(jobs:listDay)] Server Error')}
        />
      ) : (
        <AppErrorScreen
          error={new Error('[CONVEX Q(jobs:listDay)] Server Error')}
          reset={() => {}}
        />
      )}
    </Phone>
  )
}

/**
 * The "Could not reach PestM8" notice over the schedule's header: Try again
 * first, Reload once that hasn't helped (with a save waiting), and offline.
 */
function reach(
  props: Pick<
    Parameters<typeof ReachNotice>[0],
    'online' | 'waitingToSave' | 'action'
  >,
) {
  return function Reach() {
    return (
      <Phone>
        <Header kicker="October 2026" title="Schedule" />
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((card) => (
            <div key={card} className="h-40 rounded-2xl bg-surface" />
          ))}
        </div>
        <ReachNotice
          {...props}
          onTry={() => {}}
          onReload={() => {}}
          onDismiss={() => {}}
        />
      </Phone>
    )
  }
}

/**
 * The notice's copy at the top of an open sheet, under the grab handle: the
 * real Sheet, drawing what ConnectionNotice would have published.
 */
const REACH_IN_SHEET: ReachNoticeModel = {
  online: true,
  waitingToSave: true,
  action: 'try',
  onTry: () => {},
  onReload: () => {},
  onDismiss: () => {},
}

function ReachInSheet() {
  publishReachNotice(REACH_IN_SHEET)
  return <SheetPrimitive />
}

function Empty() {
  return (
    <Phone>
      <Header kicker="Swan River Pest Co" title="Products" />
      <div className="p-4">
        <EmptyState
          title="No products yet"
          body="Add the chemicals you use, with their label and safety data sheet."
          action={
            <EmptyStateButton onClick={() => {}}>
              Add a product
            </EmptyStateButton>
          }
        />
      </div>
    </Phone>
  )
}

function Acting() {
  state.actingAs = true
  return <Warnings />
}

/**
 * The end of a long list, in each of its states: more to come (on the Job
 * tab it loads by itself as it comes near), a page loading (its bones in the
 * list's own grid, the button saying so), and the button alone (Reports and
 * Notes). Nothing here loads: `onLoadMore` does nothing.
 */
function LoadMoreStates() {
  const job = (i: number) => (
    <JobCard
      key={JOBS[i]._id}
      job={JOBS[i] as never}
      timezone={TZ}
      onOpen={() => {}}
    />
  )
  return (
    <Phone>
      <Header kicker="148 jobs" title="Job" />
      <section className="px-4 pb-6 pt-4">
        <h2 className="section-label mb-2">More to come</h2>
        <div className="flex flex-col gap-2.5">{job(4)}</div>
        <LoadMore
          canLoadMore
          loading={false}
          onLoadMore={() => {}}
          noun="jobs"
          shown={24}
        />

        <h2 className="section-label mb-2 mt-6">Loading the next page</h2>
        <div className="flex flex-col gap-2.5">
          {job(2)}
          <CardCells count={1} size="job" />
        </div>
        <LoadMore
          canLoadMore={false}
          loading
          onLoadMore={() => {}}
          noun="jobs"
          shown={24}
        />

        <h2 className="section-label mb-2 mt-6">The button alone</h2>
        <div className="flex flex-col gap-2.5">
          <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
            <p className="text-row-title text-ink">Pest Management Report</p>
            <p className="mt-0.5 text-body text-ink-2">Harriet Cole</p>
            <p className="mt-0.5 text-caption text-muted">Crawley</p>
          </div>
        </div>
        <LoadMore
          auto={false}
          canLoadMore
          loading={false}
          onLoadMore={() => {}}
          noun="reports"
          shown={25}
        />
      </section>
    </Phone>
  )
}

const LIVE_ROWS = Array.from({ length: 200 }, (_, i) => i + 1)

/**
 * LoadMore driving a list, to try by hand: ten at a time, the next ten
 * arriving by themselves as the end comes near, eight times, and then only
 * when Show more is tapped (which starts another eight). It opens with
 * several steps already loaded — a short page is "near" its end at once,
 * and keeps loading until it is not.
 */
function LoadMoreLive() {
  const reveal = useRevealMore(LIVE_ROWS, 10, '')
  return (
    <Phone>
      <Header kicker="200 clients" title="Clients" />
      <section className="px-4 pb-6 pt-4">
        <div className="flex flex-col gap-2.5">
          {reveal.visible.map((n) => (
            <div
              key={n}
              className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
            >
              <p className="text-row-title text-ink">Client {n}</p>
            </div>
          ))}
        </div>
        <LoadMore
          canLoadMore={reveal.canLoadMore}
          loading={false}
          onLoadMore={reveal.loadMore}
          noun="clients"
          shown={reveal.visible.length}
        />
      </section>
    </Phone>
  )
}

/**
 * The Clients page as it opens: the whole book's count and filters
 * (`clients.overview`), the newest clients' first page — a strata client
 * whose sites run past what a card is sent ("50+ properties"), someone with
 * no site yet — and Show more for the rest. The route needs the router, so
 * this is its list, drawn as the route draws it.
 */
function ClientsList() {
  const { data: overview } = useQuery(rq.clientOverview(bizId))
  const filters = useClientFilters()
  const paged = usePagedList({
    query: api.clients.page,
    args: { businessId: bizId },
    first: clientsFirstPage(bizId),
    pageSize: CLIENTS_PAGE,
  })
  return (
    <Phone>
      <Header
        kicker={overview && `${overview.total} clients`}
        title="Clients"
      />
      <section className="px-4 pb-6 pt-4">
        {overview && (
          <div className="mb-3">
            <ClientFilterBar
              facets={overview}
              kind={filters.kind}
              setKind={filters.setKind}
              suburb={filters.suburb}
              setSuburb={filters.setSuburb}
              status={filters.status}
              setStatus={filters.setStatus}
              tag={filters.tag}
              setTag={filters.setTag}
              filtered={filters.filtersActive}
              onClear={filters.clearFilters}
            />
          </div>
        )}
        <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-stretch">
          {paged.rows.map((row) => (
            <ClientCard
              key={row.client._id}
              client={row.client}
              properties={row.properties}
              propertiesCapped={row.propertiesCapped}
              onOpen={() => {}}
            />
          ))}
        </div>
        <LoadMore
          canLoadMore={paged.canLoadMore}
          loading={paged.loadingMore}
          onLoadMore={paged.loadMore}
          noun="clients"
          shown={paged.rows.length}
        />
      </section>
    </Phone>
  )
}

/** The Reports list, as the owner sees it: a bin on every report. */
function reportsList(segment: Segment, technician = false) {
  return function ReportsList() {
    state.technician = technician
    return (
      <Phone>
        <AccessProvider businessId={bizId}>
          <Header title="Reports" />
          <ReportsLibrary
            businessId={bizId}
            businessSlug="demo"
            segment={segment}
            query=""
            onSegment={() => {}}
            onQuery={() => {}}
          />
        </AccessProvider>
      </Phone>
    )
  }
}

/** A finalised report's header, as `PageHeader` draws it (which needs the
 * sidebar's provider): the way back, the title, and the "⋯". */
function FinishedHeaderMock({ title, back, action }: FinishedHeader) {
  return (
    <header className="chrome-bar sticky top-0 z-30 flex items-end justify-between gap-3 border-b border-hairline px-4 pb-3 pt-3">
      <div className="min-w-0 flex-1">
        {back}
        <h1 className="truncate text-page-title text-ink">{title}</h1>
      </div>
      {action && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </header>
  )
}

/** A finished report's Email list, in each state a send can be in: on its
 * way, sent, to someone new, stuck, failed, refused before approval was
 * retired, and with email not set up. */
function EmailStates() {
  return (
    <Phone>
      <div className="flex flex-col gap-4 px-4 py-4">
        {[
          'r_sending',
          'r_sent',
          'r_new',
          'r_stuck',
          'r_failed',
          'r_refused',
          'r_setup',
        ].map((id) => (
          <ReportEmails
            key={id}
            businessId={bizId}
            reportId={id as never}
            hydrated
            client={null}
            fileName="pest-service-report-30-sloan-drive-leda-2026-09-30"
            onSendAgain={() => {}}
          />
        ))}
      </div>
    </Phone>
  )
}

/**
 * A finished report's page, as the owner sees it. `id` picks its sends and
 * activity from the fixtures; `report` changes what the report itself says.
 */
function finished(
  id: string,
  report: Record<string, unknown> = {},
  view?: FinishedView,
) {
  return function Finished() {
    const [open, setOpen] = useState<FinishedView | undefined>(view)
    return (
      <Phone>
        <FinishedReport
          businessId={bizId}
          businessSlug="demo"
          report={finishedReport(id, report) as never}
          ownsRecords
          hydrated
          view={open}
          onView={setOpen}
          onCloseView={() => setOpen(undefined)}
          onDeleted={() => {}}
          renderHeader={(header) => <FinishedHeaderMock {...header} />}
        />
      </Phone>
    )
  }
}

function Guide() {
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <Header kicker="September" title="Schedule" />
        <SetupGuideCard
          businessId={bizId}
          businessSlug="demo"
          onBookJob={() => {}}
        />
      </AccessProvider>
    </Phone>
  )
}

function Confirm() {
  return (
    <Phone>
      <Header title="Clients" />
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Remove Priya Raman?"
        body="They are this client’s primary contact. The next contact becomes primary."
        cancel="Keep contact"
        confirm="Remove"
        onConfirm={() => {}}
      />
    </Phone>
  )
}

function Inputs() {
  const [email, setEmail] = useState('priya@subicafe.example')
  return (
    <Phone>
      <div className="p-4">
        <SettingsGroup title="Business details">
          <FieldRow id="e" label="Email">
            <EmailInput id="e" value={email} onChange={setEmail} />
          </FieldRow>
        </SettingsGroup>
      </div>
    </Phone>
  )
}

function NoMatchesDemo() {
  return (
    <Phone>
      <Header kicker="12 clients" title="Clients" />
      <div className="p-4">
        <NoMatches
          term="crawly"
          hint="Try a different name, address or filter."
          clearLabel="Clear search"
          onClear={() => {}}
        />
      </div>
    </Phone>
  )
}

const SERVICE = getTemplate('serviceReport')

/**
 * The Service Report as the builder resolves a draft of it, and so as the
 * lock sheet is handed it: while client signatures are off, without the
 * client's pad.
 */
const SERVICE_DRAFT = resolveReportTemplate({
  template: 'serviceReport',
  templateVersion: SERVICE.version,
  status: 'draft',
})

/**
 * The sheet that locks a report, at its email note. The report id picks the
 * fixture (`deliveries:known`): `r_nomail` is a deployment with no email set
 * up. The client's copy can be switched off here, as in the app.
 */
function LockSheet({
  reportId,
  answers,
  clientEmail,
}: {
  reportId: string
  answers: Record<string, unknown>
  clientEmail?: string
}) {
  const [data, setData] = useState<Record<string, unknown>>({
    serviceDate: '2026-09-29',
    safeToStart: true,
    nextVisit: '3 Months',
    ...answers,
  })
  return (
    <Phone>
      <FinaliseSheet
        session={1}
        businessId={bizId}
        reportId={reportId as never}
        open
        onClose={() => {}}
        onConfirm={() => {}}
        pending={false}
        template={SERVICE_DRAFT}
        data={data}
        context={{ client: { name: 'Jane Nguyen', email: clientEmail } }}
        signedSlots={['technician']}
        photoCount={3}
        onAnswer={(key, value) =>
          setData((prev) => ({ ...prev, [key]: value }))
        }
      />
    </Phone>
  )
}

function Lock() {
  return (
    <LockSheet
      reportId="r_lock"
      answers={{ sendCopy: true }}
      clientEmail="jane@gmail.com"
    />
  )
}

/** A strata manager nobody has on file: emailed with the client, and the
 * sheet asks for a second look before the lock. */
function LockNewAddress() {
  return (
    <LockSheet
      reportId="r_lock"
      answers={{ sendCopy: true, emailReportTo: ['strata@harbourside.com.au'] }}
      clientEmail="jane@gmail.com"
    />
  )
}

function LockNoEmail() {
  return (
    <LockSheet
      reportId="r_lock"
      answers={{ sendCopy: false }}
      clientEmail={undefined}
    />
  )
}

/** A report with more photos than an email carries: the sheet says the email
 * goes as a copy with smaller photos before the lock sends it. */
function LockBig() {
  return (
    <LockSheet
      reportId="r_big"
      answers={{ sendCopy: true }}
      clientEmail="jane@gmail.com"
    />
  )
}

function Send({
  reportId = 'r_lock',
  clientEmail = 'jane@gmail.com',
  data = { sendCopy: true },
}: {
  reportId?: string
  clientEmail?: string
  data?: Record<string, unknown>
}) {
  return (
    <Phone>
      <SendSheet
        open
        onClose={() => {}}
        businessId={bizId}
        reportId={reportId as never}
        template={SERVICE}
        data={data}
        clientEmail={clientEmail}
        clientName="Jane Nguyen"
        subject="Service Report — 30 Sloan Drive, Leda — 29 Sept 2026"
      />
    </Phone>
  )
}

/** A client with no email on their record: the address field is already
 * there, and typing one offers to keep it on the record. */
function SendNoClientEmail() {
  return <Send reportId="r_noclientmail" clientEmail="" data={{}} />
}

/** The same sheet for a 53-photo job: the email goes as a copy with smaller
 * photos, and the sheet says so before Send. */
function SendBig() {
  return <Send reportId="r_big" />
}

/** A form's own settings: only the technician's pad can be required. */
function FormSettings() {
  return (
    <Phone>
      <TemplateSettingsSheet
        open
        onClose={() => {}}
        businessId={bizId}
        templateId="serviceReport"
      />
    </Phone>
  )
}

/** Settings → Reports: the business copy, and no approval switch — anyone
 * may email a report anywhere, and the copy is how the owner sees it. */
function ReportSettings() {
  return (
    <Phone>
      <Header kicker="Settings" title="Reports" />
      <SettingsBody>
        <ReportSettingsForm
          businessId={bizId}
          businessSlug="demo"
          businessName="Pest M8 Pest Control"
        />
      </SettingsBody>
    </Phone>
  )
}

/** Settings → Business, for the Letterhead's logos. `slug` picks which:
 * both logos, no dark version, or no logo at all (fixtures.ts). */
function Letterhead({ slug }: { slug: 'both' | 'nodark' | 'nologo' }) {
  const business = resolveFixture('businesses:getBySlug', { slug })
  return (
    <Phone>
      <Header kicker="Settings" title="Business" />
      <SettingsBody>
        <BusinessSection business={business as never} />
      </SettingsBody>
    </Phone>
  )
}

/** Set-up's likeness of the top of a report, its logo box the PDF's shape. */
function ReportPreviewSpecimen() {
  return (
    <Phone>
      <div className="p-4">
        <ReportPreview
          name="Pest M8 Pest Control"
          logoUrl={SAMPLE_LOGO}
          email="info@pestm8.com.au"
          phone="1800 737 868"
          abn="51 824 753 556"
          state="WA"
          licenceNumber="PMT 4132"
          focus={null}
        />
      </div>
    </Phone>
  )
}

/** Settings → Job types, with the real client's services and typed-in ones. */
function JobTypes() {
  return (
    <Phone>
      <header className="chrome-blur sticky top-0 z-30 border-b border-hairline px-4 pb-3 pt-3">
        <BackLink
          to="/$businessSlug/settings"
          params={{ businessSlug: 'demo' }}
        >
          Settings
        </BackLink>
        <h1 className="truncate text-page-title text-ink">Job types</h1>
      </header>
      <AccessProvider businessId={bizId}>
        <SettingsBody>
          <JobTypesSection businessId={bizId} />
        </SettingsBody>
      </AccessProvider>
    </Phone>
  )
}

function RecycleBin() {
  return (
    <Phone>
      <Header kicker="Settings" title="Recycle bin" />
      <SettingsBody>
        <RecycleBinList businessId={bizId} timezone={TZ} />
      </SettingsBody>
    </Phone>
  )
}

/** A card's photo, drawn rather than shipped: the thumbnail's stand-in. */
const CARD_PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 86 54"><rect width="86" height="54" rx="4" fill="#2f7d4f"/><rect x="6" y="8" width="20" height="26" rx="2" fill="#cfe8d8"/><rect x="32" y="10" width="44" height="5" rx="2" fill="#e8f3ec"/><rect x="32" y="20" width="36" height="4" rx="2" fill="#bfe0cb"/><rect x="32" y="28" width="30" height="4" rx="2" fill="#bfe0cb"/></svg>',
  )

/**
 * Add new: the details and the files picked with them — a photo and a PDF
 * held until Add, each with a way to take it off.
 */
function LicenceAdd() {
  const [draft, setDraft] = useState<LicenceDraft>({
    name: 'Public liability insurance',
    number: 'PL-2026-118',
    expiresOn: '2027-04-17',
  })
  const staged: StagedFiles = {
    files: [
      {
        id: 'a',
        blob: new Blob([new Uint8Array(312_000)]),
        type: { kind: 'image', contentType: 'image/jpeg' },
        fileName: 'Card front.png',
        previewUrl: CARD_PHOTO,
      },
      {
        id: 'b',
        blob: new Blob([new Uint8Array(1_240_000)]),
        type: { kind: 'pdf', contentType: 'application/pdf' },
        fileName: 'Certificate of currency.pdf',
        previewUrl: null,
      },
    ],
    preparing: null,
    pickError: null,
    leftOut: 0,
    pick: async () => {},
    remove: () => {},
  }
  return (
    <Phone>
      <header className="chrome-blur sticky top-0 z-30 border-b border-hairline px-4 pb-3 pt-3">
        <BackLink
          to="/$businessSlug/settings/licence"
          params={{ businessSlug: 'demo' }}
        >
          Licences & insurance
        </BackLink>
        <h1 className="truncate text-page-title text-ink">Add new</h1>
      </header>
      <SettingsBody>
        <SettingsGroup title="Details">
          <LicenceFields draft={draft} onChange={setDraft} />
        </SettingsGroup>
        <StagedLicenceFiles staged={staged} uploading={null} locked={false} />
        <SaveBar visible pending={false} label="Add" />
      </SettingsBody>
    </Phone>
  )
}

/** Every device's install steps, as Settings → Install app draws them. The
 * harness is a desktop browser, so each is pinned rather than detected. */
const INSTALL_STATES: Array<{
  label: string
  method: InstallMethod
  canPrompt?: boolean
  progress?: InstallProgress
}> = [
  { label: 'iPhone, Safari', method: 'ios-safari' },
  { label: 'iPhone, Chrome', method: 'ios-browser' },
  { label: 'iPhone, in Gmail', method: 'ios-in-app' },
  {
    label: 'Android, Chrome offering',
    method: 'android-chrome',
    canPrompt: true,
  },
  { label: 'Android, Chrome', method: 'android-chrome' },
  { label: 'Android, Samsung Internet', method: 'android-samsung' },
  { label: 'Android, in an app', method: 'android-in-app' },
  { label: 'Computer, Chrome', method: 'desktop-chromium' },
  { label: 'Mac, Safari', method: 'mac-safari' },
  { label: 'Firefox on a computer', method: 'unsupported' },
  {
    label: 'Android, accepted, installing',
    method: 'android-chrome',
    progress: 'installing',
  },
  {
    label: 'Android, just installed',
    method: 'android-chrome',
    progress: 'installed',
  },
  { label: 'The installed app', method: 'installed' },
]

function Install() {
  return (
    <Phone>
      <Header kicker="Settings" title="Install app" />
      <SettingsBody>
        {INSTALL_STATES.map((device) => (
          <SettingsGroup key={device.label} title={device.label}>
            <div className="px-3.5 py-3.5">
              <InstallSteps
                method={device.method}
                canPrompt={device.canPrompt ?? false}
                progress={device.progress ?? null}
                onInstall={() => {}}
              />
            </div>
          </SettingsGroup>
        ))}
      </SettingsBody>
    </Phone>
  )
}

function InstallSettingsPage() {
  return (
    <Phone>
      <header className="chrome-blur sticky top-0 z-30 border-b border-hairline px-4 pb-3 pt-3">
        <BackLink
          to="/$businessSlug/settings"
          params={{ businessSlug: 'demo' }}
        >
          Settings
        </BackLink>
        <h1 className="truncate text-page-title text-ink">Install app</h1>
      </header>
      <InstallSettings method="ios-safari" />
    </Phone>
  )
}

function InstallCardSpecimen() {
  return (
    <Phone>
      <Header kicker="September 2026" title="My jobs" />
      <div className="pb-3">
        <InstallCardView
          canPrompt={false}
          onAction={() => {}}
          onDismiss={() => {}}
        />
        <InstallCardView canPrompt onAction={() => {}} onDismiss={() => {}} />
      </div>
      <div className="px-4 text-caption text-grey-ink">
        Above: an iPhone (Show me how), then Android once Chrome has offered its
        prompt (Install PestM8). The week strip and the day follow.
      </div>
    </Phone>
  )
}

function InstallSheetSpecimen() {
  return (
    <Phone>
      <InstallSheet open onClose={() => {}} method="ios-safari" />
    </Phone>
  )
}

function InstallLinkSpecimen() {
  return (
    <Phone>
      <main className="flex w-full flex-col px-6 pt-16">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">Sign in</h1>
        <p className="mb-8 mt-2 text-body text-muted">
          Scheduling and compliance reporting for Australian pest control.
        </p>
        <div className="flex flex-col gap-3">
          <button type="button" className={`${PRIMARY_BUTTON} mt-2`}>
            Sign in
          </button>
          <span className="flex min-h-11 items-center justify-center text-body text-blue">
            Forgot password?
          </span>
          <InstallLink method="ios-safari" />
        </div>
      </main>
    </Phone>
  )
}

/** A Settings page's header as `PageHeader` draws it (which needs the
 * sidebar's provider): "‹ Settings" (or `back`) over the title. */
function SettingsHeader({
  title,
  back = 'Settings',
}: {
  title: string
  back?: string
}) {
  return (
    <header className="chrome-blur sticky top-0 z-30 border-b border-hairline px-4 pb-3 pt-3">
      <BackLink to="/$businessSlug/settings" params={{ businessSlug: 'demo' }}>
        {back}
      </BackLink>
      <h1 className="truncate text-page-title text-ink">{title}</h1>
    </header>
  )
}

/**
 * Settings → Xero (`kind="business"`) or My Xero (`"member"`), in one state:
 * the business id picks `xero.status`'s answer (xeroFixtures.ts). My Xero is
 * a subcontractor's unless `owner` says otherwise.
 */
function xeroPage(
  kind: 'business' | 'member',
  businessId: string,
  opts: { owner?: boolean; switched?: boolean; search?: XeroSearch } = {},
) {
  return function XeroSpecimen() {
    state.technician = !(opts.owner ?? kind === 'business')
    state.actingAs = opts.switched ?? false
    return (
      <Phone>
        <AccessProvider businessId={businessId as never}>
          <SettingsHeader title={kind === 'business' ? 'Xero' : 'My Xero'} />
          <SettingsBody>
            <XeroSection
              kind={kind}
              business={{
                _id: businessId as never,
                slug: 'demo',
                name: 'Pest M8 Pest Control',
                state: 'WA',
              }}
              search={opts.search ?? {}}
              onSearchDone={() => {}}
            />
          </SettingsBody>
        </AccessProvider>
      </Phone>
    )
  }
}

/**
 * Settings → Xero → Match your clients (or My Xero's), opened on one list:
 * the business id picks `xero.status`'s answer and the lists'
 * (xeroFixtures.ts). The chips work, as the page's address would.
 */
function matchPage(
  kind: 'business' | 'member',
  businessId: string,
  opts: { filter?: MatchFilter; owner?: boolean; switched?: boolean } = {},
) {
  return function MatchSpecimen() {
    state.technician = !(opts.owner ?? kind === 'business')
    state.actingAs = opts.switched ?? false
    const [filter, setFilter] = useState<MatchFilter>(opts.filter ?? 'review')
    return (
      <Phone>
        <AccessProvider businessId={businessId as never}>
          <SettingsHeader
            title="Match your clients"
            back={kind === 'business' ? 'Xero' : 'My Xero'}
          />
          <SettingsBody>
            <MatchSection
              kind={kind}
              business={{
                _id: businessId as never,
                slug: 'demo',
                name: 'Pest M8 Pest Control',
              }}
              filter={filter}
              onFilter={setFilter}
            />
          </SettingsBody>
        </AccessProvider>
      </Phone>
    )
  }
}

/** Team → a member, as the owner reads it: their Xero line among the rest. */
const KEVIN: Member = {
  _id: 'm_kev' as never,
  name: 'Kevin Doyle',
  email: 'kevin@doylepest.example',
  role: 'subcontractor',
  grants: {
    switchInto: null,
    clientDirectory: false,
    prices: false,
    otherSchedules: false,
  },
  canViewOtherAccounts: false,
  canManage: true,
  canSetRole: true,
  bookable: true,
  parentMembershipId: null,
  licenceNumber: 'TECH-8821',
  colour: '#FF3B30',
  status: 'active',
  canSetColour: false,
  twoStepOn: false,
  licenceCount: 0,
}

function TeamMember() {
  state.technician = false
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <SettingsHeader title="Kevin Doyle" />
        <SettingsBody>
          <MemberSettings
            businessId={bizId}
            timezone={TZ}
            member={KEVIN}
            onRemoved={() => {}}
          />
        </SettingsBody>
      </AccessProvider>
    </Phone>
  )
}

/** The Team page's Xero line in each state: connected, needing a reconnect,
 * and nothing connected. */
function TeamMemberXero() {
  state.technician = false
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <SettingsHeader title="Team" />
        <SettingsBody>
          {[
            ['m_kev', 'Kevin Doyle'],
            ['m_sam', 'Sam Nguyen'],
            ['m_new', 'Mia Torres'],
          ].map(([id, name]) => (
            <MemberXero
              key={id}
              businessId={bizId}
              membershipId={id as never}
              name={name}
              role="subcontractor"
              active
              timezone={TZ}
            />
          ))}
        </SettingsBody>
      </AccessProvider>
    </Phone>
  )
}

/**
 * A client sheet's Xero row in every state it can be in (Release 3), each
 * in a Details card of its own under the state's name, then a client in two
 * organisations. The owner looking, so Send PestM8’s details is offered.
 */
function ClientXeroLinesSpecimen() {
  state.technician = false
  state.actingAs = false
  const card =
    'overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation'
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <Header kicker="Client #118" title="Subi Café Group" />
        <div className="px-4 pb-8">
          {EVERY_XERO_LINE.map(({ title, line, canEditClient }) => (
            <section key={title} className="mt-6">
              <h3 className="section-label mb-2">{title}</h3>
              <div className={card}>
                <DetailRows>
                  <DetailRow label="Email" value="ops@subicafe.example" />
                  <XeroLineRows
                    businessId={bizId}
                    businessSlug="demo"
                    clientId={'c1' as never}
                    clientName="Subi Café Group"
                    timezone={TZ}
                    lines={[line] as never}
                    canEditClient={canEditClient}
                  />
                </DetailRows>
              </div>
            </section>
          ))}
          <section className="mt-6">
            <h3 className="section-label mb-2">Two organisations</h3>
            <div className={card}>
              <DetailRows>
                <XeroLineRows
                  businessId={bizId}
                  businessSlug="demo"
                  clientId={'c1' as never}
                  clientName="Subi Café Group"
                  timezone={TZ}
                  lines={TWO_XERO_LINES as never}
                />
              </DetailRows>
            </div>
          </section>
        </div>
      </AccessProvider>
    </Phone>
  )
}

/** One Xero row of the Settings hub, as it reads `xero.status`. */
function HubXeroRow({
  businessId,
  note,
}: {
  businessId: string
  note: string
}) {
  const status = useQuery(rq.xeroStatus(businessId as never)).data
  const view = status?.business ?? null
  return (
    <SettingsLinkRow
      to="/"
      icon={Plug}
      tint="blue"
      title="Xero"
      subtitle={note}
      value={xeroRowValue(view)}
      badge={<XeroBadge view={view} />}
    />
  )
}

/** The hub's Xero row with each badge it can carry, the one that matters
 * most winning: Reconnect, then to check, then different, then none. */
function XeroHubBadges() {
  state.technician = false
  state.actingAs = false
  return (
    <Phone>
      <AccessProvider businessId={bizId}>
        <SettingsHeader title="Settings" />
        <SettingsBody>
          <SettingsGroup title="Business">
            <HubXeroRow
              businessId={XERO_BIZ.reconnect}
              note="Needs reconnecting"
            />
            <HubXeroRow businessId={XERO_BIZ.syncing} note="Some to check" />
            <HubXeroRow
              businessId={XERO_BIZ.syncPaused}
              note="Some different in Xero"
            />
            <HubXeroRow businessId={XERO_BIZ.synced} note="All in step" />
            <HubXeroRow businessId={XERO_BIZ.none} note="Not connected" />
          </SettingsGroup>
        </SettingsBody>
      </AccessProvider>
    </Phone>
  )
}

/** An import's Undo, asked, for an import some of whose clients have
 * reached Xero (`xeroSync.importNote` answers 3). */
function ImportUndoXero() {
  const undo = useUndoImport(bizId)
  const { ask } = undo
  useEffect(() => {
    ask('imp_1' as never)
  }, [ask])
  return (
    <Phone>
      <Header title="Import clients" />
      <UndoDialog undo={undo} />
    </Phone>
  )
}

export const SPECIMENS: Partial<Record<string, ComponentType>> = {
  xero: xeroPage('business', XERO_BIZ.none),
  'xero-connected': xeroPage('business', XERO_BIZ.connected),
  'xero-reconnect': xeroPage('business', XERO_BIZ.reconnect),
  'xero-leftover': xeroPage('business', XERO_BIZ.leftover),
  'xero-unconfigured': xeroPage('business', XERO_BIZ.unconfigured),
  'xero-demo': xeroPage('business', XERO_BIZ.demo),
  'xero-two-step': xeroPage('business', XERO_BIZ.twoStepOff),
  'xero-loading': xeroPage('business', XERO_BIZ.loading),
  'xero-finishing': xeroPage('business', XERO_BIZ.none, {
    search: { finish: 'harness' },
  }),
  'xero-returned': xeroPage('business', XERO_BIZ.none, {
    search: { xero: 'member_org' },
  }),
  'xero-owners-only': xeroPage('business', XERO_BIZ.none, { owner: false }),
  'my-xero': xeroPage('member', XERO_BIZ.none),
  'my-xero-connected': xeroPage('member', XERO_BIZ.connected),
  'my-xero-reconnect': xeroPage('member', XERO_BIZ.reconnect),
  'my-xero-returned': xeroPage('member', XERO_BIZ.none, {
    search: { xero: 'business_org' },
  }),
  'my-xero-owner': xeroPage('member', XERO_BIZ.none, { owner: true }),
  'my-xero-switched': xeroPage('member', XERO_BIZ.none, { switched: true }),
  // Release 2: the contacts read and matched, on the Xero page and on the
  // match page it leads to.
  'xero-match-reading': xeroPage('business', XERO_BIZ.matchReading),
  'xero-match-ready': xeroPage('business', XERO_BIZ.matchReady),
  'xero-match-failed': xeroPage('business', XERO_BIZ.matchFailed),
  'my-xero-match-reading': xeroPage('member', XERO_BIZ.matchReading),
  'my-xero-match-ready': xeroPage('member', XERO_BIZ.matchReady),
  'my-xero-match-failed': xeroPage('member', XERO_BIZ.matchFailed),
  'xero-match': matchPage('business', XERO_BIZ.matchReady),
  'xero-match-matched': matchPage('business', XERO_BIZ.matchReady, {
    filter: 'matched',
  }),
  'xero-match-new': matchPage('business', XERO_BIZ.matchReady, {
    filter: 'new',
  }),
  'xero-match-different': matchPage('business', XERO_BIZ.matchReady, {
    filter: 'separate',
  }),
  'xero-match-clean': matchPage('business', XERO_BIZ.matchClean),
  'xero-match-page-reading': matchPage('business', XERO_BIZ.matchReading),
  'xero-match-page-failed': matchPage('business', XERO_BIZ.matchFailed),
  'xero-match-loading': matchPage('business', XERO_BIZ.loading),
  'xero-match-not-connected': matchPage('business', XERO_BIZ.none),
  'xero-match-owners-only': matchPage('business', XERO_BIZ.matchReady, {
    owner: false,
  }),
  'my-xero-match': matchPage('member', XERO_BIZ.matchReady),
  // A read past believing, a My Xero never read, Xero paused (no retry)
  // and over its limit, a connection to reconnect first, a long list, a
  // list that won't load, and the match page's doors.
  'xero-match-stopped': xeroPage('business', XERO_BIZ.matchStopped),
  'my-xero-match-not-read': xeroPage('member', XERO_BIZ.matchStopped),
  'xero-match-paused': xeroPage('business', XERO_BIZ.matchPaused),
  'my-xero-match-rate-limited': xeroPage('member', XERO_BIZ.matchPaused),
  'xero-match-page-reconnect': matchPage('business', XERO_BIZ.matchReconnect),
  'my-xero-match-page-reconnect': matchPage('member', XERO_BIZ.matchReconnect),
  'xero-match-paged': matchPage('business', XERO_BIZ.matchPaged, {
    filter: 'matched',
  }),
  'xero-match-load-failed': matchPage('business', XERO_BIZ.matchListFails),
  'xero-match-unconfigured': matchPage('business', XERO_BIZ.unconfigured),
  'xero-match-demo': matchPage('business', XERO_BIZ.demo),
  'my-xero-match-owner': matchPage('member', XERO_BIZ.matchReady, {
    owner: true,
  }),
  'my-xero-match-switched': matchPage('member', XERO_BIZ.matchReady, {
    switched: true,
  }),
  // Release 3: syncing. The Xero page as it sends, the match page's Start
  // syncing (and after it), a client's Xero row in every state, the hub's
  // badges and an import's undo.
  'xero-syncing': xeroPage('business', XERO_BIZ.syncing),
  'xero-synced': xeroPage('business', XERO_BIZ.synced),
  'xero-sync-paused': xeroPage('business', XERO_BIZ.syncPaused),
  'xero-sync-day-limit': xeroPage('business', XERO_BIZ.syncDayLimit),
  'my-xero-syncing': xeroPage('member', XERO_BIZ.syncing),
  'my-xero-sync-day-limit': xeroPage('member', XERO_BIZ.syncDayLimit),
  'my-xero-sync-server': xeroPage('member', XERO_BIZ.synced),
  'xero-match-stale': matchPage('business', XERO_BIZ.matchStale),
  'xero-match-syncing': matchPage('business', XERO_BIZ.syncing),
  'my-xero-match-syncing': matchPage('member', XERO_BIZ.syncing),
  'client-xero-lines': ClientXeroLinesSpecimen,
  'xero-hub-badges': XeroHubBadges,
  'import-undo-xero': ImportUndoXero,
  'team-member': TeamMember,
  'team-member-xero': TeamMemberXero,
  jobtypes: JobTypes,
  install: Install,
  'install-settings': InstallSettingsPage,
  'install-card': InstallCardSpecimen,
  'install-sheet': InstallSheetSpecimen,
  'install-link': InstallLinkSpecimen,
  licenceadd: LicenceAdd,
  bin: RecycleBin,
  'report-settings': ReportSettings,
  letterhead: () => <Letterhead slug="both" />,
  'letterhead-nodark': () => <Letterhead slug="nodark" />,
  'letterhead-nologo': () => <Letterhead slug="nologo" />,
  'report-preview': ReportPreviewSpecimen,
  dock: Dock,
  jobcards: JobCards,
  jobdetail: JobDetail,
  'jobdetail-services': JobDetailServices,
  'jobdetail-contact': JobDetailContact,
  'jobdetail-loading': JobDetailLoading,
  client: Client,
  clientbusy: ClientBusy,
  jobdetailbusy: JobDetailBusy,
  recurringbusy: RecurringBusy,
  recurringservices: RecurringServicesBusy,
  sign: Sign,
  'sign-client': SignClient,
  'sign-row-saved': SignRowSaved,
  'sign-row-waiting': SignRowWaiting,
  'my-signature': MySignatureSpecimen,
  sheet: SheetPrimitive,
  warnings: Acting,
  filters: Filters,
  settings: Settings,
  error: ErrorScreen,
  reach: reach({ online: true, waitingToSave: false, action: 'try' }),
  'reach-reload': reach({
    online: true,
    waitingToSave: true,
    action: 'reload',
  }),
  'reach-offline': reach({
    online: false,
    waitingToSave: false,
    action: 'try',
  }),
  'reach-confirm': reach({
    online: true,
    waitingToSave: true,
    action: 'reload-confirm',
  }),
  'reach-sheet': ReachInSheet,
  empty: Empty,
  guide: Guide,
  confirm: Confirm,
  inputs: Inputs,
  nomatch: NoMatchesDemo,
  lock: Lock,
  'lock-new': LockNewAddress,
  'lock-noemail': LockNoEmail,
  'lock-big': LockBig,
  finished: finished('r_history', { emailedAt: 1 }),
  'finished-sending': finished('r_sending'),
  // Never emailed, and its PDF could not be drawn (the harness's action stub
  // answers null): the card's failed state.
  'finished-noemail': finished('r_none', { pdfUrl: null }),
  'finished-legacy': finished('r_legacy', { emailedAt: 1 }),
  'finished-big': finished('r_big', { emailedAt: 1 }),
  'finished-replaced': finished('r_sent', {
    emailedAt: 1,
    version: 2,
    supersededByReportId: 'r_v3',
    supersedesReportId: 'r_v1',
    amendmentReason: 'Wrong product recorded against the second treatment',
    canAmend: false,
  }),
  'finished-answers': finished('r_history', { emailedAt: 1 }, 'answers'),
  'finished-answers-replaced': finished(
    'r_sent',
    {
      emailedAt: 1,
      version: 2,
      supersededByReportId: 'r_v3',
      supersedesReportId: 'r_v1',
      amendmentReason: 'Wrong product recorded against the second treatment',
      canAmend: false,
    },
    'answers',
  ),
  emails: EmailStates,
  'send-noclientmail': SendNoClientEmail,
  // Locked, nothing sent, and the client has an address: one tap to email.
  'finished-notsent': finished('r_fresh'),
  send: Send,
  'send-big': SendBig,
  'form-settings': FormSettings,
  reports: reportsList('all'),
  'reports-deleted': reportsList('trash'),
  'reports-deleted-tech': reportsList('trash', true),
  loadmore: LoadMoreStates,
  'loadmore-live': LoadMoreLive,
  clients: ClientsList,
}
