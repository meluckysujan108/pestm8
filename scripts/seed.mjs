/**
 * Seeds the running dev deployment with a realistic, *busy* business so the
 * app can be looked at rather than reasoned about — a few weeks of history,
 * a full team, every report status, a custom template, photos, a signature.
 *
 * PestM8 only has two roles (`owner`, `subcontractor` — see `convex/schema.ts`'s
 * `role` union): there is no "manager" role to seed. The closest real-world
 * equivalent this data models is a senior technician with `canViewAllJobs`
 * set, which is exactly what Kevin gets below.
 *
 * Not part of the build — run it by hand:
 *
 *   npm run dev            (in one terminal)
 *   npx convex dev         (in another)
 *   node scripts/seed.mjs  (in a third)
 *
 * Creates real accounts through the actual sign-up endpoint (there is no
 * other way to get a membership — every table is gated on requireMembership),
 * so this only works against a dev deployment. Safe to run more than once:
 * each run's accounts are unique.
 *
 * Deliberately cannot seed: a "Sent" report (needs a real Resend send —
 * `RESEND_API_KEY` isn't set in dev) or an "invoiced" job (no mutation
 * exists yet; Xero/invoicing is unbuilt, per `e2e/access-control.spec.ts`'s
 * own `test.fixme` notes).
 */
process.loadEnvFile('.env.local')

const SITE = process.env.VITE_SITE_URL ?? 'http://localhost:3000'
const CONVEX_URL = process.env.VITE_CONVEX_URL
if (!CONVEX_URL) {
  console.error('VITE_CONVEX_URL is not set — is `npx convex dev` running?')
  process.exit(1)
}

const { ConvexHttpClient } = await import('convex/browser')
const { api } = await import('../convex/_generated/api.js')

const PASSWORD = 'pestm8-demo-2026'
const stamp = Date.now()

/** Smallest valid PNG — same fixture `e2e/gallery.spec.ts`/`e2e/photos.spec.ts`
 * already use, so a "photo" is a real uploaded, compressed image, not a stub. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function signUp(email, name) {
  const res = await fetch(`${SITE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  })
  if (!res.ok) {
    throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`)
  }

  // Sign-up sets the Better Auth session cookie; the Convex JWT is minted from
  // it separately (see src/routes/api/auth/$.ts for why only one survives).
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  if (!cookie) throw new Error(`no session cookie for ${email}`)

  const tokenRes = await fetch(`${SITE}/api/auth/convex/token`, {
    headers: { cookie, origin: SITE },
  })
  if (!tokenRes.ok) {
    throw new Error(`convex/token failed for ${email}: ${tokenRes.status}`)
  }
  const { token } = await tokenRes.json()
  if (!token) throw new Error(`convex/token returned no token for ${email}`)

  const client = new ConvexHttpClient(CONVEX_URL)
  client.setAuth(token)
  return client
}

async function uploadPng(client, businessId, reportId) {
  const uploadUrl = await client.mutation(api.reports.generateUploadUrl, { businessId })
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG,
  })
  const { storageId } = await res.json()
  return storageId
}

console.log('Signing up demo accounts…')
const ownerEmail = `terence+${stamp}@pestm8.demo`
const kevinEmail = `kevin+${stamp}@pestm8.demo`
const priyaEmail = `priya+${stamp}@pestm8.demo`
const owner = await signUp(ownerEmail, 'Terence')
const kevin = await signUp(kevinEmail, 'Kevin')
const priya = await signUp(priyaEmail, 'Priya')

console.log('Creating business…')
const { businessId, slug } = await owner.mutation(api.businesses.create, {
  name: 'Bayside Pest Control',
  state: 'WA',
  timezone: 'Australia/Perth',
  abn: '54 123 456 789',
})

console.log('Setting up branding…')
const logoUploadUrl = await owner.mutation(api.businesses.generateUploadUrl, { businessId })
const logoRes = await fetch(logoUploadUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'image/png' },
  body: PNG,
})
const { storageId: logoStorageId } = await logoRes.json()
await owner.mutation(api.businesses.update, {
  businessId,
  logoStorageId,
  addressLine: '15 Guildford Road',
  suburb: 'Maylands',
  postcode: '6051',
  phone: '(08) 9271 4400',
  email: 'office@baysidepest.example',
  licenceNumber: 'PMT-4471',
})

console.log('Inviting the team…')
await owner.mutation(api.memberships.inviteByEmail, { businessId, email: kevinEmail, role: 'subcontractor' })
await owner.mutation(api.memberships.inviteByEmail, { businessId, email: priyaEmail, role: 'subcontractor' })
await kevin.mutation(api.memberships.claimInvitations, {})
await priya.mutation(api.memberships.claimInvitations, {})

const members = await owner.query(api.memberships.listForBusiness, { businessId })
const ownerMembershipId = members.find((m) => m.role === 'owner')._id
const kevinMembership = members.find((m) => m.email === kevinEmail)
const priyaMembership = members.find((m) => m.email === priyaEmail)

// Kevin is the senior tech — sees the whole schedule, the closest thing to a
// "manager" this app's two-role model has. Priya stays scoped to her own day,
// the more common subcontractor case.
await owner.mutation(api.memberships.setCanViewAllJobs, {
  businessId,
  membershipId: kevinMembership._id,
  canViewAllJobs: true,
})
await owner.mutation(api.memberships.setLicence, {
  businessId,
  membershipId: kevinMembership._id,
  licenceNumber: 'TECH-8821',
})
await owner.mutation(api.memberships.setLicence, {
  businessId,
  membershipId: priyaMembership._id,
  licenceNumber: 'TECH-9034',
})

console.log('Adding properties…')
const propertyDefs = [
  { clientName: 'J. Nguyen', addressLine: '12 Wattle Street', suburb: 'Bayswater', postcode: '6053', phone: '0412 345 678', email: 'j.nguyen@example.com' },
  { clientName: 'M. Roberts', addressLine: '4 Kalinda Way', suburb: 'Morley', postcode: '6062', phone: '0423 456 789' },
  { clientName: 'S. Chen', addressLine: '88 Beaufort Street', suburb: 'Mount Lawley', postcode: '6050', phone: '0434 567 890', email: 's.chen@example.com' },
  { clientName: 'A. Wilson', addressLine: '21 Guildford Road', suburb: 'Maylands', postcode: '6051' },
  { clientName: 'D. Okafor', addressLine: '7 Hakea Court', suburb: 'Ballajura', postcode: '6066', phone: '0401 222 333' },
  { clientName: 'R. Singh', addressLine: '2 Karri Loop', suburb: 'Kelmscott', postcode: '6111', phone: '0402 333 444', email: 'r.singh@example.com' },
  { clientName: 'B. Tan', addressLine: '3 Marri Way', suburb: 'Forrestfield', postcode: '6058' },
  { clientName: 'L. Fitzgerald', addressLine: '9 Jarrah Street', suburb: 'Armadale', postcode: '6112', phone: '0403 444 555' },
  { clientName: 'K. Petrov', addressLine: '18 Banksia Road', suburb: 'Ellenbrook', postcode: '6069', email: 'k.petrov@example.com' },
  { clientName: 'H. Yamamoto', addressLine: '5 Wandoo Street', suburb: 'Midland', postcode: '6056', phone: '0404 555 666' },
]
const properties = await Promise.all(
  propertyDefs.map((p) => owner.mutation(api.properties.create, { businessId, ...p, state: 'WA' })),
)
const [nguyen, roberts, chen, wilson, okafor, singh, tan, fitzgerald, petrov, yamamoto] = properties

console.log('Booking three weeks of jobs…')
const DAY = 86_400_000
const today = new Date()
today.setHours(0, 0, 0, 0)
const at = (dayOffset, hour, minute = 0) =>
  today.getTime() + dayOffset * DAY + hour * 3_600_000 + minute * 60_000

const techs = [ownerMembershipId, kevinMembership._id, priyaMembership._id]
// `day` ranges negative (history) through positive (future); plain `%` in JS
// keeps the dividend's sign, so a negative `i` needs wrapping back positive.
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length]

const jobTypes = [
  ['Termite Inspection', 38000, 90],
  ['General Pest Control', 22000, 60],
  ['Rodents', 18000, 45],
  ['Ants', 16000, 45],
  ['Spiders', 15000, 30],
  ['Cockroaches', 19000, 45],
  ['Termite Treatment', 65000, 120],
  ['Wasps', 17000, 30],
  ['EOL Flea Treatment', 24000, 60],
  ['Rodent Bait Top-Up', 12000, 30],
]

const jobs = []

// Two weeks of history — completed, so the dashboard's "awaiting invoice"
// figure and the calendar's past weeks both have real content.
for (let day = -14; day < 0; day++) {
  const date = new Date(today.getTime() + day * DAY)
  if (date.getDay() === 0) continue // no Sunday work
  const bookingsToday = date.getDay() === 6 ? 1 : 2
  for (let n = 0; n < bookingsToday; n++) {
    const [jobType, price, durationMinutes] = pick(jobTypes, day + n)
    jobs.push({
      propertyId: pick(properties, day + n),
      assignedMembershipId: pick(techs, day + n),
      jobType,
      price,
      scheduledAt: at(day, 8 + n * 3, 0),
      durationMinutes,
      complete: true,
    })
  }
}

// Today — a real mix across all three people.
jobs.push(
  { propertyId: nguyen, assignedMembershipId: ownerMembershipId, jobType: 'Termite Inspection', price: 38000, scheduledAt: at(0, 8, 30), durationMinutes: 90, complete: true },
  { propertyId: roberts, assignedMembershipId: kevinMembership._id, jobType: 'General Pest Control', price: 22000, scheduledAt: at(0, 10, 0), durationMinutes: 60 },
  { propertyId: singh, assignedMembershipId: priyaMembership._id, jobType: 'Cockroaches', price: 19000, scheduledAt: at(0, 13, 0), durationMinutes: 45 },
  { propertyId: tan, assignedMembershipId: kevinMembership._id, jobType: 'Ants', price: 16000, scheduledAt: at(0, 15, 30), durationMinutes: 45 },
)

// One cancelled job today, so that status renders somewhere real.
const cancelledDraft = {
  propertyId: fitzgerald,
  assignedMembershipId: priyaMembership._id,
  jobType: 'Spiders',
  price: 15000,
  scheduledAt: at(0, 16, 30),
  durationMinutes: 30,
  cancel: true,
}
jobs.push(cancelledDraft)

// The rest of this week and all of next week, still booked.
for (let day = 1; day <= 10; day++) {
  const date = new Date(today.getTime() + day * DAY)
  if (date.getDay() === 0) continue
  const [jobType, price, durationMinutes] = pick(jobTypes, day + 3)
  jobs.push({
    propertyId: pick(properties, day + 5),
    assignedMembershipId: pick(techs, day + 1),
    jobType,
    price,
    scheduledAt: at(day, 9 + (day % 3) * 2, 0),
    durationMinutes,
  })
}

for (const { complete, cancel, ...job } of jobs) {
  const jobId = await owner.mutation(api.jobs.create, { businessId, ...job })
  if (complete) await owner.mutation(api.jobs.complete, { businessId, jobId })
  if (cancel) await owner.mutation(api.jobs.cancel, { businessId, jobId })
}

console.log('Setting up recurring services…')
await owner.mutation(api.recurrences.create, {
  businessId,
  propertyId: nguyen,
  assignedMembershipId: ownerMembershipId,
  frequency: 'quarterly',
  jobType: 'General Pest Control',
  price: 22000,
  anchorDate: at(15, 9, 0),
  durationMinutes: 60,
})
await owner.mutation(api.recurrences.create, {
  businessId,
  propertyId: okafor,
  assignedMembershipId: kevinMembership._id,
  frequency: 'monthly',
  jobType: 'Rodent Bait Top-Up',
  price: 12000,
  anchorDate: at(20, 10, 0),
  durationMinutes: 30,
})

console.log('Writing reports — drafts…')
await owner.mutation(api.reports.create, {
  businessId,
  propertyId: roberts,
  template: 'treatmentRecord',
  legalBasis: 'APVMA',
  data: { product: 'Termidor HE', targetPest: 'Ants' },
})
await kevin.mutation(api.reports.create, {
  businessId,
  propertyId: singh,
  template: 'timberPestInspection',
  legalBasis: 'AS 4349.3-2010',
  data: {},
})
await priya.mutation(api.reports.create, {
  businessId,
  propertyId: fitzgerald,
  template: 'serviceReport',
  legalBasis: 'APVMA · AEPMA',
  data: { serviceDate: new Date().toISOString().slice(0, 10) },
})

console.log('Writing reports — finalised…')
// A termite management certificate — exercises PDF export.
const certId = await owner.mutation(api.reports.create, {
  businessId,
  propertyId: nguyen,
  template: 'termiteManagementCert',
  legalBasis: 'AS 3660.2-2017',
  data: {},
})
await owner.mutation(api.reports.finalise, {
  businessId,
  reportId: certId,
  data: {
    systemType: 'chemical',
    product: 'Termidor HE',
    apvmaNumber: '62873',
    batchNumber: 'TH-2026-118',
    lifeExpectancy: '8 years',
    installDate: new Date().toLocaleDateString('en-AU'),
    reinspectionInterval: '12',
    treatedZones: 'Full external perimeter, all penetrations and cold joints.',
  },
})

// A finalised service report with a technician signature and gallery
// photos — the closest thing to "what a client actually receives".
const serviceId = await kevin.mutation(api.reports.create, {
  businessId,
  propertyId: chen,
  template: 'serviceReport',
  legalBasis: 'APVMA · AEPMA',
  data: {},
})
const coverStorageId = await uploadPng(kevin, businessId, serviceId)
await kevin.mutation(api.reports.addGalleryPhoto, {
  businessId,
  reportId: serviceId,
  fieldKey: 'coverPhoto',
  storageId: coverStorageId,
})
const [coverPhoto] = await kevin.query(api.reports.galleryPhotos, { businessId, reportId: serviceId })
await kevin.mutation(api.reports.setGalleryCover, { businessId, reportId: serviceId, photoId: coverPhoto._id })
const sigStorageId = await uploadPng(kevin, businessId, serviceId)
await kevin.mutation(api.reports.attachSignature, {
  businessId,
  reportId: serviceId,
  storageId: sigStorageId,
  slot: 'technician',
})
await kevin.mutation(api.reports.finalise, {
  businessId,
  reportId: serviceId,
  data: {
    serviceDate: new Date().toISOString().slice(0, 10),
    treatments: [{ _id: 'row-1', treatment: ['General Pest Control'], product: ['Biflex Ultra (100 g/L Bifenthrin)'], method: ['Vehicle mounted sprayer'] }],
    safeToStart: true,
    technicianSignature: { signedAt: Date.now() },
  },
})

// A plain treatment record, finalised — the simplest built-in template, so
// the reports list has more than certificates and service reports in it.
const treatmentId = await owner.mutation(api.reports.create, {
  businessId,
  propertyId: wilson,
  template: 'treatmentRecord',
  legalBasis: 'APVMA',
  data: {},
})
await owner.mutation(api.reports.finalise, {
  businessId,
  reportId: treatmentId,
  data: { product: 'Biflex Ultra', targetPest: 'Spiders', areasTreated: 'External perimeter' },
})

console.log('Authoring a custom template…')
const customTemplateId = await owner.mutation(api.customTemplates.create, {
  businessId,
  name: 'Six-Monthly Termite Check',
  shortName: 'Termite Check',
  legalBasis: 'Internal',
  blurb: 'A lightweight recurring check between full AS 4349.3 inspections.',
  boilerplate:
    'This is a visual check only, not a full timber pest inspection under AS 4349.3-2010. A full inspection is still required at the interval stated on your termite management certificate.',
  sections: [
    {
      number: 1,
      title: 'Check',
      preamble: 'Quick visual check of the property perimeter and any visible termite management system.',
      fields: [
        { kind: 'toggle', key: 'activitySeen', label: 'Any termite activity seen?', required: true },
        {
          kind: 'area',
          key: 'activityDetail',
          label: 'Describe what was seen',
          rows: 3,
          visibleWhen: { when: 'activitySeen', eq: true },
        },
        {
          kind: 'areas',
          key: 'areas',
          label: 'Areas checked',
          rows: ['Sub floor', 'Perimeter', 'Meter box', 'Garden beds against slab'],
        },
        {
          kind: 'select',
          key: 'nextCheck',
          label: 'Next check due in',
          options: [
            { value: '6 months', label: '6 months' },
            { value: '12 months', label: '12 months' },
          ],
        },
        { kind: 'signature', key: 'technicianSignature', label: 'Technician signature', slot: 'technician', role: 'technician' },
      ],
    },
  ],
})

const customDraftId = await priya.mutation(api.reports.create, {
  businessId,
  propertyId: petrov,
  template: 'custom',
  customTemplateId,
  legalBasis: 'Internal',
  data: {},
})

const customFinalId = await owner.mutation(api.reports.create, {
  businessId,
  propertyId: yamamoto,
  template: 'custom',
  customTemplateId,
  legalBasis: 'Internal',
  data: {},
})
await owner.mutation(api.reports.finalise, {
  businessId,
  reportId: customFinalId,
  data: {
    activitySeen: false,
    areas: {
      'Sub floor': { status: 'inspected' },
      Perimeter: { status: 'inspected' },
      'Meter box': { status: 'inspected' },
      'Garden beds against slab': { status: 'noAccess', reason: 'Locked side gate — client to provide access next visit' },
    },
    nextCheck: '6 months',
  },
})

console.log('Adding notes…')
await owner.mutation(api.notes.create, {
  businessId,
  propertyId: chen,
  title: 'Gate code 4821. Dog is friendly but will bark — knock first.',
})
await kevin.mutation(api.notes.create, {
  businessId,
  propertyId: okafor,
  title: 'Client asked to switch to a low-odour product for the next visit — she works from home.',
})
await owner.mutation(api.notes.create, {
  businessId,
  title: 'Reminder: renew the vehicle chemical transport permit before end of quarter.',
})

console.log(`
Done. Sign in at ${SITE}/login with:

  Owner (full access)              ${ownerEmail}
  Subcontractor (senior/whole-schedule)  ${kevinEmail}
  Subcontractor (own jobs only)    ${priyaEmail}
  Password                         ${PASSWORD}

Business: Bayside Pest Control → /${slug}/schedule

Seeded: ${properties.length} properties, ~${jobs.length} jobs across 3 weeks
(past completed, today, upcoming, one cancelled), 2 recurring services,
3 draft + 3 finalised reports across every built-in template, 1 custom
template ("Six-Monthly Termite Check") with a draft and a finalised report,
a gallery photo + cover flag + technician signature on one finalised report,
business branding (logo/address/phone/email/licence), and 3 notes.

Not seedable: a "Sent" report (needs RESEND_API_KEY) or an "invoiced" job
(no mutation exists yet — invoicing/Xero isn't built).
`)
