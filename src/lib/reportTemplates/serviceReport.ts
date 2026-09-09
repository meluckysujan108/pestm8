import { z } from 'zod'
import type { CellDef, ReportTemplate } from './types'

/**
 * The general pest service report — the everyday document, and the one the
 * design partner issues most.
 *
 * Deliberately does NOT collect client name, address, phone or email, though
 * the Formitize original does. Formitize has no customer record, so its form
 * has to ask every time. PestM8 links every report to a `properties` row and
 * the finished document already prints it. Asking again would put a second,
 * divergent copy of a legally-operative address on the record — and the wrong
 * one would eventually be the one printed.
 */

const TREATMENTS = [
  'General Pest Control',
  'EOL (End Of Lease Flea Treatment)',
  'Ant Full Block Spray',
  'Ant Spot Spray',
  'Spider Spray External',
  'Cockroach Treatment',
  'German Cockroach Treatment',
  'Rodents',
  'Cockroach & Rodents',
  'Rodent Bait Top-Up',
  'Live Termites',
  'Wasps',
  'Other',
]

/**
 * Product names carry their active constituent because that is what the label
 * and any later enquiry refer to. Stored as the full string rather than a code:
 * these print onto the record, and a code with no lookup would be unreadable
 * to anyone auditing it years later.
 */
const PRODUCTS = [
  'Biflex Ultra (100 g/L Bifenthrin)',
  'Fipforce HP (100 g/L Fipronil)',
  'Seclira WSG (400 g/kg Dinotefuran)',
  'Sumilarv IGR (20 g/L Pyriproxyfen)',
  'Ditrac All Weather Blox (0.05 g/kg Bromadiolone)',
  'Advion Cockroach Gel AEPMA (6 g/kg Indoxacarb)',
  'Stardust Pro (20 g/kg Permethrin 40:60, 5 g/kg Triflumuron)',
  'Couma (0.37 g/kg Coumatetralyl)',
  'Advion Ant Gel (0.5 g/kg Indoxacarb)',
  'Biflex Aqua Max (100 g/L Bifenthrin)',
  'Clear-Out Crawling Insect Aerosol (0.6 g/kg Fipronil)',
  'Generation First Strike Soft Baits (0.025 g/kg Difethialone)',
  'Termidor Foam Termiticide & Insecticide (0.05 g/kg Fipronil)',
]

const QUANTITIES = [
  '100 mL / 10 L',
  '60 mL / 10 L',
  '20 mL / 2 L',
  '20 g / 5 L',
  '1–5 grams',
  'Bait blocks',
]

const METHODS = [
  'Hand held battery operated sprayer',
  'Hand compression sprayer',
  'Vehicle mounted sprayer',
  'Dusting with blower in roof space',
  'Dusting',
  'Gels applied with gel gun',
  'Misting with backpack',
  'Bait applied in bait stations',
  'SGARs in compliance with the 35 day ruling',
  'Will revisit and collect bait in accordance with new legislation',
]

/** Free text is the value, so it prints as itself on the finished record. */
const asOptions = (values: Array<string>) =>
  values.map((value) => ({ value, label: value }))

const TREATMENT_COLUMNS: Array<CellDef> = [
  { kind: 'checks', key: 'treatment', label: 'Treatment', options: asOptions(TREATMENTS) },
  {
    kind: 'checks',
    key: 'product',
    label: 'Product & active ingredient',
    options: asOptions(PRODUCTS),
  },
  { kind: 'checks', key: 'quantity', label: 'Quantity used', options: asOptions(QUANTITIES) },
  { kind: 'checks', key: 'method', label: 'Application method', options: asOptions(METHODS) },
]

const NEXT_VISIT = [
  '1 week',
  '2 weeks',
  '3 weeks',
  '35 days',
  '1 month',
  '2 months',
  '3 months',
  '3–6 months',
  '6 months',
  '10 months',
  '12 months',
  '6–12 months',
]

export const serviceReport: ReportTemplate = {
  id: 'serviceReport',
  name: 'Pest Service Report',
  shortName: 'Service',
  legalBasis: 'APVMA · AEPMA',
  blurb: 'General pest treatment: products applied, risk assessment and sign-off.',

  // Kept for the legacy readers; `sections` is the real structure.
  fields: [],

  sections: [
    {
      number: 1,
      title: 'Job & site',
      fields: [
        { kind: 'date', key: 'serviceDate', label: 'Date', defaultToday: true, required: true },
        { kind: 'time', key: 'startTime', label: 'Start time' },
        { kind: 'time', key: 'finishTime', label: 'Finish time' },
        {
          kind: 'checks',
          key: 'weather',
          label: 'Weather on the day',
          options: asOptions(['Overcast', 'Wet', 'Sunny', 'Windy', 'Evening']),
        },
        { kind: 'gps', key: 'location', label: 'Site location' },
        {
          kind: 'gallery',
          key: 'coverPhoto',
          label: 'Front page photo',
          // The Formitize original is explicit: "1 Photo only, take in
          // Landscape." One photo has no need for a cover toggle among
          // multiple — `GalleryControl` already hides that control at
          // maxPhotos: 1.
          maxPhotos: 1,
        },
      ],
    },

    {
      number: 2,
      title: 'Treatment, products & quantities applied',
      preamble:
        'One row per product applied. A visit using two products by different methods is two rows.',
      fields: [
        {
          kind: 'repeater',
          key: 'treatments',
          label: 'Treatment',
          addLabel: 'Add treatment',
          columns: TREATMENT_COLUMNS,
          min: 1,
        },
      ],
    },

    {
      number: 3,
      title: 'Risk assessment',
      preamble:
        'Recorded before work starts. Anything not listed can be added as its own item.',
      fields: [
        {
          kind: 'checks',
          key: 'risks',
          label: 'Risks present on or near the treatment site',
          extensible: true,
          addLabel: 'Add another risk…',
          options: asOptions([
            'People/children',
            'Animals / birds / fish',
            'No risk — safe access given',
            'No risk — property empty',
            'Pool',
            'Obstructions on the ground',
          ]),
        },
        {
          kind: 'checks',
          key: 'riskActions',
          label: 'Action taken to eliminate risk',
          extensible: true,
          addLabel: 'Add another action…',
          options: asOptions([
            'Informed people/children to vacate the area or stay indoors',
            'Moved animals or birds to an unaffected part of the property',
            'Client took pets off the property',
            'Client kept pets inside',
            'Safe access given',
          ]),
        },
        { kind: 'toggle', key: 'spillKit', label: 'Spill kit available' },
        { kind: 'toggle', key: 'msds', label: 'SDS on site' },
        { kind: 'toggle', key: 'ppe', label: 'PPE worn' },
        {
          kind: 'toggle',
          key: 'chemicalsSecured',
          label: 'Chemicals locked up and stored after use',
        },
        { kind: 'toggle', key: 'firstAid', label: 'First aid kit on site' },
        {
          kind: 'toggle',
          key: 'signage',
          label: 'Signage displayed showing chemicals being applied',
        },
        {
          kind: 'area',
          key: 'additionalRiskAction',
          label: 'Any other action taken to eliminate risk',
          rows: 2,
        },
        {
          kind: 'toggle',
          key: 'safeToStart',
          label: 'Is it safe to commence work?',
          required: true,
        },
      ],
    },

    {
      number: 4,
      title: "Technician's recommendations & sign-off",
      fields: [
        {
          kind: 'checks',
          key: 'housekeeping',
          label: 'Housekeeping recommendations',
          extensible: true,
          addLabel: 'Add another recommendation…',
          options: asOptions([
            'Regular maintenance required to keep under control',
            'Rubbish removal',
            'Eliminate food sources in the kitchen for cockroaches and ants',
            'Clean bins',
          ]),
        },
        {
          kind: 'area',
          key: 'limitations',
          label: 'Treatment limitations',
          rows: 3,
          placeholder: 'Anything that stopped the treatment being complete.',
        },
        {
          kind: 'area',
          key: 'comments',
          label: "Technician's comments",
          rows: 3,
          placeholder: 'Anything the client should know.',
        },
        {
          kind: 'select',
          key: 'nextVisit',
          label: 'Next visit due in',
          options: asOptions(NEXT_VISIT),
        },
        {
          kind: 'gallery',
          key: 'photos',
          label: 'Report photos',
          addLabel: 'Add report photos',
        },
        {
          kind: 'signature',
          key: 'technicianSignature',
          label: 'Technician signature',
          slot: 'technician',
          role: 'technician',
          required: true,
        },
        {
          kind: 'signature',
          key: 'clientSignature',
          label: 'Client signature',
          slot: 'client',
          role: 'client',
        },
        {
          kind: 'text',
          key: 'emailReportTo',
          label: 'Also email this report to',
          hint: 'Optional. The client on the property record is emailed anyway.',
        },
      ],
    },
  ],

  schema: z.object({
    serviceDate: z.string().min(1, 'Date is required'),
    startTime: z.string().optional(),
    finishTime: z.string().optional(),
    weather: z.array(z.string()).optional(),
    location: z.unknown().optional(),

    treatments: z
      .array(
        z.object({
          _id: z.string(),
          treatment: z.array(z.string()).min(1, 'Choose a treatment'),
          product: z.array(z.string()).min(1, 'Choose a product'),
          quantity: z.array(z.string()).optional(),
          method: z.array(z.string()).min(1, 'Choose an application method'),
        }),
      )
      .min(1, 'Record at least one treatment'),

    risks: z.array(z.string()).optional(),
    riskActions: z.array(z.string()).optional(),
    spillKit: z.boolean().optional(),
    msds: z.boolean().optional(),
    ppe: z.boolean().optional(),
    chemicalsSecured: z.boolean().optional(),
    firstAid: z.boolean().optional(),
    signage: z.boolean().optional(),
    additionalRiskAction: z.string().optional(),
    // Answered, not necessarily "yes": a job stopped because the site was
    // unsafe still has to be recordable, and forcing `true` would push the
    // technician into misreporting it to close the job.
    safeToStart: z.boolean({ message: 'Record whether it was safe to start' }),

    housekeeping: z.array(z.string()).optional(),
    limitations: z.string().optional(),
    comments: z.string().optional(),
    nextVisit: z.string().optional(),
    technicianSignature: z.object({ signedAt: z.number() }).nullish(),
    clientSignature: z.unknown().optional(),
    emailReportTo: z.string().optional(),
  }),

  boilerplate: [
    'WARRANTY AND EXPECTATIONS',
    'All Australian chemicals carry a 3 month warranty when sprayed. Applied correctly, the treatment remains effective for 6 to 12 months depending on conducive conditions at the property.',
    'Please allow 6 weeks for the treatment to work. Pests will be flushed out and will continue to be flushed out for up to 6 weeks. Insects must come into contact with the insecticide to die — insecticides do not work by smell. Properties beside bushland will see insects regularly as they are blown in by wind.',
    'Estimated time to die after contact: approximately 2 days at 1 month after treatment, 4 to 6 days at 2 months, and 6 to 8 days at 3 months.',
    'Large cockroaches, webbing spiders, redback spiders, carpet beetles, silverfish, crickets and existing wasp nests — allow 6 weeks. You may notice pests moving slowly before they die.',
    'German cockroaches — allow 6 weeks. Expect a 70 to 80 per cent reduction in the first week. Severe infestations may require a second treatment.',
    'Spiders — allow 6 weeks. Spiders around windows are reduced by 80 to 90 per cent, and redbacks by 90 to 100 per cent depending on the initial severity. Properties near bush or heavy vegetation will not reach complete elimination.',
    'Ants — allow 6 weeks. It is normal to see ants for up to 3 weeks after treatment while they carry the insecticide back to the nest. Scattered or dying ants indicate the treatment is working.',
    'Rats and mice — allow 4 weeks. Activity commonly increases at first as rodents are drawn to the bait, and noise in the roof void subsides over 3 to 4 weeks. Do not seal entry points until the infestation is controlled.',
    'Fleas — allow 3 to 4 weeks. Vacuum daily from the day after treatment to stimulate hatching, and expect to continue seeing fleas for up to 3 weeks. A second treatment may be required.',
  ].join('\n\n'),
}
