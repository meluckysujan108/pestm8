import { v } from 'convex/values'
import { addDaysToKey, zonedDateTimeToUtc } from '../lib/dates'
import type { Infer } from 'convex/values'
import type { JobStatus } from '../lib/jobStatus'

/**
 * The demo business: what every step of the seed (convex/demo/*.ts) agrees
 * on. Run and removed as the header of convex/demo/seed.ts describes.
 *
 * Everything here is fictional. Phone numbers are the ranges ACMA reserves
 * for fiction (0491 570 xxx…, (08) 5550 xxxx), email addresses use the
 * reserved example.com / example.net domains, and the placeholder people use
 * `demo.pestm8.invalid`, which can never receive mail or be signed up.
 */

/** Written to `businesses.plan` (read by nothing else): what cleanup checks
 * before it deletes anything. */
export const DEMO_PLAN = 'demo-seed'

/** The placeholder people the seed adds to the roster (the removed former
 * technician, and a whole-schedule subcontractor). They have a Better Auth
 * user row so names resolve, and no account or session, so nobody can sign
 * in as them. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'demo.pestm8.invalid'

export const DEMO_BUSINESS_NAME = 'Demo – Swan River Pest Co (sample data)'
export const DEMO_TIMEZONE = 'Australia/Perth'
export const DEMO_STATE = 'WA'

export type MemberKey = 'owner' | 'contractor' | 'sub' | 'dana' | 'former'

// ─────────────────────────────────────────────────────────── passed along

export const demoMembersV = v.object({
  owner: v.id('memberships'),
  contractor: v.id('memberships'),
  sub: v.id('memberships'),
  /** Placeholder: an active subcontractor directly under the owner, who may
   * see (not edit) every schedule. */
  dana: v.id('memberships'),
  /** Placeholder: a technician who left 30 days ago. Status 'removed'. */
  former: v.id('memberships'),
})

export const demoImagesV = v.object({
  logo: v.id('_storage'),
  /** One drawn signature per person who signs, plus a client's. */
  signatures: v.object({
    owner: v.id('_storage'),
    contractor: v.id('_storage'),
    sub: v.id('_storage'),
    dana: v.id('_storage'),
    client: v.id('_storage'),
  }),
  /** Site photographs, landscape and portrait mixed; see seedImages.ts. */
  photos: v.array(
    v.object({
      storageId: v.id('_storage'),
      width: v.number(),
      height: v.number(),
    }),
  ),
})

/** What the first step returns and every later step is handed. */
export const demoBaseV = v.object({
  businessId: v.id('businesses'),
  timezone: v.string(),
  /** Today in the business's zone AT SEED TIME. Every step dates from this,
   * so a seed straddling midnight cannot disagree with itself. */
  todayKey: v.string(),
  members: demoMembersV,
  images: demoImagesV,
})
export type DemoBase = Infer<typeof demoBaseV>

export const propertyMapV = v.record(v.string(), v.id('properties'))
export const clientMapV = v.record(v.string(), v.id('clients'))

/** One seeded job, as later steps (reports, notes) look them up. */
export const manifestJobV = v.object({
  key: v.optional(v.string()),
  id: v.id('jobs'),
  propertyKey: v.string(),
  assignee: v.string(), // a MemberKey
  status: v.string(), // a JobStatus
  scheduledAt: v.number(),
  durationMinutes: v.number(),
  jobType: v.string(),
  recurrenceKey: v.optional(v.string()),
})
export type ManifestJob = Infer<typeof manifestJobV>

/** An instant `dayOffset` days from the seed's today, at hh:mm local time. */
export function at(
  base: Pick<DemoBase, 'todayKey' | 'timezone'>,
  dayOffset: number,
  hh: number,
  mm = 0,
): number {
  return zonedDateTimeToUtc(
    addDaysToKey(base.todayKey, dayOffset),
    hh,
    mm,
    base.timezone,
  )
}

// ───────────────────────────────────────────────────────────── clients

export type ContactSpec = {
  name: string
  role?: string
  phone?: string
  email?: string
  /** true = the primary; false = a contact once primary, since demoted. */
  isPrimary?: boolean
}

export type PropertySpec = {
  key: string
  addressLine: string
  suburb: string
  state: string
  postcode: string
}

export type ClientSpec = {
  key: string
  kind: 'person' | 'business'
  name: string
  phone?: string
  email?: string
  /** A business client's own head office, added later as clients.update
   * would add it. */
  headOffice?: {
    addressLine: string
    suburb: string
    state: string
    postcode: string
  }
  contacts?: Array<ContactSpec>
  /** Archived (clients.archive): hidden from the Clients page only. */
  archived?: boolean
  properties: Array<PropertySpec>
}

const wa = (
  key: string,
  addressLine: string,
  suburb: string,
  postcode: string,
): PropertySpec => ({
  key,
  addressLine,
  suburb,
  state: 'WA',
  postcode,
})

/**
 * The clients, in the order the Clients page shows them (insertion order).
 * Each case says what it is there to exercise.
 */
export const CLIENTS: Array<ClientSpec> = [
  // Fully contactable: Call, Text and Email on every card.
  {
    key: 'jenny',
    kind: 'person',
    name: 'Jenny Nguyen',
    phone: '0491 570 156',
    email: 'jenny.nguyen@example.com',
    properties: [wa('jennyHome', '12 Wattle Street', 'Bayswater', '6053')],
  },
  // No phone, no email: no contact row on the card or the sheet.
  {
    key: 'arthur',
    kind: 'person',
    name: 'Arthur Wilson',
    properties: [wa('arthurHome', '21 Guildford Road', 'Maylands', '6051')],
  },
  // Email only.
  {
    key: 'katya',
    kind: 'person',
    name: 'Katya Petrov',
    email: 'k.petrov@example.com',
    properties: [wa('katyaHome', '18 Banksia Road', 'Ellenbrook', '6069')],
  },
  // Phone only.
  {
    key: 'dayo',
    kind: 'person',
    name: 'Dayo Okafor',
    phone: '0491 570 157',
    properties: [wa('dayoHome', '7 Hakea Court', 'Ballajura', '6066')],
  },
  // +61 format; the house with a finished report and a fresh draft
  // (carry-over from the last visit).
  {
    key: 'marcus',
    kind: 'person',
    name: 'Marcus Roberts',
    phone: '+61 491 570 158',
    email: 'marcus.roberts@example.com',
    properties: [wa('marcusHome', '4 Kalinda Way', 'Morley', '6062')],
  },
  // Unspaced phone; two properties, one typed "Mt Lawley" (the weather
  // lookup tries "Mount Lawley"), so the suburb filter lists both spellings.
  {
    key: 'sofia',
    kind: 'person',
    name: 'Sofia Chen',
    phone: '0491570159',
    email: 'sofia.chen@example.com',
    properties: [
      wa('sofiaHome', '88 Beaufort Street', 'Mount Lawley', '6050'),
      wa('sofiaRental', '3/41 Walcott Street', 'Mt Lawley', '6050'),
    ],
  },
  // A business client with a head office, three contacts (one primary, one
  // demoted, one name-only) and five sites, one sharing a tenant's address.
  {
    key: 'ridgeline',
    kind: 'business',
    name: 'Ridgeline Strata Management Pty Ltd',
    phone: '(08) 5550 2000',
    email: 'Accounts@Ridgeline.example.COM',
    headOffice: {
      addressLine: 'Level 2, 45 Ventnor Avenue',
      suburb: 'West Perth',
      state: 'WA',
      postcode: '6005',
    },
    contacts: [
      {
        name: 'Priya Raman',
        role: 'Strata Manager',
        phone: '0491 570 110',
        email: 'priya.raman@example.com',
        isPrimary: true,
      },
      {
        name: 'Tom Hale',
        role: 'Site contact',
        phone: '0491 570 313',
        isPrimary: false,
      },
      { name: 'Accounts' },
    ],
    properties: [
      wa('ridgeOsborne1', '10 Main Street', 'Osborne Park', '6017'),
      wa('ridgeOsborne2', '12 Main Street', 'Osborne Park', '6017'),
      wa('ridgeMalaga', '4 Bonner Drive', 'Malaga', '6090'),
      wa('ridgeJoondalup', '60 Boas Avenue', 'Joondalup', '6027'),
      wa('ridgeMidland', '5 Wandoo Street', 'Midland', '6056'),
    ],
  },
  // Numbers only on a contact: the sheet can call Mick, the job card cannot
  // (cards read the client's own phone).
  {
    key: 'kewdaleCold',
    kind: 'business',
    name: 'Kewdale Cold Storage',
    contacts: [
      {
        name: 'Mick Doyle',
        role: 'Warehouse manager',
        phone: '0491 570 006',
        isPrimary: true,
      },
    ],
    properties: [wa('kewdaleWarehouse', '120 Kewdale Road', 'Kewdale', '6105')],
  },
  // A business with no contacts and no head office.
  {
    key: 'harbourCafe',
    kind: 'business',
    name: 'Harbourview Café',
    properties: [wa('harbourCafe', '2 Mews Road', 'Fremantle', '6160')],
  },
  // Once a business, now a person: its contacts and head office are hidden,
  // but the contacts' emails still count as known report recipients.
  {
    key: 'lena',
    kind: 'person',
    name: 'Lena Fischer',
    phone: '0491 570 737',
    headOffice: {
      addressLine: '9 Jarrah Street',
      suburb: 'Armadale',
      state: 'WA',
      postcode: '6112',
    },
    contacts: [
      {
        name: 'Lena Fischer',
        role: 'Owner',
        email: 'lena.fischer@example.com',
        isPrimary: true,
      },
      { name: 'Jonas Fischer', role: 'Partner', phone: '0491 571 266' },
    ],
    properties: [wa('lenaHome', '9 Jarrah Street', 'Armadale', '6112')],
  },
  // Head office in Sydney, sites in Perth.
  {
    key: 'coastline',
    kind: 'business',
    name: 'Coastline Property Group',
    phone: '(02) 5550 1234',
    email: 'maintenance@coastline.example.net',
    headOffice: {
      addressLine: '1 Martin Place',
      suburb: 'Sydney',
      state: 'NSW',
      postcode: '2000',
    },
    contacts: [
      {
        name: 'Ava Martin',
        role: 'Maintenance coordinator',
        phone: '0491 571 491',
        email: 'ava.martin@example.net',
        isPrimary: true,
      },
    ],
    properties: [
      wa('coastRockingham', '15 Kent Street', 'Rockingham', '6168'),
      wa('coastScarborough', '150 The Esplanade', 'Scarborough', '6019'),
    ],
  },
  // A large portfolio: eight sites across six suburbs ("+N" on the card, a
  // long job history on the sheet).
  {
    key: 'ppm',
    kind: 'business',
    name: 'Perth Property Managers',
    phone: '(08) 5550 3300',
    email: 'repairs@ppm.example.com',
    contacts: [
      {
        name: 'Grace Liu',
        role: 'Property manager',
        phone: '0491 571 804',
        email: 'grace.liu@example.com',
        isPrimary: true,
      },
    ],
    properties: [
      wa('ppm1', '5 Albany Highway', 'Victoria Park', '6100'),
      wa('ppm2', '44 Shepperton Road', 'Victoria Park', '6100'),
      wa('ppm3', '17 Great Eastern Highway', 'Belmont', '6104'),
      wa('ppm4', '9 Wharf Street', 'Cannington', '6107'),
      wa('ppm5', '31 Canning Highway', 'Como', '6152'),
      wa('ppm6', '8 Kintail Road', 'Applecross', '6153'),
      wa('ppm7', '120 Rokeby Road', 'Subiaco', '6008'),
      wa('ppm8', '71 Oxford Street', 'Leederville', '6007'),
    ],
  },
  // Interstate, for the forecast and the business's own time zone:
  // Fannie Bay and Nightcliff in the NT (what the prod "Fannybay" record
  // should have been).
  {
    key: 'greg',
    kind: 'person',
    name: 'Greg Palmer',
    phone: '0491 572 549',
    properties: [
      {
        key: 'fannieBay',
        addressLine: '38 George Crescent',
        suburb: 'Fannie Bay',
        state: 'NT',
        postcode: '0820',
      },
      {
        key: 'nightcliff',
        addressLine: 'Unit 6/79 Progress Drive',
        suburb: 'Nightcliff',
        state: 'NT',
        postcode: '0810',
      },
    ],
  },
  // A border town under its neighbour's postcode (Barooga NSW is 3644, a
  // Victorian number), and an ACT unit.
  {
    key: 'wendy',
    kind: 'person',
    name: 'Wendy Kerr',
    email: 'wendy.kerr@example.org',
    properties: [
      {
        key: 'barooga',
        addressLine: '14 Vermont Street',
        suburb: 'Barooga',
        state: 'NSW',
        postcode: '3644',
      },
      {
        key: 'braddon',
        addressLine: '8/25 Lonsdale Street',
        suburb: 'Braddon',
        state: 'ACT',
        postcode: '2612',
      },
    ],
  },
  // A misspelt suburb the geocoder cannot place: "No forecast".
  {
    key: 'tom',
    kind: 'person',
    name: 'Tom Brennan',
    phone: '0491 572 665',
    properties: [wa('joondalopTypo', '7 Lakeside Drive', 'Joondalop', '6027')],
  },
  // A postcode with a letter O in it.
  {
    key: 'rita',
    kind: 'person',
    name: 'Rita Gomez',
    phone: '0491 572 983',
    properties: [wa('oddPostcode', '33 King Street', 'Bayswater', '6O53')],
  },
  // The same suburb in three cases: three entries in the suburb filter, one
  // weather lookup.
  {
    key: 'bill',
    kind: 'person',
    name: 'Bill Harding',
    properties: [wa('bayswaterLower', '5 Railway Parade', 'bayswater', '6053')],
  },
  {
    key: 'amy',
    kind: 'person',
    name: 'Amy Lo',
    phone: '0491 573 770',
    properties: [
      wa('bayswaterUpper', '77 Whatley Crescent', 'BAYSWATER', '6053'),
    ],
  },
  // An apostrophe in the suburb and the name.
  {
    key: 'liam',
    kind: 'person',
    name: "Liam O'Connor",
    phone: '0491 573 087',
    properties: [wa('oconnorHouse', '3 Clontarf Road', "O'Connor", '6163')],
  },
  // A 70+ character name and a very long address, for truncation.
  {
    key: 'obrien',
    kind: 'business',
    name: "O'Brien & Sons Plumbing Pty Ltd — Commercial & Residential Maintenance Division (WA)",
    phone: '(08) 5550 7788',
    properties: [
      wa(
        'longAddress',
        'Unit 14/127-131 Great Eastern Highway (rear, access via laneway off Kooyong Rd)',
        'Rivervale',
        '6103',
      ),
    ],
  },
  // Accents: searching "nguyen" on the Clients page does not find her.
  {
    key: 'huong',
    kind: 'person',
    name: 'Nguyễn Thị Hương',
    phone: '0491 574 118',
    properties: [wa('huongHome', '22 Albany Highway', 'Victoria Park', '6100')],
  },
  // A name saved with a trailing space, which the app never trims.
  {
    key: 'terry',
    kind: 'person',
    name: 'Terry Lamb ',
    phone: '0491 574 632',
    properties: [wa('terryHome', '9 Coode Street', 'South Perth', '6151')],
  },
  // Two different people with the same name.
  {
    key: 'davidMidland',
    kind: 'person',
    name: 'David Smith',
    phone: '0491 575 254',
    properties: [wa('smithMidland', '14 Morrison Road', 'Midland', '6056')],
  },
  {
    key: 'davidArmadale',
    kind: 'person',
    name: 'David Smith',
    phone: '0491 575 789',
    email: 'dsmith.armadale@example.com',
    properties: [wa('smithArmadale', '3 Church Avenue', 'Armadale', '6112')],
  },
  // A tenant at the same street address as one of Ridgeline's sites.
  {
    key: 'hana',
    kind: 'person',
    name: 'Hana Yamamoto',
    phone: '0491 576 398',
    properties: [wa('hanaMidland', '5 Wandoo Street', 'Midland', '6056')],
  },
  // The same suburb name in another state.
  {
    key: 'nina',
    kind: 'person',
    name: 'Nina Petrakis',
    phone: '0491 576 801',
    properties: [
      {
        key: 'bayswaterVic',
        addressLine: '8 Mountain Highway',
        suburb: 'Bayswater',
        state: 'VIC',
        postcode: '3153',
      },
    ],
  },
  // Archived: gone from the Clients page, but its property is still in the
  // job pickers and its future job still on the schedule. Far from Perth.
  {
    key: 'colin',
    kind: 'person',
    name: 'Colin Fraser',
    phone: '0491 577 426',
    archived: true,
    properties: [wa('colinHome', '19 Egan Street', 'Kalgoorlie', '6430')],
  },
]

// ──────────────────────────────────────────────────────────── named jobs

/**
 * The one-off jobs later steps attach reports and notes to, by key. The jobs
 * step creates each exactly as specified (and many more besides); the
 * reports and notes steps look them up in the manifest by `key`.
 * `day` is days from the seed's today; negative is history.
 */
export type NamedJobSpec = {
  key: string
  propertyKey: string
  assignee: Exclude<MemberKey, 'former'>
  day: number
  hh: number
  mm: number
  durationMinutes: number
  jobType: string
  priceCents: number
  status: Exclude<JobStatus, 'recurring'>
  /** The legacy state the retired inProgress migration left: a booked job
   * with a start time. */
  startedMinutesAfter?: number
}

export const NAMED_JOBS: Array<NamedJobSpec> = [
  // Today, not started, booked for 5:30pm at a client with an email: the
  // service report draft started from it suggests its start time (and the
  // weather, once looked up) — suggestions that must be confirmed.
  {
    key: 'todayUnstarted1730',
    propertyKey: 'jennyHome',
    assignee: 'owner',
    day: 0,
    hh: 17,
    mm: 30,
    durationMinutes: 45,
    jobType: 'Rodents',
    priceCents: 18000,
    status: 'pending',
  },
  // Six weeks ago at Marcus's, finished and reported; and again in two days,
  // where the new draft offers to copy the last visit's answers.
  {
    key: 'lastVisitPrev',
    propertyKey: 'marcusHome',
    assignee: 'owner',
    day: -42,
    hh: 9,
    mm: 0,
    durationMinutes: 60,
    jobType: 'General Pest Control',
    priceCents: 22000,
    status: 'invoiced',
  },
  {
    key: 'lastVisitNext',
    propertyKey: 'marcusHome',
    assignee: 'owner',
    day: 2,
    hh: 10,
    mm: 0,
    durationMinutes: 60,
    jobType: 'General Pest Control',
    priceCents: 22000,
    status: 'booked',
  },
  // Timber pest inspections: one with everything flagged (owner), one clean
  // (contractor).
  {
    key: 'termiteInspectionFlagged',
    propertyKey: 'katyaHome',
    assignee: 'owner',
    day: -10,
    hh: 8,
    mm: 0,
    durationMinutes: 90,
    jobType: 'Termite Inspection',
    priceCents: 38000,
    status: 'completed',
  },
  {
    key: 'termiteInspectionClean',
    propertyKey: 'sofiaHome',
    assignee: 'contractor',
    day: -20,
    hh: 13,
    mm: 0,
    durationMinutes: 90,
    jobType: 'Termite Inspection',
    priceCents: 38000,
    status: 'invoiced',
  },
  // A termite barrier with a certificate, later corrected (amended).
  {
    key: 'termiteTreatment',
    propertyKey: 'arthurHome',
    assignee: 'owner',
    day: -25,
    hh: 7,
    mm: 30,
    durationMinutes: 240,
    jobType: 'Termite Treatment',
    priceCents: 485000,
    status: 'invoiced',
  },
  // The custom "Rodent Bait Station Check" form, finalised by the contractor.
  {
    key: 'baitStationCheck',
    propertyKey: 'kewdaleWarehouse',
    assignee: 'contractor',
    day: -5,
    hh: 11,
    mm: 0,
    durationMinutes: 30,
    jobType: 'Rodents',
    priceCents: 16500,
    status: 'completed',
  },
  // Stopped as unsafe: a service report with safeToStart false.
  {
    key: 'unsafeStop',
    propertyKey: 'dayoHome',
    assignee: 'dana',
    day: -12,
    hh: 15,
    mm: 0,
    durationMinutes: 30,
    jobType: 'Wasps',
    priceCents: 17000,
    status: 'completed',
  },
  // The subcontractor's: a draft left untouched for six days (the stale-draft
  // banner); a timber inspection tomorrow (a draft they cannot finalise: no
  // licence on file); and a finished job whose report asks to email someone
  // not on file (held for the owner's approval).
  {
    key: 'subStaleDraft',
    propertyKey: 'ppm3',
    assignee: 'sub',
    day: -6,
    hh: 9,
    mm: 30,
    durationMinutes: 45,
    jobType: 'Cockroaches',
    priceCents: 19000,
    status: 'booked',
  },
  {
    key: 'subTimberTomorrow',
    propertyKey: 'ppm4',
    assignee: 'sub',
    day: 1,
    hh: 8,
    mm: 0,
    durationMinutes: 90,
    jobType: 'Termite Inspection',
    priceCents: 38000,
    status: 'pending',
  },
  {
    key: 'subAntsDone',
    propertyKey: 'ppm5',
    assignee: 'sub',
    day: -4,
    hh: 13,
    mm: 0,
    durationMinutes: 45,
    jobType: 'Ants',
    priceCents: 16000,
    status: 'completed',
  },
  // Three photos on the job itself.
  {
    key: 'photoJob',
    propertyKey: 'ridgeOsborne1',
    assignee: 'contractor',
    day: -3,
    hh: 10,
    mm: 0,
    durationMinutes: 120,
    jobType: 'Bird Proofing',
    priceCents: 64000,
    status: 'completed',
  },
  // Cancelled today: hidden on the Schedule, listed under Cancelled on the
  // Job tab. Notes can still hang off it.
  {
    key: 'cancelledToday',
    propertyKey: 'smithArmadale',
    assignee: 'sub',
    day: 0,
    hh: 16,
    mm: 30,
    durationMinutes: 30,
    jobType: 'Spiders',
    priceCents: 15000,
    status: 'cancelled',
  },
  // Far ahead.
  {
    key: 'sixWeeksAhead',
    propertyKey: 'coastScarborough',
    assignee: 'owner',
    day: 42,
    hh: 9,
    mm: 0,
    durationMinutes: 120,
    jobType: 'Pre-Purchase Inspection',
    priceCents: 42000,
    status: 'pending',
  },
  // Interstate, tomorrow.
  {
    key: 'fannieBayTomorrow',
    propertyKey: 'fannieBay',
    assignee: 'owner',
    day: 1,
    hh: 9,
    mm: 0,
    durationMinutes: 60,
    jobType: 'General Pest Control',
    priceCents: 26000,
    status: 'booked',
  },
  // The archived client: a finished job, and one still booked ahead.
  {
    key: 'colinPast',
    propertyKey: 'colinHome',
    assignee: 'contractor',
    day: -60,
    hh: 10,
    mm: 0,
    durationMinutes: 60,
    jobType: 'General Pest Control',
    priceCents: 29000,
    status: 'invoiced',
  },
  {
    key: 'colinFuture',
    propertyKey: 'colinHome',
    assignee: 'contractor',
    day: 9,
    hh: 10,
    mm: 0,
    durationMinutes: 60,
    jobType: 'General Pest Control',
    priceCents: 29000,
    status: 'booked',
  },
  // Legacy: booked, with the start time the retired inProgress status left.
  {
    key: 'legacyStarted',
    propertyKey: 'harbourCafe',
    assignee: 'dana',
    day: -1,
    hh: 6,
    mm: 30,
    durationMinutes: 60,
    jobType: 'Cockroaches',
    priceCents: 21000,
    status: 'booked',
    startedMinutesAfter: 10,
  },
]

/** The series-visit keys the jobs step also puts in the manifest. */
export const NAMED_VISITS = {
  /** A projected visit due today at 2pm: "Call/Text/Email to book". */
  dueToday: 'series.dueToday',
  /** A projected visit a week overdue, carried onto today. */
  overdueWeek: 'series.overdueWeek',
} as const
