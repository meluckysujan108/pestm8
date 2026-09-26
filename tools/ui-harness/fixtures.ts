/* Sample data for the harness, keyed by Convex function name ("module:fn"). */

export const TZ = 'Australia/Perth'
export const BIZ = 'biz_demo'

function perthToday(h: number, m = 0): number {
  const now = new Date()
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now)
  // Perth is UTC+8 all year.
  return Date.parse(
    `${key}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`,
  )
}

export const MEMBERS = [
  { _id: 'm_owner', name: 'Terence Walsh', colour: '#0A84FF', role: 'owner' },
  {
    _id: 'm_kev',
    name: 'Kevin Doyle',
    colour: '#FF3B30',
    role: 'subcontractor',
  },
  {
    _id: 'm_sam',
    name: 'Sam Nguyen',
    colour: '#34C759',
    role: 'subcontractor',
  },
]

export const JOBS = [
  {
    _id: 'j1',
    jobNumber: 1041,
    jobType: 'General Pest Control',
    price: 22000,
    scheduledAt: perthToday(8),
    durationMinutes: 60,
    status: 'booked',
    addressLine: '14 Mounts Bay Rd',
    suburb: 'Crawley',
    postcode: '6009',
    propertyState: 'WA',
    clientName: 'Harriet Cole',
    clientPhone: '0412 345 678',
    clientEmail: 'harriet@example.com',
    clientKind: 'person',
    assigneeColour: '#0A84FF',
    assigneeName: 'Terence Walsh',
    assignedMembershipId: 'm_owner',
  },
  {
    _id: 'j2',
    jobNumber: 1042,
    jobType: 'Termite Inspection',
    price: 38500,
    scheduledAt: perthToday(10, 30),
    durationMinutes: 90,
    status: 'pending',
    addressLine: '220 Hay St',
    suburb: 'Subiaco',
    postcode: '6008',
    propertyState: 'WA',
    clientName: 'Subi Café Group',
    clientPhone: '08 9381 2200',
    clientEmail: 'ops@subicafe.example',
    clientKind: 'business',
    siteContactName: 'Priya (manager)',
    siteContactPhone: '0433 111 222',
    assigneeColour: '#FF3B30',
    assigneeName: 'Kevin Doyle',
    assignedMembershipId: 'm_kev',
    recurrenceId: 'r1',
    repeats: { count: 3, unit: 'month' },
  },
  {
    _id: 'j3',
    jobNumber: 1043,
    jobType: 'Rodents',
    price: 18000,
    scheduledAt: perthToday(13),
    durationMinutes: 45,
    status: 'completed',
    addressLine: '7 Bagot Rd',
    suburb: 'Subiaco',
    postcode: '6008',
    propertyState: 'WA',
    clientName: 'Daniel Price',
    clientPhone: '0400 000 111',
    clientKind: 'person',
    assigneeColour: '#34C759',
    assigneeName: 'Sam Nguyen',
    assignedMembershipId: 'm_sam',
  },
  {
    _id: 'j4',
    jobNumber: 1044,
    jobType: 'General Pest Control',
    price: 19500,
    scheduledAt: perthToday(15, 30),
    durationMinutes: 60,
    status: 'recurring',
    addressLine: '31 Railway Pde',
    suburb: 'Mount Lawley',
    postcode: '6050',
    propertyState: 'WA',
    clientName: 'Lena Brooks',
    clientPhone: '0455 222 333',
    clientKind: 'person',
    assigneeColour: '#0A84FF',
    assigneeName: 'Terence Walsh',
    assignedMembershipId: 'm_owner',
    recurrenceId: 'r2',
    repeats: { count: 6, unit: 'month' },
  },
]

const ALL_CAPS = {
  'business.manage': true,
  'templates.manage': true,
  'team.manage': true,
  'clients.manage': true,
  'jobs.dispatch': true,
  'prices.see': true,
  'clients.directory': true,
  'schedules.seeOthers': true,
  'accounts.switch': false,
}

export const state = { actingAs: false }

function accessMe() {
  return {
    membershipId: 'm_owner',
    role: 'owner',
    caps: ALL_CAPS,
    actingAs: state.actingAs
      ? { membershipId: 'm_kev', name: 'Kevin Doyle' }
      : null,
    expiresAt: state.actingAs ? Date.now() + 5 * 3600_000 : null,
    degraded: null,
    viewingAs: null,
    view: { mode: 'everyone' },
  }
}

function jobGet(args: { jobId: string }) {
  if (args.jobId === 'loading') return undefined
  const row = JOBS.find((j) => j._id === args.jobId) ?? JOBS[1]
  return {
    ...row,
    businessId: BIZ,
    propertyId: 'p_' + row._id,
    workOrder: row.clientKind === 'business' ? 'PO-88213' : undefined,
    property: {
      _id: 'p_' + row._id,
      addressLine: row.addressLine,
      suburb: row.suburb,
      state: 'WA',
      postcode: row.postcode,
      siteContactName: (row as { siteContactName?: string }).siteContactName,
      siteContactPhone: (row as { siteContactPhone?: string }).siteContactPhone,
      client: {
        _id: 'c_' + row._id,
        name: row.clientName,
        kind: row.clientKind,
        phone: row.clientPhone,
        email: (row as { clientEmail?: string }).clientEmail,
      },
    },
    recurrence: row.recurrenceId
      ? {
          _id: row.recurrenceId,
          interval: { count: 3, unit: 'month' },
          active: true,
        }
      : null,
    assignee: {
      _id: row.assignedMembershipId,
      colour: row.assigneeColour,
      role: 'owner',
    },
    canEdit: true,
  }
}

const CLIENT = {
  _id: 'c1',
  businessId: BIZ,
  kind: 'business',
  name: 'Subi Café Group',
  abn: '51824753556',
  phone: '08 9381 2200',
  email: 'ops@subicafe.example',
  addressLine: '220 Hay St',
  suburb: 'Subiaco',
  state: 'WA',
  postcode: '6008',
}

const FIXTURES: Partial<Record<string, (args: any) => unknown>> = {
  'setupGuide:progress': () => ({
    hidden: false,
    items: [
      { key: 'business', done: true },
      { key: 'letterhead', done: true },
      { key: 'licence', done: false },
      { key: 'firstJob', done: false },
      { key: 'firstReport', done: false },
    ],
  }),
  'clients:get': () => CLIENT,
  'clientContacts:list': () => [
    {
      _id: 'cc1',
      name: 'Priya Raman',
      role: 'Venue manager',
      phone: '0433 111 222',
      email: 'priya@subicafe.example',
      isPrimary: true,
    },
    {
      _id: 'cc2',
      name: 'Tom Hale',
      role: 'Accounts',
      phone: '08 9381 2201',
      email: 'accounts@subicafe.example',
      isPrimary: false,
    },
  ],
  'properties:listByClient': () => [
    {
      _id: 'p1',
      addressLine: '220 Hay St',
      suburb: 'Subiaco',
      state: 'WA',
      postcode: '6008',
      siteContactName: 'Priya',
      siteContactPhone: '0433 111 222',
    },
    {
      _id: 'p2',
      addressLine: '9 Rokeby Rd',
      suburb: 'Subiaco',
      state: 'WA',
      postcode: '6008',
    },
  ],
  'clients:jobHistory': () => [],
  'clients:reports': () => [],
  'notes:listForClient': () => [],
  'access:me': accessMe,
  'jobs:get': jobGet,
  'jobs:photos': () => [],
  'properties:jobHistory': () => [],
  'reports:listByProperty': () => [],
  'memberships:listForBusiness': () =>
    MEMBERS.map((m) => ({ ...m, displayName: m.name, status: 'active' })),
  'weather:forDays': () => [],
  'notes:unreadMentionCount': () => 2,
}

export function resolveFixture(fn: string, args: unknown): unknown {
  const f = FIXTURES[fn]
  return f ? f(args) : undefined
}
