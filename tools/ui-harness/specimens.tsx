import { useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { ErrorComponent } from '@tanstack/react-router'
import { ErrorScreen as AppErrorScreen } from '#/components/shell/ErrorScreen'
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
import { SignSheet } from '#/components/reports/fields/SignSheet'
import { FinaliseSheet } from '#/components/reports/FinaliseSheet'
import { TemplateSettingsSheet } from '#/components/reports/TemplateSettingsSheet'
import {
  DeliveryHistory,
  LatestDelivery,
  SendSheet,
} from '#/components/reports/SendSheet'
import { LogsPanel } from '#/components/reports/ReportActionBar'
import { ReportsLibrary } from '#/components/reports/ReportsLibrary'
import type { Segment } from '#/components/reports/ReportsLibrary'
import { DeleteReport } from '#/components/reports/DeleteReport'
import { AmendButton } from '#/components/reports/AmendmentNotice'
import { DeleteButton } from '#/components/primitives/DeleteButton'
import { getTemplate } from '#/lib/reportTemplates'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import { SearchBox } from '#/components/primitives/SearchBox'
import {
  EmptyState,
  EmptyStateButton,
  NoMatches,
} from '#/components/primitives/EmptyState'
import { StatusPill } from '#/components/primitives/StatusPill'
import { ScheduleFilterBar } from '#/components/schedule/ScheduleFilterBar'
import { ClientFilterBar } from '#/components/clients/ClientFilterBar'
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
import type { InstallMethod } from '#/lib/installMethod'
import type { InstallProgress } from '#/lib/installPrompt'
import {
  BIZ,
  JOBS,
  MEMBERS,
  SAMPLE_LOGO,
  TZ,
  resolveFixture,
  state,
} from './fixtures'
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
  return (
    <Phone>
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
    </Phone>
  )
}

/** The busy commercial client (busyFixtures.ts). */
function ClientBusy() {
  return (
    <Phone>
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

function Sign() {
  return (
    <Phone>
      <SignSheet
        open
        onClose={() => {}}
        businessId={bizId}
        reportId={'r1' as never}
        slot="technician"
        label="Technician signature"
        ownSignature={false}
        onSigned={() => {}}
      />
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
          rows={[
            {
              client: { status: 'lead', tags: ['GPC', 'Real estate'] },
              properties: [{ suburb: 'Subiaco' }],
            },
            { client: { tags: ['GPC'] }, properties: [{ suburb: 'Crawley' }] },
          ]}
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

/** The foot of a finalised report's page, for the owner: a correction, then
 * Delete report. Version 2 of #4, with a second correction being drafted. */
function ReportFoot() {
  return (
    <Phone>
      <Header kicker="Reports" title="Timber Pest Inspection" />
      <div className="px-4 pb-6 pt-2">
        <AmendButton
          businessId={bizId}
          businessSlug="demo"
          reportId={'r_v2' as never}
        />
      </div>
      <div className="px-4 pb-8">
        <DeleteReport
          businessId={bizId}
          reportId={'r_v2' as never}
          report={{
            status: 'finalised',
            templateName: 'Timber Pest Inspection Report',
            clientName: 'Subi Café Group',
            suburb: 'Subiaco',
            reportNumber: 4,
            version: 2,
            correcting: true,
          }}
          trigger={(open) => (
            <DeleteButton className="mt-2" onClick={open}>
              Delete report
            </DeleteButton>
          )}
        />
      </div>
    </Phone>
  )
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
      <SignSheet
        open
        onClose={() => {}}
        businessId={bizId}
        reportId={'r1' as never}
        slot="client"
        label="Client signature"
        askName
        ownSignature={false}
        onSigned={() => {}}
      />
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

/** The line above a finished report's tabs, in each state it can be in. */
function Delivered() {
  return (
    <Phone>
      <Header kicker="Service Report" title="30 Sloan Drive" />
      {[
        'r_sending',
        'r_sent',
        'r_stuck',
        'r_new',
        'r_failed',
        'r_refused',
        'r_setup',
      ].map((id) => (
        <LatestDelivery
          key={id}
          businessId={bizId}
          reportId={id as never}
          onOpen={() => {}}
        />
      ))}
    </Phone>
  )
}

/** The Email tab's history: who sent each email, from whose account, where
 * the copy went, and which addresses were new to the client. */
function History() {
  return (
    <Phone>
      <Header kicker="Service Report" title="Email" />
      <div className="px-4 pb-8 pt-5">
        <h2 className="section-label mb-2">Delivery history</h2>
        <DeliveryHistory businessId={bizId} reportId={'r_history' as never} />
      </div>
    </Phone>
  )
}

/** The Logs tab: the same sends, as the report's activity. */
function Logs() {
  return (
    <Phone>
      <Header kicker="Service Report" title="Logs" />
      <LogsPanel businessId={bizId} reportId={'r_logs' as never} />
    </Phone>
  )
}

/** A report from before approval was retired (29 Sept 2026), in both tabs:
 * what its rows and Logs lines still say. */
function Legacy() {
  return (
    <Phone>
      <Header kicker="Service Report" title="Before 29 Sept" />
      <div className="px-4 pb-2 pt-5">
        <h2 className="section-label mb-2">Delivery history</h2>
        <DeliveryHistory businessId={bizId} reportId={'r_legacy' as never} />
      </div>
      <LogsPanel businessId={bizId} reportId={'r_logs_legacy' as never} />
    </Phone>
  )
}

function Send({ reportId = 'r_lock' }: { reportId?: string }) {
  return (
    <Phone>
      <SendSheet
        open
        onClose={() => {}}
        businessId={bizId}
        reportId={reportId as never}
        template={SERVICE}
        data={{ sendCopy: true }}
        clientEmail="jane@gmail.com"
        subject="Service Report — 30 Sloan Drive, Leda — 29 Sept 2026"
      />
    </Phone>
  )
}

/** The same sheet for a 53-photo job: the email goes as a copy with smaller
 * photos, and the sheet says so before Send. */
function SendBig() {
  return <Send reportId="r_big" />
}

/** That job afterwards, in both tabs: the copy with smaller photos is what
 * went. */
function HistoryBig() {
  return (
    <Phone>
      <Header kicker="Service Report" title="53 photos" />
      <div className="px-4 pb-2 pt-5">
        <h2 className="section-label mb-2">Delivery history</h2>
        <DeliveryHistory businessId={bizId} reportId={'r_big' as never} />
      </div>
      <LogsPanel businessId={bizId} reportId={'r_big' as never} />
    </Phone>
  )
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

export const SPECIMENS: Partial<Record<string, ComponentType>> = {
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
  'jobdetail-loading': JobDetailLoading,
  client: Client,
  clientbusy: ClientBusy,
  jobdetailbusy: JobDetailBusy,
  recurringbusy: RecurringBusy,
  recurringservices: RecurringServicesBusy,
  sign: Sign,
  sheet: SheetPrimitive,
  warnings: Acting,
  filters: Filters,
  settings: Settings,
  error: ErrorScreen,
  empty: Empty,
  guide: Guide,
  confirm: Confirm,
  inputs: Inputs,
  nomatch: NoMatchesDemo,
  lock: Lock,
  'lock-new': LockNewAddress,
  'lock-noemail': LockNoEmail,
  'lock-big': LockBig,
  delivered: Delivered,
  history: History,
  'history-big': HistoryBig,
  logs: Logs,
  legacy: Legacy,
  send: Send,
  'send-big': SendBig,
  'form-settings': FormSettings,
  reports: reportsList('all'),
  'reports-deleted': reportsList('trash'),
  'reports-deleted-tech': reportsList('trash', true),
  'report-foot': ReportFoot,
}
