/* Sample data for the harness, keyed by Convex function name ("module:fn"). */

import { BUSY_SITES_FOR_LIST, resolveBusy } from './busyFixtures'
import { JOB_TYPES_LIST, JOB_TYPES_MANAGE } from './jobTypeFixtures'

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
    // Several services on one visit (convex/lib/jobTypes.ts), and a note.
    jobType: 'General Pest Control, Termite Inspection, Rodents',
    notePreview: 'Tenant home after 10 — ring first. · Dog in the back yard.',
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
    // A shared job: Kevin is also going (convex/lib/jobPeople.ts).
    alsoGoing: [{ _id: 'm_kev', name: 'Kevin Doyle', colour: '#FF3B30' }],
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
  {
    _id: 'j5',
    jobNumber: 1045,
    jobType: 'Cockroaches',
    price: 17500,
    scheduledAt: perthToday(17),
    durationMinutes: 60,
    status: 'booked',
    addressLine: '142 Oxford St',
    suburb: 'Leederville',
    postcode: '6007',
    propertyState: 'WA',
    // A business with a contact person and no site contact: the card's
    // Contact line says who to ask for on the business's line
    // (convex/lib/siteContact.ts).
    clientName: 'Leederville Noodle House Pty Ltd',
    clientPhone: '08 9444 1200',
    clientEmail: 'accounts@noodlehouse.example',
    clientKind: 'business',
    contactPersonName: 'Jan Morris',
    contactPersonPhone: '',
    assigneeColour: '#0A84FF',
    assigneeName: 'Terence Walsh',
    assignedMembershipId: 'm_owner',
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

/** `actingAs`: working in Kevin's account. `technician`: signed in as a
 * subcontractor, with no owner's capabilities. */
export const state = { actingAs: false, technician: false }

function accessMe() {
  return {
    membershipId: 'm_owner',
    role: state.technician ? 'subcontractor' : 'owner',
    caps: state.technician
      ? { ...ALL_CAPS, 'business.manage': false, 'team.manage': false }
      : ALL_CAPS,
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
    // `jobs.get` reads the business's contact person (lib/contactPerson.ts).
    contactPerson: (row as { contactPersonName?: string }).contactPersonName
      ? {
          name: (row as { contactPersonName: string }).contactPersonName,
          phone:
            (row as { contactPersonPhone?: string }).contactPersonPhone ||
            undefined,
        }
      : null,
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
    alsoGoing: (
      (row as { alsoGoing?: Array<{ _id: string; colour: string }> })
        .alsoGoing ?? []
    ).map((p) => ({ _id: p._id, colour: p.colour, role: 'subcontractor' })),
    canEdit: true,
  }
}

/**
 * What `properties.list` answers: every job's own site, then enough more that
 * a picker's list is longer than the screen — the case that has to scroll.
 */
const MORE_SITES = [
  ['Aisha Rahman', '4 Coode St', 'Como', '6152'],
  ['Ben Carter', '17 Leake St', 'Bayswater', '6053'],
  ['Chloe Nguyen', '88 Walcott St', 'Mount Lawley', '6050'],
  ['Dev Patel', '3 Rokeby Rd', 'Subiaco', '6008'],
  ['Ella Moore', '120 Oxford St', 'Leederville', '6007'],
  ['Finn O’Brien', '9 Harvest Tce', 'West Perth', '6005'],
  ['Grace Liu', '41 Guildford Rd', 'Maylands', '6051'],
  ['Hamish Reid', '6 Kalamunda Rd', 'Kalamunda', '6076'],
  ['Isla Thompson', '22 Canning Hwy', 'Applecross', '6153'],
  ['Jack Wilson', '15 Scarborough Beach Rd', 'Scarborough', '6019'],
  ['Kira Anand', '70 Great Eastern Hwy', 'Rivervale', '6103'],
  ['Liam Hughes', '2 Marine Pde', 'Cottesloe', '6011'],
] as const

function propertiesList() {
  const jobSites = JOBS.map((row) => ({
    _id: 'p_' + row._id,
    addressLine: row.addressLine,
    suburb: row.suburb,
    postcode: row.postcode,
    client: {
      name: row.clientName,
      kind: row.clientKind,
      phone: row.clientPhone,
    },
  }))
  // Two of them added by hand this week, the rest long ago: the picker opens
  // on "Added recently", then everyone A–Z.
  const DAY = 24 * 60 * 60 * 1000
  const more = MORE_SITES.map(([name, addressLine, suburb, postcode], i) => {
    const createdAt = Date.now() - (i >= 10 ? (12 - i) * DAY : 400 * DAY)
    return {
      _id: `p_more${i}`,
      addressLine,
      suburb,
      postcode,
      createdAt,
      client: { name, kind: 'person', createdAt },
    }
  })
  return [...jobSites, ...more, ...BUSY_SITES_FOR_LIST()]
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

/** What `deliveries.known` says about Terence's business, whose copy inbox
 * is info@. `r_nomail` is a deployment with no email set up; `r_big` a
 * report with more photos than an email carries (convex/emailCopy.ts). */
function deliveriesKnown(args: { reportId: string }) {
  // `r_none` and `r_noclientmail`: a client with no address on their record.
  const noEmail =
    args.reportId === 'r_none' || args.reportId === 'r_noclientmail'
  return {
    addresses: noEmail
      ? ['info@pestm8.com.au']
      : [
          'jane@gmail.com',
          'bob@harbourside-strata.com.au',
          'kim@coastalagents.com.au',
          'info@pestm8.com.au',
        ],
    copy: 'info@pestm8.com.au',
    emailReady: args.reportId !== 'r_nomail',
    largeForEmail: args.reportId === 'r_big',
    // The client book, by name: the client, then their contacts.
    people: noEmail
      ? []
      : [
          {
            address: 'jane@gmail.com',
            name: 'Jane Nguyen',
            kind: 'client',
            role: null,
            primary: false,
          },
          {
            address: 'bob@harbourside-strata.com.au',
            name: 'Bob Lee',
            kind: 'contact',
            role: 'Strata manager',
            primary: false,
          },
          {
            address: 'kim@coastalagents.com.au',
            name: 'Kim Wu',
            kind: 'contact',
            role: 'Property manager',
            primary: true,
          },
        ],
    client: { clientId: 'c1', name: 'Jane Nguyen', hasEmail: !noEmail },
  }
}

/** One delivery per report id, one per state a finished report's Email list
 * can show. */
function deliveryRows(args: { reportId: string }) {
  const at = perthToday(14, 38)
  const base = {
    _id: `d_${args.reportId}`,
    to: ['jane@gmail.com'],
    cc: [],
    bcc: ['info@pestm8.com.au'],
    subject: 'Service Report — 30 Sloan Drive, Leda',
    trigger: 'finalise',
    createdAt: at,
    sentBy: { name: 'Terence Walsh', colour: '#0A84FF' },
    onBehalfOf: null,
    newAddresses: [],
    waitingForEmailSetup: false,
  }
  const kevin = { name: 'Kevin Doyle', colour: '#FF3B30' }
  // The strata manager the form was asked to copy, who is on nobody's
  // record: one email with the client, marked new (`queueFormDeliveries`).
  const withStrata = {
    ...base,
    to: ['jane@gmail.com', 'strata@harbourside.com.au'],
    newAddresses: ['strata@harbourside.com.au'],
  }
  const rows: Record<string, Array<unknown>> = {
    // Moments ago, so it is still on its way.
    r_sending: [{ ...base, status: 'queued', createdAt: Date.now() }],
    // Queued ten minutes ago and never sent: not "Sending…" any more.
    r_stuck: [{ ...base, status: 'queued', createdAt: Date.now() - 600_000 }],
    r_sent: [{ ...base, status: 'sent', sentAt: at + 10_000 }],
    r_new: [{ ...withStrata, status: 'sent', sentAt: at + 10_000 }],
    r_failed: [
      {
        ...base,
        status: 'failed',
        error:
          'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.',
      },
    ],
    // A finished report's Email list: the form's own as Kevin locked it, one
    // to someone new made by Terence in Kevin's account, then Kevin's own to
    // a typo that failed.
    r_history: [
      {
        ...base,
        _id: 'd_history_3',
        sentBy: kevin,
        trigger: 'manual',
        to: ['acounts@ridgeline.com.au'],
        newAddresses: ['acounts@ridgeline.com.au'],
        status: 'failed',
        createdAt: at + 3_600_000,
        error:
          'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.',
      },
      {
        ...withStrata,
        _id: 'd_history_2',
        trigger: 'manual',
        sentBy: { name: 'Terence Walsh', colour: '#0A84FF' },
        onBehalfOf: kevin,
        status: 'sent',
        createdAt: at + 1_800_000,
        sentAt: at + 1_810_000,
      },
      { ...base, sentBy: kevin, status: 'sent', sentAt: at + 10_000 },
    ],
    // What rows from before approval was retired (29 Sept 2026) look like:
    // one that was still held and was released as not sent, one an owner
    // refused, and a send with no `newAddresses` at all.
    r_legacy: [
      {
        ...base,
        _id: 'd_legacy_3',
        to: ['strata@harbourside.com.au'],
        newAddresses: undefined,
        sentBy: kevin,
        status: 'failed',
        createdAt: at + 2_000_000,
        error:
          'Not sent: it was waiting for an owner’s approval, which isn’t needed any more. Send it again if it should still go.',
      },
      {
        ...base,
        _id: 'd_legacy_2',
        to: ['strata.committee@example.org'],
        newAddresses: undefined,
        sentBy: kevin,
        status: 'failed',
        createdAt: at + 1_000_000,
        error: 'Not approved',
      },
      {
        ...base,
        _id: 'd_legacy_1',
        newAddresses: undefined,
        onBehalfOf: undefined,
        status: 'sent',
        sentAt: at + 10_000,
      },
    ],
    // Refused by an owner before approval was retired.
    r_refused: [
      {
        ...base,
        to: ['strata.committee@example.org'],
        status: 'failed',
        error: 'Not approved',
      },
    ],
    r_setup: [{ ...base, status: 'queued', waitingForEmailSetup: true }],
    // A 53-photo job: its own PDF was more than an email carries, so the
    // copy with smaller photos went.
    r_big: [
      {
        ...base,
        _id: 'd_big',
        status: 'sent',
        sentAt: at + 60_000,
        lighterCopy: true,
      },
    ],
  }
  return rows[args.reportId] ?? []
}

/** A report's audit rows: who did what, and every email's addresses (which
 * the page's Activity leaves to its Email list). `r_logs_legacy` and
 * `r_legacy` are from before approval was retired. */
function auditEntries(args: { entityId: string }) {
  const at = perthToday(14, 38)
  const kevin = { actorName: 'Kevin Doyle', actorColour: '#FF3B30' }
  const terence = { actorName: 'Terence Walsh', actorColour: '#0A84FF' }
  if (args.entityId === 'r_big') {
    return [
      {
        _id: 'b1',
        action: 'report.email.sent',
        at: at + 60_000,
        ...terence,
        meta: {
          to: ['jane@gmail.com'],
          bcc: ['info@pestm8.com.au'],
          trigger: 'finalise',
          lighterCopy: true,
          photoEdge: 1000,
        },
      },
    ]
  }
  // Just locked, or never emailed: only the lock is on record.
  if (args.entityId === 'r_sending' || args.entityId === 'r_none') {
    return [
      {
        _id: 'f1',
        action: 'report.finalise',
        at: Date.now() - 20_000,
        ...kevin,
        meta: {},
      },
    ]
  }
  if (args.entityId === 'r_logs_legacy' || args.entityId === 'r_legacy') {
    return [
      {
        _id: 'l4',
        action: 'report.email.bounced',
        at: at + 7_200_000,
        ...kevin,
        meta: {
          to: ['jane@gmail.com'],
          event: 'complained',
          detail: 'Marked as spam by the recipient',
        },
      },
      {
        _id: 'l3',
        action: 'report.email.rejected',
        at: at + 3_600_000,
        ...terence,
        meta: { to: ['strata.committee@example.org'] },
      },
      {
        _id: 'l2',
        action: 'report.email.pending_approval',
        at: at + 60_000,
        ...kevin,
        meta: {
          to: ['strata.committee@example.org'],
          novel: ['strata.committee@example.org'],
        },
      },
      {
        _id: 'l1',
        action: 'report.email',
        at,
        ...kevin,
        meta: { to: 'jane@gmail.com' },
      },
    ]
  }
  return [
    {
      _id: 'a4',
      action: 'report.email.failed',
      at: at + 3_600_000,
      ...kevin,
      meta: {
        to: ['acounts@ridgeline.com.au'],
        bcc: ['info@pestm8.com.au'],
        newAddresses: ['acounts@ridgeline.com.au'],
        trigger: 'manual',
        detail:
          'Not sent: the PDF could not be prepared to attach. Open the PDF tab, then send it again.',
      },
    },
    {
      _id: 'a3',
      action: 'report.email.sent',
      at: at + 1_810_000,
      actorName: 'Terence Walsh',
      actorColour: '#0A84FF',
      onBehalfOfName: 'Kevin Doyle',
      meta: {
        to: ['jane@gmail.com', 'strata@harbourside.com.au'],
        bcc: ['info@pestm8.com.au'],
        newAddresses: ['strata@harbourside.com.au'],
        trigger: 'manual',
      },
    },
    {
      _id: 'a2',
      action: 'report.email.sent',
      at: at + 10_000,
      ...kevin,
      meta: {
        to: ['jane@gmail.com'],
        bcc: ['info@pestm8.com.au'],
        trigger: 'finalise',
      },
    },
    { _id: 'a1', action: 'report.finalise', at, ...kevin, meta: {} },
  ]
}

/**
 * A finalised Pest Service Report as `reports.get` returns it — #12, Kevin's,
 * for Jane Nguyen at 30 Sloan Drive — with `overrides` for the state a
 * specimen shows (sent, replaced, no PDF yet). Its sends and activity come
 * from the fixtures above, by `id`.
 */
export function finishedReport(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const at = perthToday(14, 38)
  return {
    _id: id,
    _creationTime: at - 3_600_000,
    businessId: BIZ,
    template: 'serviceReport',
    templateVersion: undefined,
    customTemplate: null,
    templateSnapshot: null,
    legalBasis: 'APVMA · AEPMA',
    status: 'finalised',
    finalisedAt: at,
    reportNumber: 12,
    version: 1,
    jobId: 'j1',
    businessName: 'Coastal Pest Control',
    business: {
      logoUrl: SAMPLE_LOGO,
      phone: '08 9381 2200',
      email: 'info@pestm8.com.au',
    },
    property: {
      client: { name: 'Jane Nguyen' },
      addressLine: '30 Sloan Drive',
      suburb: 'Leda',
      state: 'WA',
      postcode: '6170',
    },
    author: { name: 'Kevin Doyle', licenceNumber: 'PMT 4471' },
    context: {
      client: {
        name: 'Jane Nguyen',
        email: 'jane@gmail.com',
        phone: '0412 345 678',
      },
      technician: { name: 'Kevin Doyle', licence: 'PMT 4471' },
      job: { number: '1042' },
    },
    contextSnapshot: {
      client: { name: 'Jane Nguyen' },
      property: { suburb: 'Leda' },
    },
    // Any URL: "Ready" is all the page reads from it until the viewer opens.
    pdfUrl: 'https://example.invalid/report.pdf',
    data: {
      serviceDate: '2026-09-30',
      startTime: '09:30',
      finishTime: '10:15',
      sendCopy: true,
      spillKit: true,
      msds: true,
      ppe: true,
      chemicalsSecured: true,
      firstAid: true,
      signage: true,
      safeToStart: true,
      comments:
        'Treated the perimeter and the garage. German cockroach activity under the kitchen sink — gel baits placed.',
    },
    canEdit: false,
    canAmend: true,
    correcting: false,
    ...overrides,
  }
}

/**
 * A made-up business's logo, drawn rather than shipped: dark lettering for
 * paper, and the version with white lettering for dark backgrounds.
 */
function sampleLogo(ink: string): string {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 104"><circle cx="52" cy="52" r="40" fill="#e8352b"/><path d="M28 62c12-26 34-34 48-29-9 5-16 13-18 25-9-7-21-5-30 4z" fill="#fff"/><text x="108" y="62" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="46" fill="${ink}">COASTAL</text><text x="110" y="90" font-family="Helvetica,Arial,sans-serif" font-size="19" fill="#e8352b">Pest Control</text></svg>`,
    )
  )
}
export const SAMPLE_LOGO = sampleLogo('#141414')
export const SAMPLE_LOGO_ON_DARK = sampleLogo('#ffffff')

/** The businesses the Letterhead specimens show: with both logos, with no
 * dark version, and with no logo at all. */
export const LETTERHEAD_BIZ = {
  both: BIZ,
  noDark: 'biz_nodark',
  noLogo: 'biz_nologo',
} as const

const FIXTURES: Partial<Record<string, (args: any) => unknown>> = {
  // Settings → Reports for Terence's business: its copy goes to info@.
  'businesses:reportSettings': (args: { businessId?: string }) => ({
    tradingName: undefined,
    reportBrandName: undefined,
    website: 'www.pestm8.com.au',
    reportCopyEmail: 'info@pestm8.com.au',
    requireReportToComplete: false,
    email: 'info@pestm8.com.au',
    logoOnDarkUrl:
      args.businessId === LETTERHEAD_BIZ.both ? SAMPLE_LOGO_ON_DARK : null,
  }),
  // What Settings → Business reads live, keyed by which of the three.
  'businesses:getBySlug': (args: { slug: string }) => ({
    _id:
      args.slug === 'nodark'
        ? LETTERHEAD_BIZ.noDark
        : args.slug === 'nologo'
          ? LETTERHEAD_BIZ.noLogo
          : LETTERHEAD_BIZ.both,
    name: 'Pest M8 Pest Control',
    slug: args.slug,
    state: 'WA',
    timezone: TZ,
    abn: '51 824 753 556',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    postcode: '6053',
    phone: '1800 737 868',
    email: 'info@pestm8.com.au',
    licenceNumber: 'PMT 4132',
    logoUrl: args.slug === 'nologo' ? null : SAMPLE_LOGO,
    membership: {
      _id: 'm_owner',
      role: 'owner',
      canViewAllJobs: true,
      colour: '#0A84FF',
    },
  }),
  'deliveries:known': deliveriesKnown,
  'auditLog:forEntity': auditEntries,
  // Nothing set yet: the form's own rule, as a new business finds it.
  'templateSettings:get': () => null,
  'deliveries:forReport': deliveryRows,
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
  'clients:summary': () => ({
    properties: [
      { _id: 'p1', addressLine: '220 Hay St', suburb: 'Subiaco' },
      { _id: 'p2', addressLine: '9 Rokeby Rd', suburb: 'Subiaco' },
    ],
    series: [],
    visits: [],
    capped: false,
  }),
  'clients:visitReports': () => ({ reports: [], capped: false }),
  'notes:listForClient': () => [],
  'notes:listForProperty': () => ({ site: [], visits: [] }),
  // j1's note, as the card's preview says it: a note in Notes on the job.
  'notes:listForJob': (args: { jobId?: string } | undefined) =>
    args?.jobId === 'j1'
      ? [
          {
            _id: 'n_j1',
            kind: 'job',
            title: 'Tenant home after 10 — ring first.',
            preview: 'Dog in the back yard.',
            jobId: 'j1',
            job: null,
            authorColour: '#0A84FF',
            authorName: 'Terence Walsh',
            editorName: 'Terence Walsh',
            authorRole: 'owner',
            createdAt: Date.now() - 3600_000,
            updatedAt: Date.now() - 3600_000,
            canEdit: true,
            canDelete: true,
            private: false,
            mine: true,
            clientName: 'Subi Café Group',
            addressLine: '220 Hay St',
            suburb: 'Subiaco',
          },
        ]
      : [],
  'access:me': accessMe,
  'jobs:get': jobGet,
  'jobs:photos': () => [],
  'properties:jobHistory': () => [],
  'reports:listByProperty': () => [],
  // A finished report's photos: none on the sample.
  'reports:galleryPhotos': () => [],
  'reports:photoUrls': () => ({}),
  'properties:list': propertiesList,
  'memberships:listForBusiness': () =>
    MEMBERS.map((m) => ({ ...m, displayName: m.name, status: 'active' })),
  'weather:forDays': () => [],
  'notes:unreadMentionCount': () => 2,
  'bin:list': () => ({ entries: BIN_ENTRIES, capped: false }),
  'reports:list': (args: { filter: string }) => ({
    page: args.filter === 'trash' ? REPORTS_DELETED : REPORTS,
    isDone: true,
    continueCursor: '',
  }),
  'reports:staleDrafts': () => ({ count: 0, oldest: null }),
  'jobTypes:manage': () => JOB_TYPES_MANAGE,
  'jobTypes:list': () => JOB_TYPES_LIST,
}

export function resolveFixture(fn: string, args: unknown): unknown {
  const busy = resolveBusy(fn, args)
  if (busy !== undefined) return busy
  const f = FIXTURES[fn]
  return f ? f(args) : undefined
}

/** What `bin.list` answers: one of each kind, as Settings → Recycle bin
 * shows them. */
const HOUR = 60 * 60 * 1000
export const BIN_ENTRIES = [
  {
    _id: 'bin0',
    kind: 'contact',
    title: 'Tom Hale',
    clientName: 'Subi Café Group',
    deletedAt: Date.now() - HOUR,
    wipesAt: Date.now() - HOUR + 30 * 24 * HOUR,
    deletedBy: 'Terence Van Der Walt',
    archivedAt: null,
    counts: { properties: 0, jobs: 0, recurrences: 0, notes: 0, drafts: 0 },
  },
  {
    _id: 'bin1',
    kind: 'job',
    title: 'Termite Inspection',
    suburb: 'Bayswater',
    scheduledAt: Date.now() + 26 * HOUR,
    deletedAt: Date.now() - 2 * HOUR,
    wipesAt: Date.now() - 2 * HOUR + 30 * 24 * HOUR,
    deletedBy: 'Kevin Tran',
    counts: { properties: 0, jobs: 0, recurrences: 0, notes: 1, drafts: 1 },
  },
  {
    _id: 'bin2',
    kind: 'client',
    title: 'Jane Smith',
    deletedAt: Date.now() - 30 * HOUR,
    wipesAt: Date.now() - 30 * HOUR + 30 * 24 * HOUR,
    deletedBy: 'Terence Van Der Walt',
    counts: { properties: 2, jobs: 14, recurrences: 1, notes: 3, drafts: 0 },
  },
  {
    _id: 'bin3',
    kind: 'property',
    title: '9 Rokeby Rd',
    suburb: 'Subiaco',
    clientName: 'Harbour Strata',
    deletedAt: Date.now() - 5 * 24 * HOUR,
    wipesAt: Date.now() - 5 * 24 * HOUR + 30 * 24 * HOUR,
    deletedBy: 'Terence Van Der Walt',
    counts: { properties: 0, jobs: 3, recurrences: 0, notes: 0, drafts: 0 },
  },
  {
    _id: 'bin4',
    kind: 'recurrence',
    title: 'General Pest',
    suburb: 'Cottesloe',
    interval: { count: 3, unit: 'month' },
    deletedAt: Date.now() - 9 * 24 * HOUR,
    wipesAt: Date.now() - 9 * 24 * HOUR + 30 * 24 * HOUR,
    deletedBy: 'Terence Van Der Walt',
    counts: { properties: 0, jobs: 4, recurrences: 0, notes: 0, drafts: 0 },
  },
  {
    _id: 'bin5',
    kind: 'client',
    title: 'Coastal Holiday Units',
    deletedAt: Date.now() - 3 * HOUR,
    wipesAt: Date.now() - 3 * HOUR + 30 * 24 * HOUR,
    deletedBy: '',
    archivedAt: Date.now() - 17 * 24 * HOUR,
    counts: { properties: 1, jobs: 9, recurrences: 0, notes: 1, drafts: 0 },
  },
]

function reportRow(
  id: string,
  row: {
    status: 'draft' | 'finalised'
    templateName: string
    legalBasis: string
    clientName: string
    suburb: string
    reportNumber?: number
    version?: number
    replaced?: boolean
    emailedAt?: number
  },
) {
  return {
    _id: id,
    template: 'serviceReport',
    propertyId: 'p1',
    createdAt: Date.now() - 3 * 24 * HOUR,
    finalisedAt: row.status === 'finalised' ? Date.now() - 2 * HOUR : undefined,
    ...row,
  }
}

/** What `reports.list` answers: a draft, a signed report sent to the client,
 * and a number issued twice — as the Reports list shows them. */
const REPORTS = [
  reportRow('r_draft', {
    status: 'draft',
    templateName: 'Service Report',
    legalBasis: 'APVMA',
    clientName: 'Lena Brooks',
    suburb: 'Nedlands',
  }),
  reportRow('r_sent', {
    status: 'finalised',
    templateName: 'Service Report',
    legalBasis: 'APVMA',
    clientName: 'J. Nguyen',
    suburb: 'Bayswater',
    reportNumber: 12,
    emailedAt: Date.now() - HOUR,
  }),
  reportRow('r_v2', {
    status: 'finalised',
    templateName: 'Timber Pest Inspection Report',
    legalBasis: 'AS 4349.3-2010',
    clientName: 'Subi Café Group',
    suburb: 'Subiaco',
    reportNumber: 4,
    version: 2,
  }),
]

/** Deleted: one signed report (with its versions) and one draft. */
const REPORTS_DELETED = [
  reportRow('r_gone', {
    status: 'finalised',
    templateName: 'Service Report',
    legalBasis: 'APVMA',
    clientName: 'R. Patel',
    suburb: 'Maylands',
    reportNumber: 9,
    version: 3,
  }),
  reportRow('r_gone_draft', {
    status: 'draft',
    templateName: 'Service Report',
    legalBasis: 'APVMA',
    clientName: 'Lena Brooks',
    suburb: 'Nedlands',
  }),
]
