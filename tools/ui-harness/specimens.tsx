import { useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { ErrorComponent } from '@tanstack/react-router'
import { ErrorScreen as AppErrorScreen } from '#/components/shell/ErrorScreen'
import { MobileDock } from '#/components/shell/MobileDock'
import { SetupGuideCard } from '#/components/onboarding/SetupGuide'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { EmailInput } from '#/components/forms/EmailInput'
import { JobCard } from '#/components/schedule/JobCard'
import { JobDetailSheet } from '#/components/schedule/JobDetailSheet'
import { ClientSheet } from '#/components/clients/ClientSheet'
import { SignSheet } from '#/components/reports/fields/SignSheet'
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
import { KeyRound, Palette, ShieldCheck, User, Users } from 'lucide-react'
import type { StatusFilter } from '#/lib/scheduleFilters'
import type {
  KindFilter,
  StatusFilter as ClientStatusFilter,
} from '#/lib/clientFilters'
import { BIZ, JOBS, MEMBERS, TZ, state } from './fixtures'

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

function JobDetail() {
  return (
    <Phone>
      <Header title="Schedule" />
      <JobDetailSheet
        businessId={bizId}
        businessSlug="demo"
        timezone={TZ}
        jobId="j2"
        canReassign
        onClose={() => {}}
      />
    </Phone>
  )
}

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
        isOwner
        clientId="c1"
        onClose={() => {}}
      />
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
            title="Licences"
            badge={<RowBadge tone="amber">Expires soon</RowBadge>}
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

export const SPECIMENS: Partial<Record<string, ComponentType>> = {
  dock: Dock,
  jobcards: JobCards,
  jobdetail: JobDetail,
  'jobdetail-loading': JobDetailLoading,
  client: Client,
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
}
