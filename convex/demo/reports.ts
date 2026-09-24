import { ConvexError, v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { writeEnvelopeForMember } from '../lib/actor'
import { forSelf, recordAudit, recordOnce } from '../lib/audit'
import { dayKeyOf, timeKeyOf } from '../lib/dates'
import { loadOverrides } from '../lib/optionSets'
import {
  OWNER_EDIT_WINDOW_MS,
  amendReport,
  finaliseReport,
  insertNewDraft,
  templateRefOf,
} from '../reports'
import { settingsFor } from '../templateSettings'
import { fieldsOf, getTemplate } from '../../src/lib/reportTemplates'
import { resolveReportTemplate } from '../../src/lib/reportTemplates/resolve'
import { submittablePayload } from '../../src/lib/reportTemplates/validate'
import { PRODUCT_CHANGES } from './templates'
import { at, demoBaseV, manifestJobV, propertyMapV } from './shared'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { WriteEnvelope } from '../lib/actor'
import type { ReportTemplate, TemplateId } from '../../src/lib/reportTemplates'
import type { DemoBase, ManifestJob, MemberKey } from './shared'

/**
 * The demo's reports: service reports, timber inspections, a termite
 * certificate corrected twice, and the business's own forms, in every state
 * the library shows — drafts fresh and stale, one in the bin, finalised ones
 * with their deliveries queued, held and refused.
 *
 * Each goes through the app's own path. A draft is started by
 * `insertNewDraft` (reports.create's body), so it is seeded from its job
 * exactly as a technician's would be: the day, the booked time, who is on
 * it, whether the client has an email. Answers then arrive as saveDraft
 * writes them, suggestions are confirmed as confirmPrefill confirms them,
 * signatures and photos land as attachSignature and addGalleryPhoto leave
 * them, and the report is locked by `finaliseReport` — finalise's own body —
 * which numbers it, freezes its wording and records, audits it and queues
 * what the form asked to send. Corrections go through `amendReport`.
 *
 * Every event is dated when a person would have done it, relative to the
 * job it belongs to, and the whole history is played back in that order, so
 * report numbers are handed out in the order the reports were locked. What
 * those helpers stamp with the wall clock (a draft's createdAt, the context
 * freeze, a delivery's createdAt) is moved back to the same moment.
 *
 * Nobody here is signed in: each write is made with the envelope of the
 * member the record says made it (`writeEnvelopeForMember`). The former
 * technician has none — a removed member cannot write — so they author
 * nothing, which is also what the team step's record of their departure
 * says (no drafts to hand over).
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

type Worker = Exclude<MemberKey, 'former'>
const WORKERS: ReadonlyArray<Worker> = ['owner', 'contractor', 'sub', 'dana']

type Answers = Record<string, unknown>
type Fill = Answers | ((data: Answers) => Answers)

/** A photo from the seed's stored set, by index into `base.images.photos`
 * (0, 1, 3, 5 and 6 are landscape; 2, 4 and 7 portrait). */
type Shot = {
  photo: number
  caption?: string
  /** Made the gallery's cover (setGalleryCover). */
  cover?: boolean
  /** Uploaded as it came, without the browser measuring it: no size. */
  unsized?: boolean
}

/** Who holds the pen: a technician on their own pad, or whoever is standing
 * there on the client's (their typed name, or the client's when null). */
type Signer = { technician: Worker } | { client: string | null }

// ──────────────────────────────────────────────────────────── the forms

/** One row of the Service Report's treatment grid, every column answered. */
type Treatment = {
  treatment: Array<string>
  product: Array<string>
  quantity: Array<string>
  method: Array<string>
}

/** The Biflex name the owner's product list has used since the rename. */
const BIFLEX = PRODUCT_CHANGES.rename.to

/** What each kind of job applies, in the Service Report's own words. The
 * rodent visit uses a second-generation bait, so its report carries the
 * 35-day follow-up the label now requires. */
const TREATMENTS: Record<string, Array<Treatment>> = {
  'General Pest Control': [
    {
      treatment: ['General Pest Control'],
      product: [BIFLEX],
      quantity: ['100ml/10L'],
      method: ['Hand Held Battery Operated Sprayer'],
    },
    {
      treatment: ['Cockroach Treatment'],
      product: ['Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)'],
      quantity: ['1-5 grams'],
      method: ['Gels applied with Gel Gun'],
    },
  ],
  Rodents: [
    {
      treatment: ['Rodents'],
      product: ['Ditrac All Weather Blox (0.05 g/kg Bromadiolone)'],
      quantity: ['Bait Blocks'],
      method: [
        'Bait Applied in Bait Stations',
        'SGARS in compliance with the new 35 day ruling',
      ],
    },
  ],
  Ants: [
    {
      treatment: ['Ant Full Block Spray'],
      product: ['Seclira WSG (400 g/kg DINOTEFURAN)'],
      quantity: ['20g/5 Litres'],
      method: ['Hand Compression Sprayer'],
    },
  ],
  Cockroaches: [
    {
      treatment: ['Cockroach Treatment'],
      product: [
        'Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)',
        'Sumilarv IGR (20 g/L PYRIPROXYFEN)',
      ],
      quantity: ['1-5 grams', '20ml/2L'],
      method: [
        'Gels applied with Gel Gun',
        'Hand Held Battery Operated Sprayer',
      ],
    },
  ],
  Spiders: [
    {
      treatment: ['Spider Spray External'],
      product: [BIFLEX],
      quantity: ['60ml/10L'],
      method: ['Vehicle Mounted Sprayer'],
    },
  ],
  Wasps: [
    {
      treatment: ['Wasps'],
      product: ['Stardust Pro (20 g/kg Permethrin 40:60 5 g/kg Triflumuron)'],
      quantity: ['1-5 grams'],
      method: ['Dusting'],
    },
  ],
}

/** The job types a Service Report is written for (suggest.ts). */
const SERVICE_JOB_TYPES = new Set(Object.keys(TREATMENTS))

const SERVICE_NOTES: Record<string, string> = {
  'General Pest Control':
    'Full internal and external treatment. Webs brushed down from the eaves, pergola and letterbox before spraying; gel placed in the kitchen cupboard hinges.',
  Rodents:
    'Rat droppings along the top plates in the roof void. Four lockable stations placed: roof void ×3, garage ×1. Keep pets away from the garage station; we check them again within 35 days.',
  Ants: 'Coastal brown ant trails along the laundry and kitchen skirting. Non-repellent spray to the perimeter and garden beds; please avoid mopping the skirting boards for two weeks.',
  Cockroaches:
    'German cockroaches behind the dishwasher and in the pantry hinges. Gel and growth regulator applied; expect to see some for 7–10 days while it works.',
  Spiders:
    'Redback activity under the outdoor furniture and in the meter box. External spray to window frames, eaves, carport and fence line.',
  Wasps:
    'Two paper wasp nests under the rear eaves, dusted and removed. Area checked for new nests along the pergola.',
}

const NEXT_VISIT: Record<string, string> = {
  'General Pest Control': '6 Months',
  Rodents: '35 Days',
  Ants: '3 Months',
  Cockroaches: '1 Month',
  Spiders: '6 Months',
  Wasps: '12 Months',
}

const RISK_SETS: Array<{ risks: Array<string>; riskActions: Array<string> }> = [
  { risks: ['No Risk Safe Access Given'], riskActions: ['Safe access given'] },
  {
    risks: ['People/Children', 'Animals / Birds / Fish'],
    riskActions: [
      'Informed people/children to vacate the area or stay indoors',
      'Client Took Pets off Property',
    ],
  },
  { risks: ['No Risk Property Empty'], riskActions: ['Safe access given'] },
  {
    risks: ['Animals / Birds / Fish', 'Pool'],
    riskActions: ['Client Kept Pets Inside'],
  },
]

const HOUSEKEEPING_SETS: Array<Array<string>> = [
  ['Regular Maintenance required to keep under control'],
  ['Eliminate food sources in kitchen for cockroaches and ants', 'Clean bins'],
  ['Rubbish Removal'],
  [],
]

const WEATHER_SETS: Array<Array<string>> = [
  ['Sunny'],
  ['Overcast'],
  ['Sunny', 'Windy'],
  ['Wet', 'Overcast'],
]

/** Where the phone said the technician stood: some readings carry an
 * altitude and some do not, as devices differ. */
const FIXES: Array<{
  lat: number
  lng: number
  altitude?: number
  accuracy: number
}> = [
  { lat: -31.9412, lng: 115.8934, altitude: 22.6, accuracy: 6 },
  { lat: -31.9019, lng: 115.8402, accuracy: 14 },
  { lat: -32.0077, lng: 115.8921, altitude: 11.4, accuracy: 9 },
  { lat: -31.8663, lng: 115.9712, accuracy: 31 },
]

/** The Service Report's six safety checks, answered Yes: the builder's
 * "All yes" tap on that heading. */
const SAFETY_CHECKS: Answers = {
  spillKit: true,
  msds: true,
  ppe: true,
  chemicalsSecured: true,
  firstAid: true,
  signage: true,
}

const TIMBER_WARRANTY =
  '12 Monthly Timber Pest Visual Inspection to maintain Warranty'

/** Everything §7 can flag, flagged: every whenFlagged note prints. */
const CONDUCIVE_FLAGGED: Answers = {
  waterLeaks: true,
  waterLeaksComments:
    'Leaking tap and split hose fitting against the rear wall; the soil there stays wet.',
  waterTanks: 'Yes',
  highMoistureReadings: true,
  highMoistureReadingsComments:
    'Elevated readings on the rear patio wall and the laundry skirting (see photos).',
  siteDrainage: 'Inadequate',
  siteDrainageComments:
    'The block falls to the rear; storm water ponds against the patio slab edge.',
  subfloorDrainage: 'Inadequate',
  subfloorDrainageComments:
    'Standing water under the timber-floored rear extension.',
  ventilation: 'Inadequate',
  ventilationComments:
    'Two subfloor vents blocked by garden beds on the western side.',
  mould: true,
  mouldComments:
    'Mould on the laundry ceiling and behind the wardrobe in bed 3.',
  externalExposedTimbers: 'Inadequate',
  externalExposedTimbersComments:
    'Pergola posts set directly in soil with no stirrups.',
  slabEdgeExposure: 'No',
  slabEdgeExposureComments:
    'Slab edge covered by paving and garden beds on three sides.',
  antCapping: 'Inadequate',
  antCappingComments:
    'Ant capping missing on two piers under the rear extension.',
  weepHoles: 'No',
  weepHolesComments: 'Weep holes on the western wall covered by garden soil.',
  otherConduciveConditions: true,
}

/** §7 at its all-clear answers: the builder's "All clear" tap, with the
 * N/A a slab-on-ground house gives the subfloor questions. */
const CONDUCIVE_CLEAR: Answers = {
  waterLeaks: false,
  waterTanks: 'No',
  highMoistureReadings: false,
  siteDrainage: 'Adequate',
  subfloorDrainage: 'N/A',
  ventilation: 'Adequate',
  mould: false,
  externalExposedTimbers: 'Adequate',
  slabEdgeExposure: 'Yes',
  antCapping: 'N/A',
  weepHoles: 'Yes',
  otherConduciveConditions: false,
}

// ──────────────────────────────────────────────────────────── the seed

export const seed = internalMutation({
  args: {
    base: demoBaseV,
    properties: propertyMapV,
    jobs: v.array(manifestJobV),
    customTemplates: v.record(v.string(), v.id('customReportTemplates')),
  },
  returns: v.object({ reports: v.record(v.string(), v.id('reports')) }),
  handler: async (ctx, { base, properties, jobs, customTemplates }) => {
    const now = Date.now()
    const when = (day: number, hh: number, mm = 0) => at(base, day, hh, mm)
    const book = jobBook(base, jobs)
    const story = storyteller(ctx, base, properties, now)
    const custom = (key: string): Id<'customReportTemplates'> => {
      const id = customTemplates[key] as Id<'customReportTemplates'> | undefined
      if (!id)
        throw new ConvexError(`DEMO_REPORTS: no custom template "${key}"`)
      return id
    }

    // ── The house with a history: finished six weeks ago, every section
    // answered, and back in two days (the new draft offers to copy it) ────
    {
      const job = book.named('lastVisitPrev')
      const t = job.scheduledAt
      story
        .draft('srLastVisit', {
          author: 'owner',
          template: 'serviceReport',
          job,
          at: t + 2 * MINUTE,
        })
        .photo(t + 4 * MINUTE, 'coverPhoto', { photo: 0 })
        .save(t + 28 * MINUTE, (data) => ({
          location: fix(0, t + 3 * MINUTE),
          finishTime: timeKeyOf(endOf(job), base.timezone),
          weather: ['Sunny', 'Windy'],
          treatments: treatmentRows(
            data,
            TREATMENTS['General Pest Control'],
            'srLastVisit',
          ),
          risks: ['People/Children', 'Pool'],
          riskActions: [
            'Informed people/children to vacate the area or stay indoors',
            'Client Kept Pets Inside',
          ],
          ...SAFETY_CHECKS,
          additionalRiskAction:
            'Pool cover kept on while the external perimeter was sprayed.',
          safeToStart: true,
          housekeeping: [
            'Eliminate food sources in kitchen for cockroaches and ants',
            'Clean bins',
          ],
          limitations:
            'Roof void dusted from the manhole only: insulation batts over the ceiling stop safe access past the first truss.',
          comments:
            'German cockroach activity in the kitchen, mainly behind the fridge and dishwasher. Gel applied to hinges and harbourage points, then a full internal and external general treatment. Expect to see some cockroaches for 7–10 days while the gel takes effect.',
          nextVisit: '3 Months',
          addPhotos: true,
        }))
        .photo(t + 31 * MINUTE, 'photos', {
          photo: 3,
          caption: 'Droppings behind the fridge',
        })
        .photo(t + 33 * MINUTE, 'photos', { photo: 2, cover: true })
        .photo(t + 36 * MINUTE, 'photos', { photo: 5, unsized: true })
        .sign(t + 55 * MINUTE, 'technicianSignature', { technician: 'owner' })
        .sign(t + 57 * MINUTE, 'clientSignature', { client: null })
        .confirm(t + 58 * MINUTE)
        .finalise(endOf(job) + 65 * MINUTE)

      story.draft('srCarryOver', {
        author: 'owner',
        template: 'serviceReport',
        job: book.named('lastVisitNext'),
        at: when(-1, 16, 20),
      })
    }

    // ── Stopped as unsafe: recorded, nothing applied ────────────────────
    {
      const job = book.named('unsafeStop')
      const t = job.scheduledAt
      story
        .draft('srUnsafe', {
          author: 'dana',
          template: 'serviceReport',
          job,
          at: t + 3 * MINUTE,
        })
        .save(t + 14 * MINUTE, {
          finishTime: timeKeyOf(t + 20 * MINUTE, base.timezone),
          weather: ['Windy'],
          // The row the job type suggested, deleted: nothing was applied.
          treatments: [],
          risks: ['People/Children', 'Animals / Birds / Fish'],
          riskActions: [
            'Informed people/children to vacate the area or stay indoors',
          ],
          ...SAFETY_CHECKS,
          safeToStart: false,
          comments:
            'Not safe to start. The European wasp nest is inside the wall cavity above the back door, about 5 m up, and the only ladder footing is over the neighbour’s side fence. Children were playing in the rear yard. Nothing applied; the client will keep the back door shut and we will rebook with a platform ladder and a second technician.',
          nextVisit: '1 Week',
        })
        .sign(t + 20 * MINUTE, 'technicianSignature', { technician: 'dana' })
        .confirm(t + 20 * MINUTE)
        .finalise(endOf(job) + 55 * MINUTE)
    }

    // ── The subcontractor's: a send nobody has on file (held for the
    // owner), and a second one the owner then refused ─────────────────────
    const subAnts = book.named('subAntsDone')
    {
      const job = subAnts
      const t = job.scheduledAt
      story
        .draft('srSubAnts', {
          author: 'sub',
          template: 'serviceReport',
          job,
          at: t + 2 * MINUTE,
        })
        .save(t + 35 * MINUTE, (data) => ({
          finishTime: timeKeyOf(endOf(job), base.timezone),
          weather: ['Sunny'],
          treatments: treatmentRows(data, TREATMENTS.Ants, 'srSubAnts'),
          risks: ['Obstructions on the Ground'],
          riskActions: ['Safe access given'],
          ...SAFETY_CHECKS,
          safeToStart: true,
          housekeeping: ['Rubbish Removal'],
          comments:
            'Ant trails along the common-area garden beds and into units 2 and 4 through the weep holes. Perimeter and garden beds treated. The site manager asked for a copy for the strata file.',
          nextVisit: '3 Months',
          emailReportTo: ['site.manager@example.net'],
        }))
        .sign(t + 40 * MINUTE, 'technicianSignature', { technician: 'sub' })
        .confirm(t + 40 * MINUTE)
        .finalise(endOf(job) + 70 * MINUTE)
    }
    {
      const job = book.warrantyCallBack(subAnts)
      const t = job.scheduledAt
      const finalisedAt = endOf(job) + 60 * MINUTE
      story
        .draft('srSubRejected', {
          author: 'sub',
          template: 'serviceReport',
          job,
          at: t + 3 * MINUTE,
        })
        .save(t + 22 * MINUTE, (data) => ({
          finishTime: timeKeyOf(endOf(job), base.timezone),
          weather: ['Overcast'],
          treatments: treatmentRows(
            data,
            [
              {
                treatment: ['Ant Spot Spray'],
                product: ['Advion Ant Gel (0.5 g/Kg Indoxacarb)'],
                quantity: ['1-5 grams'],
                method: ['Gels applied with Gel Gun'],
              },
            ],
            'srSubRejected',
          ),
          risks: ['No Risk Safe Access Given'],
          riskActions: ['Safe access given'],
          ...SAFETY_CHECKS,
          safeToStart: true,
          comments:
            'Warranty call-back: ants back along the driveway edge. Gel placed in the driveway expansion joints and around the bin store, no charge.',
          emailReportTo: ['strata.committee@example.org'],
        }))
        .sign(t + 26 * MINUTE, 'technicianSignature', { technician: 'sub' })
        .confirm(t + 26 * MINUTE)
        .finalise(finalisedAt)
        // First thing the next morning, from the approvals list.
        .reject(finalisedAt + 17 * HOUR)
    }

    // ── Bird proofing, with the job's own photos beside the report's ──────
    {
      const job = book.named('photoJob')
      const t = job.scheduledAt
      story
        .draft('srPhotoJob', {
          author: 'contractor',
          template: 'serviceReport',
          job,
          at: t + 5 * MINUTE,
        })
        .photo(t + 30 * MINUTE, 'photos', {
          photo: 6,
          caption: 'North parapet after the spikes went on',
        })
        .photo(t + 62 * MINUTE, 'photos', { photo: 7 })
        .photo(t + 95 * MINUTE, 'photos', { photo: 1, cover: true })
        .save(t + 100 * MINUTE, {
          location: fix(1, t + 6 * MINUTE),
          finishTime: timeKeyOf(endOf(job), base.timezone),
          weather: ['Overcast'],
          // Spikes and netting: nothing chemical to record.
          treatments: [],
          risks: ['Obstructions on the Ground'],
          riskActions: ['Safe access given'],
          ...SAFETY_CHECKS,
          additionalRiskAction:
            'Harness clipped to the roof anchor on the plant deck; loading dock coned off while working above it.',
          safeToStart: true,
          housekeeping: ['Regular Maintenance required to keep under control'],
          limitations:
            'Spikes on the north parapet only; the east ledge needs a scissor lift (quoted separately).',
          comments:
            'Bird proofing: stainless pigeon spikes along 18 m of the north parapet and 50 mm netting over the rooftop plant deck. Droppings cleared from the loading dock ledges.',
          nextVisit: '6 Months',
          addPhotos: true,
        })
        .sign(t + 110 * MINUTE, 'technicianSignature', {
          technician: 'contractor',
        })
        .sign(t + 112 * MINUTE, 'clientSignature', { client: 'Tom Hale' })
        .confirm(t + 112 * MINUTE)
        .finalise(endOf(job) + 65 * MINUTE)
    }

    // ── Timber pest inspections: everything flagged, and all clear ─────
    {
      const job = book.named('termiteInspectionFlagged')
      const t = job.scheduledAt
      const day = dayKeyOf(t, base.timezone)
      story
        .draft('tpFlagged', {
          author: 'owner',
          template: 'timberPestInspection',
          job,
          at: t + 3 * MINUTE,
        })
        .photo(t + 6 * MINUTE, 'propertyPhoto', { photo: 0 })
        .photo(t + 40 * MINUTE, 'termiteWorkingsPhotos', {
          photo: 2,
          caption: 'Mud leads up the slab edge at the rear patio',
        })
        .photo(t + 43 * MINUTE, 'termiteWorkingsPhotos', { photo: 3 })
        .save(t + 70 * MINUTE, {
          inspectionTypeWarranty: [TIMBER_WARRANTY, 'Year 2'],
          clientAgreesToInspection: 'Yes',
          peoplePresent: ['Client', 'Technician'],
          weatherConditions: 'Prolonged Wet Period',
          agreementDate: dayKeyOf(t - 7 * 24 * HOUR, base.timezone),
          summaryHinderedAccess: 'Yes, see Section 5',
          summaryRestrictedAccess: 'Yes, see Section 5',
          summaryHighRiskAreas: 'Yes, see Section 5',
          summaryActiveTermites: 'Yes, see Section 6',
          summaryTermiteNest: 'No, read report in full',
          summaryTermiteWorkings: 'Yes, see Section 6',
          summaryBorers: 'No, read report in full',
          summaryFungalDecay: 'Yes, see Section 6',
          summaryFurtherInspections: 'Yes, see Section 6',
          summarySusceptibility: 'HIGH, read report in full',
          facadeFaces: 'Approximately Northwest',
          siteTopography: 'Falls to the West',
          structureType: 'Detached house',
          structureHeight: 'Single Storey',
          wallConstruction: ['Brick Veneer'],
          floorType: ['Timber Flooring with Concrete Areas'],
          roofType: ['Trusses', 'Cement Tile'],
          propertyComments:
            'Brick veneer on slab with a timber-floored rear extension (about 2005).',
          furnishingStatus:
            'At the time of the inspection the property was fully furnished',
          occupancyStatus:
            'At the time of inspection the property was occupied',
          hinderedAccess: true,
          hinderedAccessComments:
            'Stored boxes along the garage walls; furniture against most internal walls.',
          restrictedAccess: true,
          restrictedAccessComments:
            'Subfloor of the rear extension: under 300 mm clearance past the first bearer.',
          highRiskAreas: true,
          highRiskAreasComments:
            'Rear patio slab edge and the pergola posts: both concealed by paving and garden beds.',
          invasiveInspectionRecommended: true,
          invasiveInspectionComments:
            'Recommended for the rear extension wall linings once the activity is treated.',
          liveTermites: true,
          liveTermitesComments:
            'Live Coptotermes in the mud leads on the rear patio slab edge.',
          termiteNest: false,
          termiteWorkings: true,
          termiteWorkingsPhotoComments: 'Rear patio slab edge, western corner.',
          termiteWorkingsComments:
            'Active workings on the slab edge at the rear patio. They were not disturbed.',
          termiteTreatmentRecommended: 'Yes',
          termiteTreatmentComments:
            'A chemical soil barrier to the perimeter and the rear extension is recommended; proposal to follow.',
          previousTreatment: false,
          durableNoticeFound: 'No',
          borers: false,
          fungalDecay: true,
          fungalDecayComments:
            'Decay at the base of two pergola posts set in the soil.',
          inspectionFrequency: '3 months',
          susceptibilityRating: 'HIGH',
          ...CONDUCIVE_FLAGGED,
          inspectorSignedDate: day,
          clientSignedDate: day,
        })
        .sign(t + 85 * MINUTE, 'inspectorSignature', { technician: 'owner' })
        .sign(t + 88 * MINUTE, 'clientSignature', { client: null })
        .confirm(t + 88 * MINUTE)
        .finalise(endOf(job) + 60 * MINUTE)
    }
    {
      const job = book.named('termiteInspectionClean')
      const t = job.scheduledAt
      story
        .draft('tpClean', {
          author: 'contractor',
          template: 'timberPestInspection',
          job,
          at: t + 4 * MINUTE,
        })
        .photo(t + 8 * MINUTE, 'propertyPhoto', { photo: 5 })
        .save(t + 75 * MINUTE, {
          inspectionTypeWarranty: [TIMBER_WARRANTY, 'Year 4'],
          clientAgreesToInspection: 'Yes',
          peoplePresent: ['Client Gave Access away at time of Inspection'],
          weatherConditions: 'Dry',
          summaryHinderedAccess: 'No, read report in full',
          summaryRestrictedAccess: 'No, read report in full',
          summaryHighRiskAreas: 'No, read report in full',
          summaryActiveTermites: 'No, read report in full',
          summaryTermiteNest: 'No, read report in full',
          summaryTermiteWorkings: 'No, read report in full',
          summaryBorers: 'No, read report in full',
          summaryFungalDecay: 'No, read report in full',
          summaryFurtherInspections: 'No, read report in full',
          summarySusceptibility: 'LOW, read report in full',
          facadeFaces: 'Approximately East',
          siteTopography: 'Falls to the South',
          structureType: 'House',
          structureHeight: 'Two Storey',
          wallConstruction: ['Double Brick'],
          floorType: ['Concrete Slab'],
          roofType: ['Terracotta Tile'],
          furnishingStatus:
            'At the time of the inspection the property was fully furnished',
          occupancyStatus:
            'At the time of inspection the property was occupied',
          hinderedAccess: false,
          restrictedAccess: false,
          highRiskAreas: false,
          invasiveInspectionRecommended: false,
          liveTermites: false,
          termiteNest: false,
          termiteWorkings: false,
          termiteTreatmentRecommended: 'No',
          previousTreatment: true,
          previousTreatmentComments:
            'Reticulation points along the perimeter paving (installed 2019, per the durable notice).',
          durableNoticeFound: 'Yes',
          durableNoticeComments: 'In the meter box, dated 2019.',
          borers: false,
          fungalDecay: false,
          inspectionFrequency: '12 months',
          susceptibilityRating: 'LOW',
          ...CONDUCIVE_CLEAR,
          inspectorSignedDate: dayKeyOf(t, base.timezone),
        })
        .sign(t + 80 * MINUTE, 'inspectorSignature', {
          technician: 'contractor',
        })
        .confirm(t + 80 * MINUTE)
        .finalise(endOf(job) + 60 * MINUTE)
    }
    story
      .draft('tpSubDraft', {
        author: 'sub',
        template: 'timberPestInspection',
        job: book.named('subTimberTomorrow'),
        at: when(-1, 19, 40),
      })
      // Section 4 filled in the night before from last year's file. The
      // licence it would need to be signed is not on file.
      .save(when(-1, 19, 52), {
        inspectionTypeWarranty: [TIMBER_WARRANTY, 'Year 3'],
        clientAgreesToInspection: 'Yes',
        agreementDate: dayKeyOf(when(-8, 12), base.timezone),
        facadeFaces: 'Approximately East',
        structureType: 'Townhouse',
        structureHeight: 'Two Storey',
        wallConstruction: ['Double Brick'],
        floorType: ['Concrete Slab'],
        roofType: ['Tiled Roof'],
        propertyComments:
          'Pre-filled from last year’s inspection file; confirm on site.',
      })

    // ── The termite barrier's certificate, corrected, and corrected again
    {
      const job = book.named('termiteTreatment')
      const t = job.scheduledAt
      const day = dayKeyOf(t, base.timezone)
      const certificate = story
        .draft('tcOriginal', {
          author: 'owner',
          template: 'termiteManagementCert',
          job,
          at: t + 5 * MINUTE,
        })
        // Early in the day, before the pathway was drilled after all.
        .save(t + 30 * MINUTE, {
          weather: 'Dry',
          agreementDate: dayKeyOf(t - 7 * 24 * HOUR, base.timezone),
          systemType: 'Chemical Soil Barrier',
          limitationsPresent: true,
          limitationFactors: [
            'Concrete / paved pathways abutting structure (undrilled)',
          ],
          limitationDetails:
            'Front path along the eastern wall, to be drilled if the client agrees.',
        })
        .photo(t + 60 * MINUTE, 'installationPhotos', {
          photo: 1,
          caption: 'Trench along the western wall before treatment',
        })
        .photo(t + 150 * MINUTE, 'installationPhotos', { photo: 4 })
        .photo(t + 200 * MINUTE, 'installationPhotos', {
          photo: 6,
          cover: true,
        })
        .save(t + 215 * MINUTE, {
          product: 'Termidor HE',
          activeConstituent: 'Fipronil 100 g/L',
          // The mistake the correction is about.
          concentration: '6.0 mL / Litre of water',
          totalQuantity: '420 Litres',
          extentOfTreatment: '64 linear metres',
          applicationMethod: [
            'Trenching & Soil Treatment',
            'Drilling & Chemical Injection',
          ],
          holeSpacing: '200mm c/c',
          trenchDimensions: '150mm wide x 150mm deep to footings',
          areasTreated: [
            'External Soil Perimeter',
            'External Concrete / Paved Perimeter',
            'Concrete Slab Edge / Penetrations',
          ],
          photoComments:
            'Western wall trench, drilled front path, finished perimeter.',
          additionalComments:
            'Client agreed on the day to drill the front path, so the whole perimeter is treated.',
          // Changed after drilling the path. The factors ticked earlier stay
          // in the draft's answers and are dropped when it is locked.
          limitationsPresent: false,
          durableNoticeFitted: 'Yes',
          durableNoticeLocation: 'Electricity Meter Box',
          reinspectionInterval: '12 months',
          nextInspectionDue: dayKeyOf(t + 365 * 24 * HOUR, base.timezone),
          installerDateSigned: day,
          clientSignatoryName: 'Arthur Wilson',
          clientDateSigned: day,
        })
        .photo(t + 225 * MINUTE, 'durableNoticePhoto', { photo: 3 })
        .sign(t + 232 * MINUTE, 'installerSignature', { technician: 'owner' })
        .sign(t + 234 * MINUTE, 'clientSignature', { client: 'Arthur Wilson' })
        .confirm(t + 234 * MINUTE)
        .finalise(endOf(job) + 50 * MINUTE)

      const corrected = certificate
        .amend(
          when(-18, 9, 10),
          'tcAmendment',
          'Wrong product concentration recorded',
        )
        .save(when(-18, 9, 14), {
          concentration: '6.25 mL / Litre of water',
          installerDateSigned: dayKeyOf(when(-18, 9), base.timezone),
        })
        .sign(when(-18, 9, 16), 'installerSignature', { technician: 'owner' })
        .finalise(when(-18, 9, 21))

      corrected
        .amend(
          when(-2, 17, 30),
          'tcAmendmentDraft',
          'Durable notice location recorded as the meter box; it is fitted inside the kitchen cupboard',
        )
        .save(when(-2, 17, 34), { durableNoticeLocation: 'Kitchen Cupboard' })
    }

    // ── The business's own forms ────────────────────────────────────────
    {
      const job = book.named('baitStationCheck')
      const t = job.scheduledAt
      const stations = [
        ['Station 1 — north fence', 'None'],
        ['Station 2 — north fence', 'None'],
        ['Station 3 — loading dock', 'Partly eaten (25–75%)'],
        ['Station 4 — loading dock', 'Fully eaten (over 75%)'],
        ['Station 5 — bin store', 'Bait missing or damaged'],
        ['Station 6 — office entry', 'Nibbled (under 25%)'],
      ]
      const rows = rowIds('baitFinal')
      story
        .draft('baitFinal', {
          author: 'contractor',
          template: 'custom',
          customTemplateId: custom('baitStation'),
          job,
          at: t + MINUTE,
        })
        .save(t + 20 * MINUTE, {
          baitType: 'Wax block',
          stations: stations.length,
          activity: true,
          activityNotes:
            'Fresh droppings and gnaw marks beside the loading dock roller door. Bait topped up in stations 3 and 4; station 5 replaced (lid cracked).',
          stationsLog: stations.map(([station, consumption]) => ({
            _id: rows.next(),
            station,
            consumption,
          })),
        })
        .photo(t + 12 * MINUTE, 'photos', {
          photo: 0,
          caption: 'Station 3 at the loading dock',
        })
        .photo(t + 15 * MINUTE, 'photos', { photo: 2 })
        .photo(t + 18 * MINUTE, 'photos', { photo: 5, cover: true })
        .sign(t + 26 * MINUTE, 'techSig', { technician: 'contractor' })
        .confirm(t + 26 * MINUTE)
        .finalise(endOf(job) + 45 * MINUTE)
    }
    {
      // Started while the possum form was still offered; it was retired ten
      // days ago with this draft still open on it.
      const job = book.possumJob(when(-60, 0), when(-11, 0))
      const t = job ? job.scheduledAt : when(-14, 15)
      story
        .draft('possumDraft', {
          author: job ? workerOf(job.assignee) : 'owner',
          template: 'custom',
          customTemplateId: custom('possumArchived'),
          ...(job ? { job } : { propertyKey: 'dayoHome' }),
          at: t + 10 * MINUTE,
        })
        .save(t + 25 * MINUTE, {
          ...(job ? {} : { checkDate: dayKeyOf(t, base.timezone) }),
          entryPoints: ['Lifted roof tiles', 'Gap at the fascia'],
          flapFitted: true,
          possumNotes:
            'One-way flap fitted over the gap at the rear fascia. Back in three nights to check the flap and seal the gap once the possum is out.',
        })
    }
    story
      .draft('cloneDraft', {
        author: 'owner',
        template: 'custom',
        customTemplateId: custom('serviceClone'),
        job: book.named('fannieBayTomorrow'),
        at: when(-1, 17, 5),
      })
      .save(when(-1, 17, 12), {
        accessNotes:
          'Side gate on George Crescent. Two friendly dogs; the client will shut them in the laundry.',
      })

    // ── Drafts the library has to show ──────────────────────────────────
    story.draft('srToday', {
      author: 'owner',
      template: 'serviceReport',
      job: book.named('todayUnstarted1730'),
      at: when(-1, 20, 15),
    })
    {
      const job = book.named('subStaleDraft')
      const t = job.scheduledAt
      story
        .draft('srStale', {
          author: 'sub',
          template: 'serviceReport',
          job,
          at: t + 4 * MINUTE,
        })
        // Started on site and never finished: half a treatment row, no
        // signature, untouched since.
        .save(t + 30 * MINUTE, (data) => ({
          treatments: halfRow(data, [
            'Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)',
          ]),
          risks: ['People/Children'],
          safeToStart: true,
          comments: 'Kitchen and bin store done. Still to do: the laundry.',
        }))
    }
    {
      // Binned two days ago: in Recently Deleted, restorable, and well inside
      // the thirty days the nightly purge leaves it.
      const job = book.trashable(when(-10, 0), when(-2, 0))
      story
        .draft('srTrashed', {
          author: 'owner',
          template: 'serviceReport',
          job,
          at: endOf(job) + 12 * MINUTE,
        })
        .trash(when(-2, 8, 15))
    }

    // ── Everyday history: service reports by the owner, the contractor
    // and Dana, as varied as a quarter's work is ───────────────────────────
    const history = book.history(when(-60, 0), when(0, 0) - 2 * HOUR, {
      owner: 3,
      contractor: 3,
      dana: 2,
    })
    // The contractor's first one waited overnight and the owner locked it.
    const lockedByOwner = history.find(
      (job) => job.assignee === 'contractor' && endOf(job) < when(-2, 0),
    )
    // The owner sends one to a property manager nobody has on file: queued
    // all the same, because sending anywhere is the owner's call.
    const sentOnByOwner = history.find((job) => job.assignee === 'owner')
    for (const [i, job] of history.entries()) {
      const key = `srHistory${i + 1}`
      const author = workerOf(job.assignee)
      const t = job.scheduledAt
      const end = endOf(job)
      const withPhotos = i % 3 === 0
      const report = story
        .draft(key, {
          author,
          template: 'serviceReport',
          job,
          at: t + (2 + (i % 4)) * MINUTE,
        })
        .save(t + Math.round(job.durationMinutes * 0.7) * MINUTE, (data) => ({
          ...(i % 2 === 1 ? { location: fix(i, t + 5 * MINUTE) } : {}),
          finishTime: timeKeyOf(end - 2 * MINUTE, base.timezone),
          weather: WEATHER_SETS[i % WEATHER_SETS.length],
          treatments: treatmentRows(data, TREATMENTS[job.jobType], key),
          ...RISK_SETS[i % RISK_SETS.length],
          ...SAFETY_CHECKS,
          safeToStart: true,
          ...(HOUSEKEEPING_SETS[i % HOUSEKEEPING_SETS.length].length > 0
            ? { housekeeping: HOUSEKEEPING_SETS[i % HOUSEKEEPING_SETS.length] }
            : {}),
          comments:
            i === 0
              ? `${SERVICE_NOTES[job.jobType]} Client’s note: « très bien » 😊 — the side gate code has changed, ask before next visit ✅`
              : SERVICE_NOTES[job.jobType],
          nextVisit: NEXT_VISIT[job.jobType],
          // A client who had a copy last time and asked not to again.
          ...(i % 4 === 3 ? { sendCopy: false } : {}),
          ...(job === sentOnByOwner
            ? { emailReportTo: ['property.manager@example.org'] }
            : {}),
          ...(withPhotos ? { addPhotos: true } : {}),
        }))
      if (withPhotos) {
        report
          .photo(t + 10 * MINUTE, 'photos', { photo: (i + 3) % 8 })
          .photo(t + 12 * MINUTE, 'photos', { photo: (i + 6) % 8, cover: true })
      }
      report.sign(end - 3 * MINUTE, 'technicianSignature', {
        technician: author,
      })
      if (i % 2 === 0) {
        report.sign(end - MINUTE, 'clientSignature', { client: null })
      }
      report.confirm(end)
      if (job === lockedByOwner) {
        const nextMorning = at(base, dayOffsetOf(base, end) + 1, 7, 48)
        report
          .ownerOpens(nextMorning)
          .finalise(nextMorning + 4 * MINUTE, 'owner')
      } else {
        report.finalise(end + (50 + 7 * (i % 5)) * MINUTE)
      }
    }

    await story.play()
    return { reports: story.ids }
  },
})

// ──────────────────────────────────────────────────────────── the jobs

function endOf(job: ManifestJob): number {
  return job.scheduledAt + job.durationMinutes * MINUTE
}

function workerOf(assignee: string): Worker {
  const found = WORKERS.find((w) => w === assignee)
  if (!found) {
    throw new ConvexError(`DEMO_REPORTS: "${assignee}" cannot write a report`)
  }
  return found
}

/** Days from the seed's today to the day an instant falls on. */
function dayOffsetOf(base: DemoBase, ts: number): number {
  const guess = Math.floor((ts - at(base, 0, 0)) / (24 * HOUR))
  for (const day of [guess - 1, guess, guess + 1]) {
    if (ts >= at(base, day, 0) && ts < at(base, day + 1, 0)) return day
  }
  return guess
}

/**
 * The jobs step's manifest, as this step reads it: the named jobs by key,
 * and the unnamed history picked by what it is, each job written up once.
 */
function jobBook(base: DemoBase, jobs: Array<ManifestJob>) {
  const used = new Set<Id<'jobs'>>()
  const take = (job: ManifestJob) => {
    used.add(job.id)
    return job
  }
  const done = (job: ManifestJob) =>
    job.status === 'completed' || job.status === 'invoiced'
  /** Unnamed work, not yet written up, oldest first. */
  const unnamed = (keep: (job: ManifestJob) => boolean) =>
    jobs
      .filter((job) => job.key === undefined && !used.has(job.id) && keep(job))
      .sort(
        (a, b) =>
          a.scheduledAt - b.scheduledAt ||
          a.propertyKey.localeCompare(b.propertyKey),
      )

  return {
    named(key: string): ManifestJob {
      const found = jobs.filter((job) => job.key === key)
      if (found.length !== 1) {
        throw new ConvexError(`DEMO_REPORTS: no job "${key}" in the manifest`)
      }
      return take(found[0])
    },

    /** The subcontractor's free return visit to the same block after
     * `after`, or failing that their latest finished service job. */
    warrantyCallBack(after: ManifestJob): ManifestJob {
      const finished = unnamed(
        (job) =>
          job.assignee === 'sub' &&
          done(job) &&
          SERVICE_JOB_TYPES.has(job.jobType) &&
          endOf(job) + 2 * HOUR <= at(base, 0, 0),
      )
      const callBack =
        finished.find(
          (job) =>
            job.propertyKey === after.propertyKey &&
            job.scheduledAt > after.scheduledAt,
        ) ?? finished.at(-1)
      if (!callBack) {
        throw new ConvexError(
          'DEMO_REPORTS: the subcontractor has no finished job',
        )
      }
      return take(callBack)
    },

    /** A possum job in the window the possum form was still offered, by
     * someone other than the subcontractor, whose drafts are the four the
     * brief gives them. */
    possumJob(from: number, to: number): ManifestJob | null {
      const found = unnamed(
        (job) =>
          job.jobType === 'Possum Removal' &&
          (job.assignee === 'owner' ||
            job.assignee === 'contractor' ||
            job.assignee === 'dana') &&
          job.scheduledAt >= from &&
          endOf(job) + HOUR <= to,
      ).at(-1)
      return found ? take(found) : null
    },

    /** One of the owner's recent service jobs, for a duplicate draft. */
    trashable(from: number, to: number): ManifestJob {
      const owner = (job: ManifestJob) =>
        job.assignee === 'owner' &&
        SERVICE_JOB_TYPES.has(job.jobType) &&
        endOf(job) + HOUR <= to
      const found =
        unnamed((job) => owner(job) && job.scheduledAt >= from).at(-1) ??
        unnamed(owner).at(-1)
      if (!found) {
        throw new ConvexError(
          'DEMO_REPORTS: the owner has no service job to duplicate',
        )
      }
      return take(found)
    },

    /**
     * Finished service jobs in the window, `counts[who]` of each person's,
     * spread evenly across their weeks, and returned oldest first.
     */
    history(
      from: number,
      to: number,
      counts: Partial<Record<Worker, number>>,
    ): Array<ManifestJob> {
      const picked: Array<ManifestJob> = []
      for (const [who, count] of Object.entries(counts)) {
        const theirs = unnamed(
          (job) =>
            job.assignee === who &&
            done(job) &&
            SERVICE_JOB_TYPES.has(job.jobType) &&
            job.propertyKey !== 'marcusHome' &&
            job.scheduledAt >= from &&
            endOf(job) <= to,
        )
        if (theirs.length === 0) continue
        const n = Math.min(count, theirs.length)
        for (let i = 0; i < n; i++) {
          const index =
            n === 1
              ? theirs.length - 1
              : Math.round((i * (theirs.length - 1)) / (n - 1))
          picked.push(take(theirs[index]))
        }
      }
      return picked.sort((a, b) => a.scheduledAt - b.scheduledAt)
    },
  }
}

// ──────────────────────────────────────────────────────────── answers

function answersOf(report: Doc<'reports'>): Answers {
  const data: unknown = report.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? { ...(data as Answers) }
    : {}
}

/** Convex stores no `undefined`; an answer cleared is an answer absent. */
function definedOnly(data: Answers): Answers {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  )
}

/** The treatment grid as the technician left it: the row the job type
 * seeded, completed, then any more they added. */
function treatmentRows(
  data: Answers,
  rows: Array<Treatment>,
  key: string,
): Array<Answers> {
  const seeded = firstRowId(data)
  const ids = rowIds(key)
  return rows.map((row, i) => ({
    _id: i === 0 && seeded ? seeded : ids.next(),
    ...row,
  }))
}

/** The seeded row with a product picked and nothing else yet: the state
 * finalise refuses with "Complete this row or delete it". */
function halfRow(data: Answers, product: Array<string>): Array<Answers> {
  const rows = Array.isArray(data.treatments) ? data.treatments : []
  const first: unknown = rows[0]
  return typeof first === 'object' && first !== null
    ? [{ ...(first as Answers), product }]
    : []
}

function firstRowId(data: Answers): string | undefined {
  const rows = Array.isArray(data.treatments) ? data.treatments : []
  const first: unknown = rows[0]
  if (typeof first !== 'object' || first === null) return undefined
  const id = (first as Answers)._id
  return typeof id === 'string' ? id : undefined
}

/**
 * Row ids as the builder mints them (`crypto.randomUUID()`), but the same on
 * every run: a v4-shaped UUID hashed from the report's key and the row.
 */
function rowIds(key: string) {
  let n = 0
  return {
    next(): string {
      const hex = [0, 1, 2, 3]
        .map((part) => fnv(`${key}/${n}/${part}`))
        .join('')
      n += 1
      const variant = '89ab'[parseInt(hex[16], 16) % 4]
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    },
  }
}

/** FNV-1a, 32 bits, finished with murmur3's mixer so that neighbouring rows
 * do not share digits, as eight hex digits. */
function fnv(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** A GPS answer as the gps control captures it. */
function fix(i: number, capturedAt: number): Answers {
  const reading = FIXES[i % FIXES.length]
  return { ...reading, at: capturedAt }
}

// ──────────────────────────────────────────────────────────── the story

type Step = { at: number; order: number; run: () => Promise<void> }

type DraftSpec = {
  author: Worker
  template: Exclude<TemplateId, 'treatmentRecord'> | 'custom'
  customTemplateId?: Id<'customReportTemplates'>
  job?: ManifestJob
  /** Where a draft with no job is written. */
  propertyKey?: string
  at: number
}

type Report = {
  save: (at: number, fill: Fill) => Report
  confirm: (at: number) => Report
  sign: (at: number, fieldKey: string, signer: Signer) => Report
  photo: (at: number, fieldKey: string, shot: Shot) => Report
  ownerOpens: (at: number) => Report
  finalise: (at: number, by?: Worker) => Report
  trash: (at: number) => Report
  reject: (at: number) => Report
  amend: (at: number, key: string, reason: string) => Report
}

/**
 * Collects every report's history as dated steps, then plays them back in
 * date order. One report's steps are written together, which is how they
 * read; played in time order across all of them, which is how they happened
 * — so the business's report numbers go out in the order reports were
 * locked, and rows are inserted oldest first.
 */
function storyteller(
  ctx: MutationCtx,
  base: DemoBase,
  properties: Record<string, Id<'properties'>>,
  now: number,
) {
  const steps: Array<Step> = []
  const ids: Record<string, Id<'reports'>> = {}
  const envs = new Map<Worker, WriteEnvelope>()
  let order = 0

  // Never later than the moment of seeding: nothing can have been written in
  // the future, and the owner's refusal, dated the morning after yesterday's
  // report, may not have come yet when the seed runs before breakfast.
  const past = (ts: number) => Math.min(ts, now - MINUTE)
  const schedule = (ts: number, act: (ts: number) => Promise<void>) => {
    const when = past(ts)
    steps.push({ at: when, order: order++, run: () => act(when) })
  }

  const envFor = async (who: Worker): Promise<WriteEnvelope> => {
    const known = envs.get(who)
    if (known) return known
    const env = await writeEnvelopeForMember(ctx, base.members[who])
    envs.set(who, env)
    return env
  }

  const read = async (key: string): Promise<Doc<'reports'>> => {
    const id = ids[key] as Id<'reports'> | undefined
    const report = id ? await ctx.db.get(id) : null
    if (!report) throw new Error(`demo: report ${key} is missing`)
    return report
  }

  /** The form as the builder shows it: the business's lists and settings
   * over the revision the report was started on. */
  const formOf = async (report: Doc<'reports'>): Promise<ReportTemplate> => {
    const custom = report.customTemplateId
      ? await ctx.db.get(report.customTemplateId)
      : null
    return resolveReportTemplate({
      template: report.template,
      templateVersion: report.templateVersion,
      customTemplate: custom ?? undefined,
      optionSets: await loadOverrides(ctx, report.businessId),
      settings: await settingsFor(
        ctx,
        report.businessId,
        templateRefOf(report),
      ),
    })
  }

  /** Who signs a client's pad: the person, or a business's primary contact. */
  const signatoryOf = async (report: Doc<'reports'>): Promise<string> => {
    const property = await ctx.db.get(report.propertyId)
    const client = property ? await ctx.db.get(property.clientId) : null
    if (!client) return ''
    if (client.kind === 'business') {
      const contacts = await ctx.db
        .query('clientContacts')
        .withIndex('by_client', (q) => q.eq('clientId', client._id))
        .take(20)
      const primary = contacts.find((c) => c.isPrimary === true)
      if (primary) return primary.name
    }
    return client.name.trim()
  }

  function handle(key: string, author: Worker): Report {
    const self: Report = {
      /** saveDraft without a base: the answers replaced, updatedAt bumped. */
      save(ts, fill) {
        schedule(ts, async (when) => {
          const report = await read(key)
          const data = answersOf(report)
          const changes = typeof fill === 'function' ? fill(data) : fill
          await ctx.db.patch(report._id, {
            data: definedOnly({ ...data, ...changes }),
            updatedAt: when,
          })
        })
        return self
      },

      /** confirmPrefill, for every suggestion the technician passed. */
      confirm(ts) {
        schedule(ts, async (when) => {
          const report = await read(key)
          const prefill = report.prefill
          if (!prefill) return
          const next = { ...prefill }
          let changed = false
          for (const [field, entry] of Object.entries(prefill)) {
            if (entry.confirmedAt !== undefined) continue
            next[field] = { ...entry, confirmedAt: when }
            changed = true
          }
          if (changed) await ctx.db.patch(report._id, { prefill: next })
        })
        return self
      },

      /**
       * attachSignature, then the builder's autosave of `{ signedAt }`.
       * A technician's first signature is drawn and kept as their own (the
       * sheet's "keep" box starts ticked); after that they reuse it. A
       * client signs on the technician's device, typing their name.
       */
      sign(ts, fieldKey, signer) {
        schedule(ts, async (when) => {
          const report = await read(key)
          const field = fieldsOf(await formOf(report)).find(
            (f) => f.key === fieldKey,
          )
          if (field?.kind !== 'signature') {
            throw new Error(`demo: ${key} has no signature field ${fieldKey}`)
          }
          const statement = field.statement
            ? { statement: field.statement }
            : {}
          let slot: NonNullable<Doc<'reports'>['signatureSlots']>[string]
          if ('technician' in signer) {
            const membership = await ctx.db.get(base.members[signer.technician])
            if (!membership) throw new Error('demo: a signer is missing')
            const storageId = base.images.signatures[signer.technician]
            const saved = membership.savedSignatureStorageId === storageId
            if (!saved) {
              await ctx.db.patch(membership._id, {
                savedSignatureStorageId: storageId,
              })
            }
            slot = {
              storageId,
              signedAt: when,
              method: saved ? 'saved' : 'drawn',
              ...statement,
              templateVersion: report.templateVersion,
              capturedByMembershipId: membership._id,
            }
          } else {
            const name = signer.client ?? (await signatoryOf(report))
            slot = {
              storageId: base.images.signatures.client,
              signedAt: when,
              method: 'drawn',
              ...(name ? { signedBy: name } : {}),
              ...statement,
              templateVersion: report.templateVersion,
              // The technician's phone, handed over.
              capturedByMembershipId: base.members[author],
            }
          }
          await ctx.db.patch(report._id, {
            signatureSlots: {
              ...(report.signatureSlots ?? {}),
              [field.slot]: slot,
            },
            data: { ...answersOf(report), [fieldKey]: { signedAt: when } },
            updatedAt: when,
          })
        })
        return self
      },

      /** addGalleryPhoto, with the caption and cover set as their own
       * mutations then leave the row. */
      photo(ts, fieldKey, shot) {
        schedule(ts, async (when) => {
          const report = await read(key)
          const image = base.images.photos.at(shot.photo)
          if (!image) throw new Error(`demo: no stored photo ${shot.photo}`)
          const existing = await ctx.db
            .query('reportPhotos')
            .withIndex('by_report_field', (q) =>
              q.eq('reportId', report._id).eq('fieldKey', fieldKey),
            )
            .take(100)
          const stored = shot.unsized
            ? null
            : await ctx.db.system.get('_storage', image.storageId)
          await ctx.db.insert('reportPhotos', {
            reportId: report._id,
            fieldKey,
            storageId: image.storageId,
            ...(shot.caption ? { caption: shot.caption } : {}),
            ...(shot.unsized
              ? {}
              : {
                  width: image.width,
                  height: image.height,
                  ...(stored ? { bytes: stored.size } : {}),
                }),
            order: existing.length,
            isCover: shot.cover === true,
            createdAt: when,
          })
        })
        return self
      },

      /** The owner opening someone else's draft: once per sitting, on the
       * draft's own history (recordEditByAnother). */
      ownerOpens(ts) {
        schedule(ts, async (when) => {
          const report = await read(key)
          await recordOnce(ctx, forSelf(base.members.owner), {
            businessId: report.businessId,
            action: 'report.edit.byOwner',
            entityType: 'reports',
            entityId: report._id,
            at: when,
            since: when - OWNER_EDIT_WINDOW_MS,
          })
        })
        return self
      },

      /**
       * finalise: the builder sends the answers as they will be stored, and
       * finalise's own body does the rest. Then what it stamped with the
       * wall clock is moved back to the moment it happened.
       */
      finalise(ts, by) {
        schedule(ts, async (when) => {
          const report = await read(key)
          const payload = submittablePayload(
            await formOf(report),
            answersOf(report),
          )
          await finaliseReport(
            ctx,
            await envFor(by ?? author),
            report,
            payload,
            when,
          )

          const locked = await read(key)
          if (locked.contextSnapshot) {
            await ctx.db.patch(locked._id, {
              contextSnapshot: { ...locked.contextSnapshot, capturedAt: when },
            })
          }
          const deliveries = await ctx.db
            .query('reportDeliveries')
            .withIndex('by_report', (q) => q.eq('reportId', locked._id))
            .take(20)
          for (const delivery of deliveries) {
            await ctx.db.patch(delivery._id, { createdAt: when })
          }
        })
        return self
      },

      /** softDelete: the bin stamp and updatedAt. Audited only when
       * switched, and nobody here is. */
      trash(ts) {
        schedule(ts, async (when) => {
          const report = await read(key)
          if (report.status !== 'draft') {
            throw new Error(`demo: ${key} is finalised and cannot be binned`)
          }
          await ctx.db.patch(report._id, { deletedAt: when, updatedAt: when })
        })
        return self
      },

      /** deliveries.reject, by the owner, of the send the form held. */
      reject(ts) {
        schedule(ts, async (when) => {
          const report = await read(key)
          const held = (
            await ctx.db
              .query('reportDeliveries')
              .withIndex('by_report', (q) => q.eq('reportId', report._id))
              .take(20)
          ).find((delivery) => delivery.status === 'pendingApproval')
          if (!held) {
            throw new Error(`demo: ${key} has no send waiting for approval`)
          }
          const owner = base.members.owner
          await ctx.db.patch(held._id, {
            status: 'failed',
            error: 'Not approved',
            approvedByMembershipId: owner,
          })
          await recordAudit(ctx, forSelf(owner), {
            businessId: report.businessId,
            action: 'report.email.rejected',
            entityType: 'reports',
            entityId: held.reportId,
            meta: { to: held.to },
            at: when,
          })
        })
        return self
      },

      /** amend, by the owner: a new draft of the same number. */
      amend(ts, next, reason) {
        schedule(ts, async (when) => {
          const original = await read(key)
          ids[next] = await amendReport(
            ctx,
            await envFor('owner'),
            original,
            reason,
            when,
          )
        })
        return handle(next, 'owner')
      },
    }
    return self
  }

  return {
    ids,

    /** reports.create: a draft seeded from its job, suggestions shown, then
     * dated when it was started. */
    draft(key: string, spec: DraftSpec): Report {
      schedule(spec.at, async (when) => {
        const job = spec.job ? await ctx.db.get(spec.job.id) : null
        if (spec.job && !job) throw new Error(`demo: job for ${key} is missing`)
        const propertyId =
          job?.propertyId ??
          (spec.propertyKey ? properties[spec.propertyKey] : undefined)
        if (!propertyId) throw new Error(`demo: ${key} has nowhere to be`)

        let legalBasis: string
        if (spec.template === 'custom') {
          const custom = spec.customTemplateId
            ? await ctx.db.get(spec.customTemplateId)
            : null
          if (!custom || custom.businessId !== base.businessId) {
            throw new ConvexError(`DEMO_REPORTS: ${key} has no custom template`)
          }
          legalBasis = custom.legalBasis
        } else {
          legalBasis = getTemplate(spec.template).legalBasis
        }

        const id = await insertNewDraft(ctx, {
          businessId: base.businessId,
          propertyId,
          ...(job ? { jobId: job._id } : {}),
          authorMembershipId: base.members[spec.author],
          template: spec.template,
          ...(spec.template === 'custom'
            ? { customTemplateId: spec.customTemplateId }
            : {}),
          legalBasis,
          given: {},
          // What the app always sends.
          showsSuggestions: true,
        })
        await ctx.db.patch(id, { createdAt: when, updatedAt: when })
        ids[key] = id
      })
      return handle(key, spec.author)
    },

    async play() {
      steps.sort((a, b) => a.at - b.at || a.order - b.order)
      for (const step of steps) await step.run()
    },
  }
}
