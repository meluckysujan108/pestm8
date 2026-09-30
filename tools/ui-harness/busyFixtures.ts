/*
 * A busy commercial client, shaped like the busiest one on production
 * (30 Sept 2026: three recurring services, ~200 visits, 11 reports, a site
 * note on every property). Names and numbers are made up. Used by the
 * `clientbusy`, `jobdetailbusy` and `recurringbusy` specimens, and by the
 * job/client clean-up proposal's "before" shots.
 */

const BIZ = 'biz_demo'
const DAY = 86_400_000
const PERTH = 'Australia/Perth'

function perthDay(offsetDays: number, h: number, m = 0): number {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: PERTH }).format(
    new Date(),
  )
  return (
    Date.parse(`${key}T00:00:00+08:00`) +
    offsetDays * DAY +
    (h * 60 + m) * 60_000
  )
}

export const BUSY_CLIENT_ID = 'c_busy'
export const BUSY_JOB_ID = 'j_busy'
const SITE_A = 'p_busyA'
const SITE_B = 'p_busyB'

export const BUSY_CLIENT = {
  _id: BUSY_CLIENT_ID,
  businessId: BIZ,
  kind: 'business',
  name: 'Harbourside Strata',
  abn: '51824753556',
  phone: '08 9221 4400',
  email: 'manager@harbourside.example',
  addressLine: 'Level 2, 88 Adelaide Tce',
  suburb: 'East Perth',
  state: 'WA',
  postcode: '6004',
  clientNumber: 1916,
  tags: ['Strata', 'Weekly contract'],
  createdAt: perthDay(-40, 9),
}

export const BUSY_SITES_FOR_LIST = () =>
  SITES.map((site) => ({
    ...site,
    createdAt: BUSY_CLIENT.createdAt,
    client: {
      name: BUSY_CLIENT.name,
      kind: 'business',
      phone: BUSY_CLIENT.phone,
      createdAt: BUSY_CLIENT.createdAt,
    },
  }))

const SITES = [
  {
    _id: SITE_A,
    addressLine: '1 Riverside Dr',
    suburb: 'East Perth',
    state: 'WA',
    postcode: '6004',
    siteContactName: 'Mark (building manager)',
    siteContactPhone: '0433 555 010',
  },
  {
    _id: SITE_B,
    addressLine: '3 Riverside Dr',
    suburb: 'East Perth',
    state: 'WA',
    postcode: '6004',
  },
]

type Row = {
  _id: string
  jobNumber: number
  jobType: string
  scheduledAt: number
  durationMinutes: number
  status: string
  price: number
  propertyId: string
  recurrenceId?: string
  assignedMembershipId: string
}

export const BUSY_SERIES = [
  {
    _id: 'rec_bait',
    jobType: 'Bait station check',
    every: 2,
    interval: { count: 2, unit: 'day' },
    start: -30,
    h: 6,
    m: 30,
    price: 6500,
    minutes: 30,
    site: SITE_A,
    who: 'm_sam',
  },
  {
    _id: 'rec_gpc',
    jobType: 'General Pest Control',
    every: 7,
    interval: { count: 1, unit: 'week' },
    start: -28,
    h: 7,
    m: 0,
    price: 18500,
    minutes: 60,
    site: SITE_A,
    who: 'm_owner',
  },
  {
    _id: 'rec_rodent',
    jobType: 'Rodents',
    every: 14,
    interval: { count: 2, unit: 'week' },
    start: -26,
    h: 9,
    m: 30,
    price: 12000,
    minutes: 45,
    site: SITE_B,
    who: 'm_kev',
  },
] as const

function buildJobs(): Array<Row> {
  const rows: Array<Row> = []
  let n = 2210
  for (const s of BUSY_SERIES) {
    let booked = 0
    for (let d: number = s.start; d <= 180; d += s.every) {
      const past = d < 0
      let status: string
      if (past) {
        // One bait check nobody actioned: still a projection, overdue.
        status = s._id === 'rec_bait' && d === -2 ? 'recurring' : 'completed'
        if (s._id === 'rec_gpc' && d === s.start) status = 'invoiced'
      } else if (booked < (s._id === 'rec_bait' ? 2 : 1)) {
        status = 'booked'
        booked++
      } else {
        status = 'recurring'
      }
      rows.push({
        _id: `${s._id}_${d}`,
        jobNumber: n++,
        jobType: s.jobType,
        scheduledAt: perthDay(d, s.h, s.m),
        durationMinutes: s.minutes,
        status,
        price: s.price,
        propertyId: s.site,
        recurrenceId: s._id,
        assignedMembershipId: s.who,
      })
    }
  }
  const oneOffs: Array<[number, string, string, number, string]> = [
    [-62, 'General Pest Control, Rodents', 'completed', 32000, SITE_A],
    [-45, 'Termite Inspection', 'invoiced', 38500, SITE_A],
    [-20, 'Wasps', 'cancelled', 16000, SITE_B],
    [-9, 'Cockroaches', 'completed', 21000, SITE_B],
  ]
  for (const [d, jobType, status, price, site] of oneOffs) {
    rows.push({
      _id: `once_${d}`,
      jobNumber: n++,
      jobType,
      scheduledAt: perthDay(d, 11),
      durationMinutes: 60,
      status,
      price,
      propertyId: site,
      assignedMembershipId: 'm_owner',
    })
  }
  return rows.sort((a, b) => b.scheduledAt - a.scheduledAt)
}

export const BUSY_JOBS = buildJobs()

/** The job the job-detail shots open: the next weekly service, booked. */
const NEXT_GPC = BUSY_JOBS.filter(
  (j) => j.recurrenceId === 'rec_gpc' && j.status === 'booked',
)[0]

function buildReports() {
  const reports: Array<Record<string, unknown>> = []
  const done = BUSY_JOBS.filter(
    (j) => j.status === 'completed' || j.status === 'invoiced',
  )
  let i = 0
  for (const job of done) {
    // Bait checks go on the weekly service's report; the rest have their own.
    if (job.recurrenceId === 'rec_bait') continue
    const termite = job.jobType === 'Termite Inspection'
    const at = job.scheduledAt + 2 * 3600_000
    reports.push({
      _id: `rep_${i++}`,
      status: 'finalised',
      finalisedAt: at,
      emailedAt: i % 4 === 3 ? undefined : at + 60_000,
      createdAt: at - 3600_000,
      legalBasis: termite ? 'AS 4349.3-2010' : 'APVMA · AEPMA',
      templateName: termite ? 'Timber Pest Inspection' : 'Pest Service Report',
      jobId: job._id,
      propertyId: job.propertyId,
    })
  }
  // A draft for the most recent visit, and one started from Reports with no
  // visit at all.
  reports.push({
    _id: 'rep_draft',
    status: 'draft',
    createdAt: perthDay(-1, 15),
    legalBasis: 'APVMA · AEPMA',
    templateName: 'Treatment Record',
    jobId: BUSY_JOBS.find((j) => j.status === 'completed')?._id,
    propertyId: SITE_A,
  })
  reports.push({
    _id: 'rep_loose',
    status: 'finalised',
    finalisedAt: perthDay(-33, 16),
    emailedAt: perthDay(-33, 16, 5),
    createdAt: perthDay(-33, 15),
    legalBasis: 'APVMA · AEPMA',
    templateName: 'Pest Service Report',
    propertyId: SITE_B,
  })
  return reports.sort(
    (a, b) =>
      ((b.finalisedAt ?? b.createdAt) as number) -
      ((a.finalisedAt ?? a.createdAt) as number),
  )
}

export const BUSY_REPORTS = buildReports()

function note(
  _id: string,
  kind: 'site' | 'client' | 'job',
  title: string,
  preview: string,
  daysAgo: number,
  extra: Record<string, unknown> = {},
) {
  return {
    _id,
    kind,
    title,
    preview,
    authorColour: '#0A84FF',
    authorName: 'Terence Walsh',
    editorName: 'Terence Walsh',
    authorRole: 'owner',
    updatedAt: Date.now() - daysAgo * DAY,
    createdAt: Date.now() - daysAgo * DAY,
    canEdit: true,
    canDelete: true,
    private: false,
    mine: true,
    clientName: 'Harbourside Strata',
    addressLine: '1 Riverside Dr',
    suburb: 'East Perth',
    job: null,
    ...extra,
  }
}

const SITE_NOTE = note(
  'n_site',
  'site',
  '1 Riverside Dr — site access',
  'Gate code 4412 · keys at concierge · bait stations B1–B14 in the car park',
  12,
  { pinnedAt: Date.now() - 12 * DAY, checklistTotal: 2, checklistDone: 1 },
)
const CLIENT_NOTE = note(
  'n_client',
  'client',
  'Billing',
  'Strata manager approves anything over $500 before it is booked',
  30,
)
const VISIT_NOTES = [
  note(
    'n_visit1',
    'job',
    'Kitchen closes at 2',
    'Treat the café kitchen after 2 pm only',
    3,
    { jobId: NEXT_GPC._id },
  ),
  note(
    'n_visit2',
    'job',
    'Rat activity B7',
    'Heavy take on B7 and B9 — added two stations',
    16,
  ),
]

export function busyJobGet() {
  const job = NEXT_GPC
  const site = SITES[0]
  return {
    ...job,
    businessId: BIZ,
    workOrder: 'PO-4471',
    // The plain-text note PR #91 added, beside "Before you arrive".
    notes: 'Kitchen closes at 2 — treat after.',
    property: {
      ...site,
      client: {
        _id: BUSY_CLIENT_ID,
        name: BUSY_CLIENT.name,
        kind: 'business',
        phone: BUSY_CLIENT.phone,
        email: BUSY_CLIENT.email,
      },
    },
    recurrence: {
      _id: 'rec_gpc',
      interval: { count: 1, unit: 'week' },
      active: true,
    },
    assignee: { _id: 'm_owner', colour: '#0A84FF', role: 'owner' },
    canEdit: true,
  }
}

/** A projected visit as `jobs.listRecurring` decorates it. */
function decorated(row: Row) {
  const site = SITES.find((s) => s._id === row.propertyId) ?? SITES[0]
  const series = BUSY_SERIES.find((s) => s._id === row.recurrenceId)
  return {
    ...row,
    addressLine: site.addressLine,
    suburb: site.suburb,
    postcode: site.postcode,
    propertyState: 'WA',
    clientName: BUSY_CLIENT.name,
    clientPhone: BUSY_CLIENT.phone,
    clientKind: 'business',
    siteContactName: site.siteContactName,
    siteContactPhone: site.siteContactPhone,
    assigneeColour:
      row.assignedMembershipId === 'm_kev'
        ? '#FF3B30'
        : row.assignedMembershipId === 'm_sam'
          ? '#34C759'
          : '#0A84FF',
    assigneeName:
      row.assignedMembershipId === 'm_kev'
        ? 'Kevin Doyle'
        : row.assignedMembershipId === 'm_sam'
          ? 'Sam Nguyen'
          : 'Terence Walsh',
    repeats: series?.interval,
  }
}

export const BUSY_PROJECTED = BUSY_JOBS.filter((j) => j.status === 'recurring')
  .sort((a, b) => a.scheduledAt - b.scheduledAt)
  .map(decorated)

export function resolveBusy(fn: string, args: any): unknown {
  const clientId = args?.clientId
  const propertyId = args?.propertyId
  const jobId = args?.jobId
  const busyProperty = propertyId === SITE_A || propertyId === SITE_B
  switch (fn) {
    case 'clients:get':
      return clientId === BUSY_CLIENT_ID ? BUSY_CLIENT : undefined
    case 'clientContacts:list':
      return clientId === BUSY_CLIENT_ID
        ? [
            {
              _id: 'bc1',
              name: 'Mark Ellis',
              role: 'Strata manager',
              phone: '0433 555 010',
              email: 'manager@harbourside.example',
              isPrimary: true,
            },
            {
              _id: 'bc2',
              name: 'Concierge',
              role: 'Front desk',
              phone: '08 9221 4401',
              isPrimary: false,
            },
          ]
        : undefined
    case 'properties:listByClient':
      return clientId === BUSY_CLIENT_ID ? SITES : undefined
    case 'clients:jobHistory':
      return clientId === BUSY_CLIENT_ID ? BUSY_JOBS : undefined
    case 'clients:reports':
      return clientId === BUSY_CLIENT_ID ? BUSY_REPORTS.slice(0, 20) : undefined
    case 'notes:listForClient':
      return clientId === BUSY_CLIENT_ID
        ? [SITE_NOTE, CLIENT_NOTE, ...VISIT_NOTES]
        : undefined
    case 'jobs:get':
      return jobId === BUSY_JOB_ID ? busyJobGet() : undefined
    case 'properties:jobHistory':
      return busyProperty
        ? BUSY_JOBS.filter((j) => j.propertyId === propertyId)
        : undefined
    case 'reports:listByProperty':
      return busyProperty
        ? BUSY_REPORTS.filter((r) => r.propertyId === propertyId)
        : undefined
    case 'notes:listForProperty':
      return busyProperty
        ? { site: [SITE_NOTE, CLIENT_NOTE], visits: VISIT_NOTES }
        : undefined
    case 'notes:listForJob':
      return jobId === NEXT_GPC._id ? [VISIT_NOTES[0]] : undefined
    default:
      return undefined
  }
}
