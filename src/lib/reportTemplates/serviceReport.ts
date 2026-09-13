import { z } from 'zod'
import type {
  CellDef,
  Option,
  ReportTemplate,
  RichBlock,
  RichDoc,
  RichMark,
  RichText,
} from './types'

/**
 * The Pest M8 Service Report — word for word.
 *
 * SOURCES (docs/sources/, corpus in spec/serviceReport.generated.ts)
 * - service-report-spec.md       the owner's data dictionary: option strings, control types
 * - service-report-submitted.md  the form as submitted through Formitize: form-only controls
 * - service-report-printed.pdf   the PDF the client received (text layer in the corpus,
 *                                cite `service-report-printed.pdf:pN`): printed labels,
 *                                punctuation, headings, and the whole of the warranty pages
 *
 * PRECEDENCE APPLIED (docs/reports/fidelity.md)
 * - Rule 1  printed labels and their colons from the PDF: `Date:`, `Client Phone:`,
 *           `Start Time:`, `Finish Time:`; `Client Name`, `Site Address`, `GPS Coordinates`,
 *           `Client Email` carry none. `Technician's Name` (p4) over the md's
 *           "Technician's Name (Selection)".
 * - Rule 2  option strings and control types from the spec: `Weather on the Day` is
 *           multi-select; `Additional action taken to eliminate any risk was` is a text area.
 * - Rule 3  form-only controls from the as-submitted form: the front-page photo, the
 *           send-a-copy toggle, `Safety & Compliance Checklists`, `Add Photos?`,
 *           `Email Report To` and its warning.
 * - Rule 4  the warranty pages (`terms`) are the PDF's pages 6-7; both md files paraphrase.
 * - Rule 6  variant picks: `Quantity of Chemicals Used`, `Technician's Comments`,
 *           `Chemicals locked up and stored after use` (see `corrections`, kind 'variant').
 * - Rule 7  the builder shows the as-submitted numbered titles (`1. CLIENT & SITE DETAILS`);
 *           the page prints `print.heading` (§1 none, `Risk Assessment`, …), unnumbered.
 * - Rule 8  unanswered fields are omitted from the printed document (engine behaviour).
 * - Rule 9  `Risks that were present on or near the treatment site.` keeps the PDF's full stop.
 *
 * FOR THE OWNER TO DECIDE
 * - Every `// FLAG:` below is business wording kept verbatim although it reads as a mistake
 *   (fidelity.md "Kept verbatim, flagged for the owner").
 * - Which pad the technician signs: the form declares both `Technician's Signature` and
 *   `Signature`; the sample PDF printed one row labelled `Signature`. Each prints under its
 *   own label when signed. The default required signer here is `Technician's Signature`.
 *
 * FOR THE FIDELITY TEST
 * - Section titles compare as `${number}. ${title}` (the corpus has "1. CLIENT & SITE DETAILS").
 * - 16 strings are verbatim in the sources but missing from the extracted corpus, because
 *   the extractor skips them: `Add Row` / `Delete Row` (spec.md:77, a line with no bullet),
 *   the twelve next-visit options (spec.md:124, backticks inside a non-bold descriptor),
 *   the blank `-` (submitted.md:87, dropped by the `t === '-'` guard) and the Email Report
 *   To warning (submitted.md:93, dropped by CONTROL_DESCRIPTOR's "single-line text input").
 *   Re-run the extractor with rules for them, or allowlist them, before Test B can pass.
 */

/** Option values are the verbatim source strings: value === label, no codes. */
const asOptions = (values: Array<string>): Array<Option> =>
  values.map((value) => ({ value, label: value }))

// ---------------------------------------------------------------------------
// Option lists (owner-editable defaults; `optionsFrom` names the library)
// ---------------------------------------------------------------------------

// src: service-report-spec.md:17-21 (inline: weather set, AS-style scale, not library-backed)
const WEATHER = ['Overcast', 'Wet', 'Sunny', 'Windy', 'Evening']

// src: service-report-spec.md:28-40
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

// src: service-report-spec.md:43-55
// The as-submitted form (submitted.md:45) and the PDF (p3) carry a stray space before `)`
// in three strings; the spec does not. Corrected — see `corrections`.
// FLAG: `g/Kg` (Couma, Advion Ant Gel, Generation First Strike) and `6g/kg` (Advion
// Cockroach Gel) as written; ALL-CAPS active constituents (FIPRONIL, DINOTEFURAN,
// PYRIPROXYFEN, COUMATETRALYL) beside title-case ones.
const PRODUCTS = [
  'Biflex Ultra (100 g/L Bifenthrin)',
  'Fipforce HP (100 g/L FIPRONIL)',
  'Seclira WSG (400 g/kg DINOTEFURAN)',
  'Sumilarv IGR (20 g/L PYRIPROXYFEN)',
  'Ditrac All Weather Blox (0.05 g/kg Bromadiolone)',
  'Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)',
  'Stardust Pro (20 g/kg Permethrin 40:60 5 g/kg Triflumuron)',
  'Couma (0.37 g/Kg COUMATETRALYL)',
  'Advion Ant Gel (0.5 g/Kg Indoxacarb)',
  'Biflex Aqua Max (100 g/L Bifenthrin)',
  'Clear-Out Crawling Insect Aerosol (0.6 g/kg Fipronil)',
  'Generation First Strike Soft Baits (0.025 g/Kg Difethialone)',
  'Termidor Foam Termiticide & Insecticide (0.05 g/kg Fipronil)',
]

// src: service-report-spec.md:58-63
const QUANTITIES = [
  '100ml/10L',
  '60ml/10L',
  '20ml/2L',
  '20g/5 Litres',
  '1-5 grams',
  'Bait Blocks',
]

// src: service-report-spec.md:66-75
const METHODS = [
  'Hand Held Battery Operated Sprayer',
  'Hand Compression Sprayer',
  'Vehicle Mounted Sprayer',
  'Dusting with Blower in Roof Space',
  'Dusting',
  'Gels applied with Gel Gun',
  'Misting with Backpack',
  'Bait Applied in Bait Stations',
  // FLAG: "SGARS" (SGARs); and the "new 35 day ruling" is the APVMA's 24 March 2026
  // suspension of second-generation anticoagulant rodenticides with replacement label
  // instructions — any help text must say so, never "ban" or "new legislation".
  'SGARS in compliance with the new 35 day ruling',
  'Will revisit and collect bait in accordance with new legislation',
]

// src: service-report-spec.md:84-89 (= submitted.md:54-59)
const RISKS = [
  'People/Children',
  'Animals / Birds / Fish',
  // FLAG: `No Risk Safe Access Given` — title case, no punctuation between the clauses.
  'No Risk Safe Access Given',
  'No Risk Property Empty',
  'Pool',
  'Obstructions on the Ground',
]

// src: service-report-spec.md:93-97 (= submitted.md:61-65)
const RISK_ACTIONS = [
  'Informed people/children to vacate the area or stay indoors',
  'Moved Animals or Birds to an unaffected part of the property',
  'Client Took Pets off Property',
  'Client Kept Pets Inside',
  'Safe access given',
]

// src: service-report-spec.md:115-118 (= submitted.md:81-84)
const HOUSEKEEPING = [
  'Regular Maintenance required to keep under control',
  'Rubbish Removal',
  'Eliminate food sources in kitchen for cockroaches and ants',
  'Clean bins',
]

// src: service-report-spec.md:124 (backticked options of the Next Visit dropdown)
const NEXT_VISIT = [
  '1 Week',
  '2 Weeks',
  '3 Weeks',
  '35 Days',
  '1 Month',
  '2 Months',
  '3 Months',
  '3-6 Months',
  '6 Months',
  '10 Months',
  '12 Months',
  '6-12 Months',
]

// ---------------------------------------------------------------------------
// §2 treatment grid columns
// ---------------------------------------------------------------------------

const TREATMENT_COLUMNS: Array<CellDef> = [
  {
    // src: service-report-submitted.md:44; PDF p3 column header; options spec.md:28-40
    kind: 'checks',
    key: 'treatment',
    label: 'Treatment',
    optionsFrom: 'treatments',
    options: asOptions(TREATMENTS),
  },
  {
    // src: service-report-submitted.md:45; PDF p3 column header; options spec.md:43-55
    kind: 'checks',
    key: 'product',
    label: 'Product & Active Ingredient',
    optionsFrom: 'products',
    options: asOptions(PRODUCTS),
  },
  {
    // src: service-report-submitted.md:46 + spec.md:57 (variant pick over PDF p3 "…used")
    kind: 'checks',
    key: 'quantity',
    label: 'Quantity of Chemicals Used',
    optionsFrom: 'quantities',
    options: asOptions(QUANTITIES),
  },
  {
    // src: service-report-submitted.md:47 + spec.md:65 (PDF p3 "Aplication" corrected)
    kind: 'checks',
    key: 'method',
    label: 'Chemical Application Method',
    optionsFrom: 'methods',
    options: asOptions(METHODS),
  },
]

// ---------------------------------------------------------------------------
// Warranty pages (PDF pages 6-7), structure as printed
// ---------------------------------------------------------------------------

const text = (value: string, marks?: Array<RichMark>): RichText =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
const para = (value: string, marks?: Array<RichMark>): RichBlock => ({
  type: 'paragraph',
  content: [text(value, marks)],
})
const heading = (level: 1 | 2 | 3, value: string): RichBlock => ({
  type: 'heading',
  level,
  content: [text(value)],
})
const bullets = (items: Array<string>): RichBlock => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem' as const,
    content: [para(item)],
  })),
})

const WARRANTY_TERMS: RichDoc = {
  type: 'doc',
  content: [
    // src: service-report-printed.pdf:p6 — red bold
    para('Please Note All Australian Chemicals have a 3 Month Warranty when Sprayed', [
      'bold',
      'redText',
    ]),
    // src: service-report-printed.pdf:p6 — red bold
    para(
      'The Value if sprayed correctly will be 6-12 months depending on any conducive conditions',
      ['bold', 'redText'],
    ),
    // src: service-report-printed.pdf:p6 — bold, capitals in the source text itself
    para('PLEASE GIVE IT 6 WEEKS FOR YOUR TREATMENT TO WORK', ['bold']),
    // src: service-report-printed.pdf:p6
    heading(2, '6 WEEKS FLUSH OUT PERIOD'),
    // src: service-report-printed.pdf:p6
    bullets([
      'Pests will be flushed out and will continue to be flushed out for up to 6 weeks.',
      // FLAG: `Living Across` — capital A mid-sentence.
      'Living Across or next to bushland will give you more insects more regularly as they get blown in by the wind etc.',
      'The insects will still be affected by the applied chemicals and Die when they make contact with the insecticide.',
    ]),
    // src: service-report-printed.pdf:p6 — bold
    // FLAG: ends in a trailing comma; nothing follows it on the page.
    para('Pests have to come into Contact with the insecticide for them to die,', ['bold']),
    // src: service-report-printed.pdf:p6 — bold
    para('1 Month up to 2 Days estimate to Die', ['bold']),
    para('2 Months up to 4-6 Days estimate to Die', ['bold']),
    para('3 Months up to 6-8 Days estimate to Die', ['bold']),

    // src: service-report-printed.pdf:p6 ("Pest Treatment,Wait Time, Expectations" — space restored)
    heading(2, 'Pest Treatment, Wait Time, Expectations'),

    // src: service-report-printed.pdf:p6
    heading(
      3,
      'Large cockroaches, webbing spiders, red back spiders, carpet beetles, silverfish, creamy coloured crickets, any existing wasp nests',
    ),
    para('6 Weeks', ['bold']),
    bullets([
      'Cockroaches will be flushed out and will continue to be flushed out for up to 6 weeks.',
      'If you normally get regular yearly treatments, you will see pests dying all year round.',
      'You might notice cockroaches and other pests walking slowly.',
      // FLAG: `IT DOES NOT WORK BY SMELL, otherwise, we will be affected.`
      'Large cockroaches and other insects have to come across the insecticide for them to die, IT DOES NOT WORK BY SMELL, otherwise, we will be affected.',
    ]),

    // src: service-report-printed.pdf:p6 (heading text = submitted.md:118 label, deduped in corpus)
    heading(3, 'German Cockroaches'),
    para('6 Weeks', ['bold']),
    bullets([
      // "Germancockroachesin" — spaces lost in the vendor's HTML-to-PDF step, restored.
      'You should get a 70-80% reduction of German cockroaches in the first week.',
      'They should all be gone in 6 weeks.',
      'If your treatment was considered severe, you may need 2 treatments.',
    ]),

    // src: service-report-printed.pdf:p6 (heading text = submitted.md:119 label, deduped in corpus)
    heading(3, 'Spiders'),
    // FLAG: `6 weeks` in lower case under Spiders only.
    para('6 weeks', ['bold']),
    bullets([
      'Spiders will be flushed out.',
      'Spiders around windows will be reduced by 80-90%.',
      'Red backs should be reduced by 90-100% depending on initial severity.',
      'If you had a severe red back issue, we suggest another external treatment after 3 months, to remove any new population build ups.',
      'If you live in a bushy suburb and a lot of trees around the property, you will never stop spiders 100%.',
    ]),

    // src: service-report-printed.pdf:p7 (heading text = submitted.md:120 label, deduped in corpus)
    heading(3, 'Ants'),
    para('6 Weeks', ['bold']),
    bullets([
      'It is common to continue to see ants up to 3 weeks after treatment',
      'The ants will carry the insecticide back to the nest',
      'If you have been provided with ant bait, please use as per technicians instructions',
      'If ants appeared scattered or dying the treatment is working',
    ]),

    // src: service-report-printed.pdf:p7
    heading(3, 'Rats/Mice'),
    para('4 Weeks', ['bold']),
    bullets([
      'It is common to hear or see an increase in rodent activity after the treatment has been done',
      'The increase in activity is because they become attracted to the baits',
      // "throwingthe" — space restored.
      'You may hear the rats/mice playing, dragging, and throwing the bait blocks in the roof void',
      'This will subside over the next 3-4 weeks',
      'Do not seal off any entrance/exit points until the infestation is under control.',
    ]),

    // src: service-report-printed.pdf:p7 (heading text = submitted.md:122 label, deduped in corpus)
    heading(3, 'Fleas'),
    para('3-4 Weeks', ['bold']),
    bullets([
      // "2ndtreatments" — space restored.
      '2nd treatments may be required',
      'Vacuum daily after the day of treatment as this will assist the eggs hatching and the pupae being released from their eggs',
      'You may continue to see fleas and be bitten for up to 3 weeks',
    ]),
  ],
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TREATMENT_CELLS = ['treatment', 'product', 'quantity', 'method'] as const

/**
 * A row is complete or empty. An empty row is valid here (the builder discards
 * it on save); a row with some columns answered and others not is refused, so a
 * product can never print without the method it was applied by.
 */
const treatmentRow = z
  .object({
    _id: z.string(),
    treatment: z.array(z.string()).optional(),
    product: z.array(z.string()).optional(),
    quantity: z.array(z.string()).optional(),
    method: z.array(z.string()).optional(),
  })
  .superRefine((row, ctx) => {
    const answered = TREATMENT_CELLS.filter((cell) => (row[cell]?.length ?? 0) > 0)
    if (answered.length === 0 || answered.length === TREATMENT_CELLS.length) return
    for (const cell of TREATMENT_CELLS) {
      if ((row[cell]?.length ?? 0) === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [cell],
          message: 'Complete this row or delete it',
        })
      }
    }
  })

const serviceReportSchema = z.object({
  // §1
  serviceDate: z.string().min(1, 'Date is required'),
  location: z.unknown().optional(),
  sendCopy: z.boolean().optional(),
  startTime: z.string().optional(),
  finishTime: z.string().optional(),
  weather: z.array(z.string()).optional(),

  // §2 — no minimum: an inspection-only visit finalises with no rows.
  treatments: z.array(treatmentRow).optional(),

  // §3
  risks: z.array(z.string()).optional(),
  riskActions: z.array(z.string()).optional(),
  spillKit: z.boolean().optional(),
  msds: z.boolean().optional(),
  ppe: z.boolean().optional(),
  chemicalsSecured: z.boolean().optional(),
  firstAid: z.boolean().optional(),
  signage: z.boolean().optional(),
  additionalRiskAction: z.string().optional(),
  // The form's own mandatory gate. Answered, not necessarily Yes: a job stopped
  // because the site was unsafe must still be recordable.
  safeToStart: z.boolean({ message: 'Record whether it is safe to commence work' }),

  // §4
  housekeeping: z.array(z.string()).optional(),
  limitations: z.string().optional(),
  comments: z.string().optional(),
  nextVisit: z.string().optional(),
  technician: z.string().optional(),
  technicianSignature: z.object(
    { signedAt: z.number(), signedBy: z.string().optional() },
    { message: "Technician's Signature is required" },
  ),
  clientSignature: z.unknown().optional(),
  addPhotos: z.boolean().optional(),
  // A v1 draft stored a single string; accepted so switching to v2 keeps it.
  emailReportTo: z.union([z.array(z.string()), z.string()]).optional(),
})

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export const serviceReport: ReportTemplate = {
  id: 'serviceReport',
  // v2 — the verbatim reproduction of the Formitize form. v1 was paraphrased.
  version: 2,
  name: 'Pest Service Report',
  shortName: 'Service',
  legalBasis: 'APVMA · AEPMA',
  blurb: 'General pest treatment: products applied, risk assessment and sign-off.',

  fields: [],

  sections: [
    {
      // src: service-report-submitted.md:16 "1. CLIENT & SITE DETAILS"
      id: 'clientSite',
      number: 1,
      title: 'CLIENT & SITE DETAILS',
      // PDF p2 prints no heading under the title band.
      print: { heading: null },
      fields: [
        {
          // src: service-report-printed.pdf:p2 "Date:" (rule 1); spec.md:6 DD MMM YYYY, default today
          kind: 'date',
          key: 'serviceDate',
          label: 'Date:',
          defaultToday: true,
          required: true,
        },
        {
          // src: service-report-spec.md:7 + submitted.md:19; PDF p2 prints it without a colon
          kind: 'derived',
          key: 'clientName',
          label: 'Client Name',
          source: 'client.name',
        },
        {
          // src: service-report-spec.md:8 + submitted.md:20; PDF p2 (Australia Post form: layout decision)
          kind: 'derived',
          key: 'siteAddress',
          label: 'Site Address',
          source: 'property.address',
          format: 'address',
        },
        {
          // src: service-report-spec.md:9 + submitted.md:21-24; PDF p2 prints Lat/Lng/Alt stacked
          kind: 'gps',
          key: 'location',
          label: 'GPS Coordinates',
          format: 'lines',
        },
        {
          // src: service-report-submitted.md:25 (rule 3; spec.md:10 "Report Cover Photo" superseded)
          kind: 'cover',
          key: 'coverPhoto',
          label: 'Photo for Front Page of Report (1 Landscape Photo)',
        },
        {
          // src: service-report-printed.pdf:p2 "Client Phone:" (rule 1)
          kind: 'derived',
          key: 'clientPhone',
          label: 'Client Phone:',
          source: 'client.phone',
        },
        {
          // src: service-report-spec.md:12 + submitted.md:27; PDF p2 prints it without a colon
          kind: 'derived',
          key: 'clientEmail',
          label: 'Client Email',
          source: 'client.email',
        },
        {
          // src: service-report-submitted.md:28 (rule 3); spec.md:13 Toggle (Yes / No)
          // Form-only: the PDF never prints it (needs BaseField `printed: false`).
          kind: 'toggle',
          key: 'sendCopy',
          // Form-only (rule 3): drives delivery, never printed.
          printed: false,
          label:
            'Send copy of the report to the client email above when you submit this form?',
          yes: 'Yes',
          no: 'No',
        },
        {
          // src: service-report-printed.pdf:p2 "Start Time:" (rule 1); spec.md:14 time picker
          kind: 'time',
          key: 'startTime',
          label: 'Start Time:',
        },
        {
          // src: service-report-printed.pdf:p2 "Finish Time:" (rule 1); spec.md:15 time picker
          kind: 'time',
          key: 'finishTime',
          label: 'Finish Time:',
        },
        {
          // src: service-report-printed.pdf:p2 "Weather Details" (red sub-heading);
          //      submitted.md:31 "Weather Details / Weather on the Day"
          kind: 'heading',
          key: 'weatherDetails',
          label: 'Weather heading',
          text: 'Weather Details',
        },
        {
          // src: service-report-spec.md:16-21 multi-select checkboxes (rule 2); PDF p2 label
          kind: 'checks',
          key: 'weather',
          label: 'Weather on the Day',
          options: asOptions(WEATHER),
        },
      ],
    },

    {
      // src: service-report-submitted.md:40 "2. TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED"
      id: 'treatment',
      number: 2,
      title: 'TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED',
      // src: service-report-printed.pdf:p3 "Treatment ,Product(s) and Quantities Applied" — comma corrected
      print: { heading: 'Treatment, Product(s) and Quantities Applied' },
      fields: [
        {
          // src: service-report-spec.md:25-77 dynamic grid; submitted.md:42-47; PDF p3 table
          // Actions: spec.md:77 "[Delete Row], [Add Row]"
          kind: 'repeater',
          key: 'treatments',
          label: 'Treatment, Product(s) and Quantities Applied',
          addLabel: 'Add Row',
          removeLabel: 'Delete Row',
          min: 0,
          columns: TREATMENT_COLUMNS,
        },
      ],
    },

    {
      // src: service-report-submitted.md:51 "3. RISK ASSESSMENT"
      id: 'risk',
      number: 3,
      title: 'RISK ASSESSMENT',
      // src: service-report-printed.pdf:p3
      print: { heading: 'Risk Assessment' },
      fields: [
        {
          // src: service-report-printed.pdf:p3 (rule 9 full stop); options spec.md:84-89; extensible spec.md:90
          kind: 'checks',
          key: 'risks',
          label: 'Risks that were present on or near the treatment site.',
          extensible: true,
          optionsFrom: 'risks',
          options: asOptions(RISKS),
        },
        {
          // src: service-report-submitted.md:60 + PDF p3; options spec.md:93-97; extensible spec.md:98
          kind: 'checks',
          key: 'riskActions',
          label: 'Action taken to eliminate any risk was',
          extensible: true,
          optionsFrom: 'riskActions',
          options: asOptions(RISK_ACTIONS),
        },
        {
          // src: service-report-submitted.md:66 (rule 3). The PDF prints no such heading.
          kind: 'heading',
          key: 'safetyChecklists',
          printed: false,
          label: 'Safety checklists heading',
          text: 'Safety & Compliance Checklists',
        },
        {
          // src: service-report-spec.md:101 + submitted.md:67 + PDF p3
          kind: 'toggle',
          key: 'spillKit',
          label: 'Spill Kit Available',
          yes: 'Yes',
          no: 'No',
          flaggedValue: false,
        },
        {
          // src: service-report-spec.md:102 + submitted.md:68 + PDF p3
          // FLAG: `MSDS on site` — "SDS" under GHS since 2017.
          kind: 'toggle',
          key: 'msds',
          label: 'MSDS on site',
          yes: 'Yes',
          no: 'No',
          flaggedValue: false,
        },
        {
          // src: service-report-spec.md:103 + submitted.md:69 + PDF p3
          kind: 'toggle',
          key: 'ppe',
          label: 'PPE (for Technicians)',
          yes: 'Yes',
          no: 'No',
          flaggedValue: false,
        },
        {
          // src: service-report-spec.md:104 + submitted.md:70 (variant pick over PDF p3's full stop)
          kind: 'toggle',
          key: 'chemicalsSecured',
          label: 'Chemicals locked up and stored after use',
          yes: 'Yes',
          no: 'No',
          flaggedValue: false,
        },
        {
          // src: service-report-spec.md:105 + submitted.md:71 + PDF p3
          kind: 'toggle',
          key: 'firstAid',
          label: 'First Aid Kit on site',
          yes: 'Yes',
          no: 'No',
          flaggedValue: false,
        },
        {
          // src: service-report-spec.md:106 + submitted.md:72 + PDF p3
          // FLAG: `Signage Displayed showing Chemicals being applied out Front`
          kind: 'toggle',
          key: 'signage',
          label: 'Signage Displayed showing Chemicals being applied out Front',
          yes: 'Yes',
          no: 'No',
          flaggedValue: false,
        },
        {
          // src: service-report-submitted.md:73 label; spec.md:107 "Text area input" (rule 2)
          kind: 'area',
          key: 'additionalRiskAction',
          label: 'Additional action taken to eliminate any risk was',
        },
        {
          // src: service-report-submitted.md:74 + PDF p3; spec.md:108 "(Mandatory gate)"
          kind: 'toggle',
          key: 'safeToStart',
          label: 'Is it safe to commence work?',
          yes: 'Yes',
          no: 'No',
          required: true,
          flaggedValue: false,
        },
      ],
    },

    {
      // src: service-report-submitted.md:78 "4. TECHNICIAN'S RECOMMENDATIONS & COMMENTS"
      id: 'recommendations',
      number: 4,
      title: "TECHNICIAN'S RECOMMENDATIONS & COMMENTS",
      // src: service-report-printed.pdf:p4
      print: { heading: "Technician's Recommendations" },
      fields: [
        {
          // src: service-report-submitted.md:80 + PDF p4; options spec.md:115-118; extensible spec.md:119
          // FLAG: `House Keeping & Cleaning Recommendations to Help eliminate General Pests`
          kind: 'checks',
          key: 'housekeeping',
          label: 'House Keeping & Cleaning Recommendations to Help eliminate General Pests',
          extensible: true,
          optionsFrom: 'housekeeping',
          options: asOptions(HOUSEKEEPING),
        },
        {
          // src: service-report-submitted.md:85; spec.md:122 multi-line
          kind: 'area',
          key: 'limitations',
          label: 'Treatment Limitations',
        },
        {
          // src: service-report-submitted.md:86 + spec.md:123 (variant pick over PDF p4 "Technicians Comments")
          kind: 'area',
          key: 'comments',
          label: "Technician's Comments",
        },
        {
          // src: service-report-submitted.md:87 label, blank `-`; spec.md:124 dropdown + options
          kind: 'select',
          key: 'nextVisit',
          label: 'Your Next Pest Control Visit is due in',
          optionsFrom: 'nextVisit',
          blankOption: '-',
          options: asOptions(NEXT_VISIT),
        },
        {
          // src: service-report-printed.pdf:p4 "Technician's Name" (rule 1); submitted.md:88 roster radio
          kind: 'member',
          key: 'technician',
          label: "Technician's Name",
          roleWord: 'Technician',
          defaultTo: 'jobAssignee',
        },
        {
          // src: service-report-submitted.md:89; spec.md:126 signature pad
          kind: 'signature',
          key: 'technicianSignature',
          label: "Technician's Signature",
          slot: 'technician',
          role: 'technician',
          required: true,
        },
        {
          // src: service-report-submitted.md:90 + PDF p4 "Signature"; spec.md:127 "Customer Signature"
          // Open with the owner: the sample's technician signed this pad (fidelity.md).
          kind: 'signature',
          key: 'clientSignature',
          label: 'Signature',
          slot: 'client',
          role: 'client',
        },
        {
          // src: service-report-submitted.md:91 (rule 3); spec.md:128 Toggle (Yes / No)
          // Form-only (rule 3): the PDF never prints it.
          kind: 'toggle',
          key: 'addPhotos',
          printed: false,
          label: 'Add Photos?',
          yes: 'Yes',
          no: 'No',
        },
        {
          // src: service-report-submitted.md:92 + PDF p5 heading "Report Photos"
          kind: 'gallery',
          key: 'photos',
          label: 'Report Photos',
          visibleWhen: { when: 'addPhotos', eq: true },
        },
        {
          // src: service-report-submitted.md:93 (rule 3); spec.md:129 triggers PDF dispatch
          kind: 'emails',
          key: 'emailReportTo',
          label: 'Email Report To',
          // Form-only (rule 3): a delivery instruction, not document content.
          printed: false,
        },
        {
          // src: service-report-submitted.md:93 the field's warning (rule 3). Screen only.
          kind: 'note',
          key: 'emailReportToWarning',
          label: 'Email warning',
          tone: 'warning',
          attachedTo: 'emailReportTo',
          printed: false,
          body: {
            type: 'doc',
            content: [
              para(
                'Any email address added to this field will receive a copy of the PDF when you hit “Submit”',
              ),
            ],
          },
        },
      ],
    },
  ],

  schema: serviceReportSchema,

  boilerplate: '',

  // src: service-report-printed.pdf:p6-p7 (rule 4). The PDF prints no heading above them.
  terms: WARRANTY_TERMS,

  print: {
    // Fidelity rule 8: unanswered fields are omitted from the printed document.
    omitEmpty: true,
    // The footer and title band print "{brand} Service Report for {year}"
    // (PDF footer "Pest M8 Service Report for 2026"); the form's own name is the
    // cover title, and the brand and year come from the business and the date.
    // src: service-report-printed.pdf:p1
    formName: 'Service Report',
    numbering: 'unnumbered',
    // src: service-report-printed.pdf:p1 cover
    cover: { title: 'Service Report', subtitle: 'Pest Control' },
  },

  sourceRef:
    'docs/sources/service-report-spec.md + docs/sources/service-report-submitted.md + service-report-printed.pdf (text layer in spec/serviceReport.generated.ts)',

  corrections: [
    {
      where: 'Service Report, treatment table header (§2 column 4)',
      source: 'Chemical Aplication Method',
      printed: 'Chemical Application Method',
      reason: 'Typo on the PDF (p3); the spec (spec.md:65) and the as-submitted form (submitted.md:47) have it right',
      kind: 'typo',
    },
    {
      where: 'Service Report, §2 printed section heading',
      source: 'Treatment ,Product(s) and Quantities Applied',
      printed: 'Treatment, Product(s) and Quantities Applied',
      reason: 'Misplaced comma on the PDF (p3)',
      kind: 'typo',
    },
    {
      where: 'Service Report, warranty heading (terms)',
      source: 'Pest Treatment,Wait Time, Expectations',
      printed: 'Pest Treatment, Wait Time, Expectations',
      reason: 'Missing space on the PDF (p6)',
      kind: 'typo',
    },
    {
      where: 'Product list (§2 column 2)',
      source: 'Seclira WSG (400 g/kg DINOTEFURAN )',
      printed: 'Seclira WSG (400 g/kg DINOTEFURAN)',
      reason: 'Stray space before ")" in the as-submitted form (submitted.md:45); the spec (spec.md:45) has none',
      kind: 'typo',
    },
    {
      where: 'Product list (§2 column 2)',
      source: 'Sumilarv IGR (20 g/L PYRIPROXYFEN )',
      printed: 'Sumilarv IGR (20 g/L PYRIPROXYFEN)',
      reason: 'Stray space before ")" in the as-submitted form (submitted.md:45) and PDF p3; the spec (spec.md:46) has none',
      kind: 'typo',
    },
    {
      where: 'Product list (§2 column 2)',
      source: 'Couma (0.37 g/Kg COUMATETRALYL )',
      printed: 'Couma (0.37 g/Kg COUMATETRALYL)',
      reason: 'Stray space before ")" in the as-submitted form (submitted.md:45); the spec (spec.md:50) has none',
      kind: 'typo',
    },
    {
      where: 'Warranty text, German Cockroaches (terms)',
      source: 'You should get a 70-80% reduction of Germancockroachesin the first week.',
      printed: 'You should get a 70-80% reduction of German cockroaches in the first week.',
      reason: "Lost spaces in the vendor's HTML-to-PDF step (p6)",
      kind: 'typo',
    },
    {
      where: 'Warranty text, Rats/Mice (terms)',
      source:
        'You may hear the rats/mice playing, dragging, and throwingthe bait blocks in the roof void',
      printed:
        'You may hear the rats/mice playing, dragging, and throwing the bait blocks in the roof void',
      reason: "Lost space in the vendor's HTML-to-PDF step (p7)",
      kind: 'typo',
    },
    {
      where: 'Warranty text, Fleas (terms)',
      source: '2ndtreatments may be required',
      printed: '2nd treatments may be required',
      reason: "Lost space in the vendor's HTML-to-PDF step (p7)",
      kind: 'typo',
    },
    {
      where: 'Service Report, treatment table header (§2 column 3)',
      source: 'Quantity of Chemicals used',
      printed: 'Quantity of Chemicals Used',
      reason: 'Rule 6 variant pick: both markdown files (spec.md:57, submitted.md:46) agree against the PDF (p3) on case',
      kind: 'variant',
    },
    {
      where: "Service Report, §4 Technician's Comments label",
      source: 'Technicians Comments',
      printed: "Technician's Comments",
      reason: 'Rule 6 variant pick: both markdown files (spec.md:123, submitted.md:86) agree against the PDF (p4) on the apostrophe',
      kind: 'variant',
    },
    {
      where: 'Service Report, §3 safety toggle label',
      source: 'Chemicals locked up and stored after use.',
      printed: 'Chemicals locked up and stored after use',
      reason: "Rule 6 variant pick: both markdown files (spec.md:104, submitted.md:70) agree against the PDF's (p3) trailing full stop",
      kind: 'variant',
    },
  ],

  superseded: [
    // --- service-report-spec.md: the data dictionary's own framing -------------------------
    {
      text: '1. Form Header & Operational Metadata',
      cite: 'service-report-spec.md:3',
      reason: "Rule 7: the builder shows the form's numbered title '1. CLIENT & SITE DETAILS' (submitted.md:16); this is the data dictionary's grouping, and the PDF prints no §1 heading",
    },
    {
      text: 'Date',
      cite: 'service-report-spec.md:6',
      reason: "Rule 1: superseded by the printed label 'Date:' (PDF p2)",
    },
    {
      text: 'Report Cover Photo',
      cite: 'service-report-spec.md:10',
      reason: "Rule 3: superseded by the as-submitted label 'Photo for Front Page of Report (1 Landscape Photo)' (submitted.md:25)",
    },
    {
      text: 'Client Phone',
      cite: 'service-report-spec.md:11',
      reason: "Rule 1: superseded by the printed label 'Client Phone:' (PDF p2)",
    },
    {
      text: 'Send copy to client upon submission',
      cite: 'service-report-spec.md:13',
      reason: "Rule 3: superseded by the as-submitted label 'Send copy of the report to the client email above when you submit this form?' (submitted.md:28)",
    },
    {
      text: 'Start Time',
      cite: 'service-report-spec.md:14',
      reason: "Rule 1: superseded by the printed label 'Start Time:' (PDF p2)",
    },
    {
      text: 'Finish Time',
      cite: 'service-report-spec.md:15',
      reason: "Rule 1: superseded by the printed label 'Finish Time:' (PDF p2)",
    },
    {
      text: '2. Treatment, Product(s) & Quantities Applied (Dynamic Grid / Repeater)',
      cite: 'service-report-spec.md:25',
      reason: "Rule 7: the builder shows '2. TREATMENT, PRODUCT(S) AND QUANTITIES APPLIED' (submitted.md:40); the PDF prints 'Treatment, Product(s) and Quantities Applied'. '(Dynamic Grid / Repeater)' is a control descriptor (kind 'repeater')",
    },
    {
      text: 'Column 1: Treatment (Checkboxes)',
      cite: 'service-report-spec.md:27',
      reason: "Data-dictionary column descriptor; the column prints as 'Treatment' (submitted.md:44, PDF p3), control kind 'checks'",
    },
    {
      text: 'Column 2: Product & Active Ingredient (Checkboxes)',
      cite: 'service-report-spec.md:42',
      reason: "Data-dictionary column descriptor; the column prints as 'Product & Active Ingredient' (submitted.md:45, PDF p3), control kind 'checks'",
    },
    {
      text: 'Column 3: Quantity of Chemicals Used (Checkboxes)',
      cite: 'service-report-spec.md:57',
      reason: "Data-dictionary column descriptor; the column prints as 'Quantity of Chemicals Used' (rule 6 variant), control kind 'checks'",
    },
    {
      text: 'Column 4: Chemical Application Method (Checkboxes)',
      cite: 'service-report-spec.md:65',
      reason: "Data-dictionary column descriptor; the column prints as 'Chemical Application Method' (PDF typo corrected), control kind 'checks'",
    },
    {
      text: '3. Risk Assessment Module',
      cite: 'service-report-spec.md:81',
      reason: "Rule 7: the builder shows '3. RISK ASSESSMENT' (submitted.md:51); the PDF prints 'Risk Assessment'",
    },
    {
      text: 'Risks Present (Checkboxes + Runtime User Input Addition)',
      cite: 'service-report-spec.md:83',
      reason: "Rules 1 and 9: superseded by the printed label 'Risks that were present on or near the treatment site.' (PDF p3); '(Checkboxes + Runtime User Input Addition)' is expressed as checks with extensible: true",
    },
    {
      text: '[User Extensible Text Input: Add dynamic item]',
      cite: 'service-report-spec.md:90',
      reason: "Control descriptor, not form text: expressed as extensible: true on risks, riskActions and housekeeping (spec.md:90, 98, 119)",
    },
    {
      text: 'Action Taken to Eliminate Risk (Checkboxes + Runtime User Input Addition)',
      cite: 'service-report-spec.md:92',
      reason: "Rule 1: superseded by the printed label 'Action taken to eliminate any risk was' (submitted.md:60, PDF p3); extensible checks",
    },
    {
      text: 'Safety Compliance Toggles (Yes / No Toggles)',
      cite: 'service-report-spec.md:100',
      reason: "Rule 3: superseded by the as-submitted sub-heading 'Safety & Compliance Checklists' (submitted.md:66); '(Yes / No Toggles)' is the control type",
    },
    {
      text: 'Additional action taken to eliminate any risk was: Text area input',
      cite: 'service-report-spec.md:107',
      reason: "Label plus control descriptor: the label 'Additional action taken to eliminate any risk was' is used (submitted.md:73); 'Text area input' sets kind 'area' (rule 2)",
    },
    {
      text: 'Is it safe to commence work?: Yes / No toggle (Mandatory gate)',
      cite: 'service-report-spec.md:108',
      reason: "Label plus control descriptor: the label 'Is it safe to commence work?' is used (submitted.md:74, PDF p3); kind 'toggle', required: true",
    },
    {
      text: '4. Technician Recommendations & Sign-Off',
      cite: 'service-report-spec.md:112',
      reason: "Rule 7: the builder shows \"4. TECHNICIAN'S RECOMMENDATIONS & COMMENTS\" (submitted.md:78); the PDF prints \"Technician's Recommendations\"",
    },
    {
      text: 'Housekeeping Recommendations (Checkboxes + Runtime User Input Addition)',
      cite: 'service-report-spec.md:114',
      reason: "Rule 1: superseded by the printed label 'House Keeping & Cleaning Recommendations to Help eliminate General Pests' (submitted.md:80, PDF p4); extensible checks",
    },
    {
      text: 'Freeform & Select Inputs',
      cite: 'service-report-spec.md:121',
      reason: 'Data-dictionary grouping heading; appears on neither the form nor the PDF',
    },
    {
      text: 'Treatment Limitations: Multi-line text input',
      cite: 'service-report-spec.md:122',
      reason: "Label plus control descriptor: the label 'Treatment Limitations' is used (submitted.md:85); kind 'area'",
    },
    {
      text: "Technician's Comments: Multi-line text input",
      cite: 'service-report-spec.md:123',
      reason: "Label plus control descriptor: the label \"Technician's Comments\" is used; kind 'area'",
    },
    {
      text: 'Next Visit Due In: Dropdown menu (`1 Week`, `2 Weeks`, `3 Weeks`, `35 Days`, `1 Month`, `2 Months`, `3 Months`, `3-6 Months`, `6 Months`, `10 Months`, `12 Months`, `6-12 Months`)',
      cite: 'service-report-spec.md:124',
      reason: "Rule 3: label superseded by the as-submitted 'Your Next Pest Control Visit is due in' (submitted.md:87); 'Dropdown menu' sets kind 'select'; the twelve backticked options are used verbatim (rule 2)",
    },
    {
      text: 'Technician Name / License: Radio selector (`Terence Van Der Walt (Licence 11132)`, `Kevin Edgar (Licence 4132)`)',
      cite: 'service-report-spec.md:125',
      reason: "Rule 1: label superseded by \"Technician's Name\" (PDF p4); the two names are roster data — kind 'member' prints Name (Licence N) from memberships",
    },
    {
      text: 'Technician Signature: Touch/Mouse signature canvas pad',
      cite: 'service-report-spec.md:126',
      reason: "Rule 3: superseded by the as-submitted label \"Technician's Signature\" (submitted.md:89); kind 'signature'",
    },
    {
      text: 'Customer Signature: Touch/Mouse signature canvas pad',
      cite: 'service-report-spec.md:127',
      reason: "Rules 1 and 3: superseded by the label 'Signature' (submitted.md:90, PDF p4); kind 'signature', role client",
    },
    {
      text: 'Add Photos?: Toggle (`Yes` / `No`)',
      cite: 'service-report-spec.md:128',
      reason: "Label plus control descriptor: the label 'Add Photos?' is used (submitted.md:91); kind 'toggle'",
    },
    {
      text: 'Email Report To: Email input field (Triggers automated PDF dispatch)',
      cite: 'service-report-spec.md:129',
      reason: "Label plus control descriptor: the label 'Email Report To' is used (submitted.md:93); kind 'emails'",
    },
    {
      text: '5. Embedded Legal Notices & Expectations (Static Text)',
      cite: 'service-report-spec.md:133',
      reason: 'Rule 4: the warranty pages are the PDF pages 6-7 (`terms`), which print no heading',
    },
    {
      text: 'Standard Warranty Guidelines',
      cite: 'service-report-spec.md:135',
      reason: 'Rule 4: paraphrase heading; the PDF (p6) prints no such heading',
    },
    {
      text: 'All Australian Chemicals have a **3 Month Warranty** when sprayed.',
      cite: 'service-report-spec.md:136',
      reason: "Rule 4: paraphrase of 'Please Note All Australian Chemicals have a 3 Month Warranty when Sprayed' (PDF p6)",
    },
    {
      text: 'Effective duration ranges from **6 to 12 months** based on environmental conditions.',
      cite: 'service-report-spec.md:137',
      reason: "Rule 4: paraphrase of 'The Value if sprayed correctly will be 6-12 months depending on any conducive conditions' (PDF p6)",
    },
    {
      text: '6-Week Flush-Out Period',
      cite: 'service-report-spec.md:138',
      reason: "Rule 4: paraphrase of '6 WEEKS FLUSH OUT PERIOD' (PDF p6)",
    },
    {
      text: 'Pests will flush out and die upon contact with treated surfaces for up to 6 weeks.',
      cite: 'service-report-spec.md:138',
      reason: "Rule 4: paraphrase of 'Pests will be flushed out and will continue to be flushed out for up to 6 weeks.' (PDF p6)",
    },
    {
      text: '1 Month post-treatment: ~2 days to die after contact',
      cite: 'service-report-spec.md:139',
      reason: "Rule 4: paraphrase of '1 Month up to 2 Days estimate to Die' (PDF p6)",
    },
    {
      text: '2 Months post-treatment: ~4–6 days to die after contact',
      cite: 'service-report-spec.md:140',
      reason: "Rule 4: paraphrase of '2 Months up to 4-6 Days estimate to Die' (PDF p6)",
    },
    {
      text: '3 Months post-treatment: ~6–8 days to die after contact',
      cite: 'service-report-spec.md:141',
      reason: "Rule 4: paraphrase of '3 Months up to 6-8 Days estimate to Die' (PDF p6)",
    },
    {
      text: 'Pest Wait Times & Expectations',
      cite: 'service-report-spec.md:143',
      reason: "Rule 4: paraphrase of 'Pest Treatment, Wait Time, Expectations' (PDF p6, space corrected)",
    },
    {
      text: 'General Pests (6 Weeks)',
      cite: 'service-report-spec.md:144',
      reason: "Rule 4: paraphrase of 'Large cockroaches, webbing spiders, red back spiders, carpet beetles, silverfish, creamy coloured crickets, any existing wasp nests' + '6 Weeks' (PDF p6)",
    },
    {
      text: 'Includes cockroaches, webbing spiders, redbacks, carpet beetles, silverfish, crickets, wasp nests. Insects must touch surface; does not work by odor.',
      cite: 'service-report-spec.md:144',
      reason: 'Rule 4: paraphrase of the four bullets under the large cockroaches group (PDF p6)',
    },
    {
      text: 'German Cockroaches (6 Weeks)',
      cite: 'service-report-spec.md:145',
      reason: "Rule 4: paraphrase of 'German Cockroaches' + '6 Weeks' (PDF p6)",
    },
    {
      text: '70–80% reduction in Week 1. Total elimination by Week 6.',
      cite: 'service-report-spec.md:145',
      reason: 'Rule 4: paraphrase of the three German Cockroaches bullets (PDF p6)',
    },
    {
      text: 'Spiders (6 Weeks)',
      cite: 'service-report-spec.md:146',
      reason: "Rule 4: paraphrase of 'Spiders' + '6 weeks' (PDF p6)",
    },
    {
      text: '80–90% reduction around windows; 90–100% reduction for Red Backs.',
      cite: 'service-report-spec.md:146',
      reason: 'Rule 4: paraphrase of the five Spiders bullets (PDF p6)',
    },
    {
      text: 'Ants (6 Weeks)',
      cite: 'service-report-spec.md:147',
      reason: "Rule 4: paraphrase of 'Ants' + '6 Weeks' (PDF p7)",
    },
    {
      text: 'Activity expected up to 3 weeks while bait is transferred back to colony.',
      cite: 'service-report-spec.md:147',
      reason: 'Rule 4: paraphrase of the four Ants bullets (PDF p7)',
    },
    {
      text: 'Rats / Mice (4 Weeks)',
      cite: 'service-report-spec.md:148',
      reason: "Rule 4: paraphrase of 'Rats/Mice' + '4 Weeks' (PDF p7)",
    },
    {
      text: 'Initial activity increase due to bait attraction. Roof noises subside over 3–4 weeks. Do not seal entries until resolved.',
      cite: 'service-report-spec.md:148',
      reason: 'Rule 4: paraphrase of the five Rats/Mice bullets (PDF p7)',
    },
    {
      text: 'Fleas (3–4 Weeks)',
      cite: 'service-report-spec.md:149',
      reason: "Rule 4: paraphrase of 'Fleas' + '3-4 Weeks' (PDF p7)",
    },
    {
      text: 'Daily vacuuming required to stimulate hatching; repeat treatment may be needed.',
      cite: 'service-report-spec.md:149',
      reason: 'Rule 4: paraphrase of the three Fleas bullets (PDF p7)',
    },

    // --- service-report-submitted.md -------------------------------------------------------
    {
      text: 'Form Header & Operational Metadata',
      cite: 'service-report-submitted.md:7',
      reason: "The markdown export's own grouping heading; not on the form or the PDF",
    },
    {
      text: 'Pest M8 Service Report for 2026',
      cite: 'service-report-submitted.md:10',
      reason: "Record data printed from context: the title band and footer compose '{brand} Service Report for {year}' from the business and the service date (plan §4.7); print.formName carries 'Service Report'",
    },
    {
      text: '12 Example Street Leda 6170 Western Australia Australia',
      cite: 'service-report-submitted.md:20',
      reason: "Record data printed from context (redacted sample answer): 'Site Address' is kind 'derived' from property.address",
    },
    {
      text: 'Latitude',
      cite: 'service-report-submitted.md:22',
      reason: "GPS value presentation, not a template label: kind 'gps' format 'lines' prints the Lat:/Lng:/Alt: lines (PDF p2)",
    },
    {
      text: '-32.000000000000000',
      cite: 'service-report-submitted.md:22',
      reason: 'Record data (redacted sample GPS answer)',
    },
    {
      text: 'Longitude',
      cite: 'service-report-submitted.md:23',
      reason: "GPS value presentation, not a template label: kind 'gps' format 'lines'",
    },
    {
      text: '115.000000000000000',
      cite: 'service-report-submitted.md:23',
      reason: 'Record data (redacted sample GPS answer)',
    },
    {
      text: 'Altitude',
      cite: 'service-report-submitted.md:24',
      reason: "GPS value presentation, not a template label: kind 'gps' format 'lines'",
    },
    {
      text: '35.000000000000000',
      cite: 'service-report-submitted.md:24',
      reason: 'Record data (redacted sample GPS answer)',
    },
    {
      text: 'click or drop to add photos here',
      cite: 'service-report-submitted.md:25',
      reason: "Form chrome: the Formitize dropzone widget's own prompt, not the business's wording",
    },
    {
      text: '0400 000 000',
      cite: 'service-report-submitted.md:26',
      reason: "Record data printed from context (redacted sample): 'Client Phone:' is derived from client.phone",
    },
    {
      text: 'client@example.com',
      cite: 'service-report-submitted.md:27',
      reason: "Record data printed from context (redacted sample): 'Client Email' is derived from client.email",
    },
    {
      text: '10:25 AM',
      cite: 'service-report-submitted.md:29',
      reason: 'Record data (sample Start Time answer)',
    },
    {
      text: '11:10 AM',
      cite: 'service-report-submitted.md:30',
      reason: 'Record data (sample Finish Time answer)',
    },
    {
      text: 'Weather Details / Weather on the Day (Checkboxes / Radio)',
      cite: 'service-report-submitted.md:31',
      reason: "The export joins a sub-heading and a label with a control hint: split into the heading 'Weather Details' (PDF p2) and the label 'Weather on the Day'; multi-select per rule 2",
    },
    {
      text: 'Risks that were present on or near the treatment site',
      cite: 'service-report-submitted.md:53',
      reason: "Rule 9: superseded by the PDF's 'Risks that were present on or near the treatment site.' (p3), which keeps its full stop",
    },
    {
      text: 'Just a reminder about the cans in the garage ( cockroaches) and the trees that’s touching the roof ( rodents)',
      cite: 'service-report-submitted.md:86',
      reason: "Record data (sample Technician's Comments answer)",
    },
    {
      text: "Technician's Name (Selection)",
      cite: 'service-report-submitted.md:88',
      reason: "Rule 1: superseded by the printed label \"Technician's Name\" (PDF p4); '(Selection)' is the export's control hint",
    },
    {
      text: 'Terence Van Der Walt (Licence 11132)',
      cite: 'service-report-submitted.md:88',
      reason: "Roster data, not template options: kind 'member' prints Name (Licence N) from the business's memberships",
    },
    {
      text: 'Kevin Edgar (Licence 4132)',
      cite: 'service-report-submitted.md:88',
      reason: "Roster data, not template options: kind 'member' prints Name (Licence N) from the business's memberships",
    },
    {
      text: 'Re-sign signature or re-sign with stamp',
      cite: 'service-report-submitted.md:89',
      reason: "Form chrome: Formitize's signature-pad widget prompt",
    },
    {
      text: '1/1',
      cite: 'service-report-submitted.md:92',
      reason: "Form chrome: the Formitize dropzone's photo counter",
    },
    {
      text: '5. WARRANTY, EXPECTATIONS & AFTERCARE ADVICE',
      cite: 'service-report-submitted.md:97',
      reason: 'Rule 4: the warranty pages (PDF p6-7, `terms`) print no heading; this is the export\'s paraphrase framing',
    },
    {
      text: 'Chemical Warranty & Flush-Out Guidelines',
      cite: 'service-report-submitted.md:99',
      reason: 'Rule 4: paraphrase heading; the PDF (p6) prints none',
    },
    {
      text: 'Standard Warranty',
      cite: 'service-report-submitted.md:100',
      reason: 'Rule 4: paraphrase lead-in; the PDF (p6) prints none',
    },
    {
      text: 'All Australian Chemicals have a 3 Month Warranty when Sprayed.',
      cite: 'service-report-submitted.md:100',
      reason: "Rule 4: superseded by 'Please Note All Australian Chemicals have a 3 Month Warranty when Sprayed' (PDF p6)",
    },
    {
      text: 'Effective Duration',
      cite: 'service-report-submitted.md:101',
      reason: 'Rule 4: paraphrase lead-in; the PDF (p6) prints none',
    },
    {
      text: 'The value if sprayed correctly will be 6–12 months depending on any conducive conditions.',
      cite: 'service-report-submitted.md:101',
      reason: "Rule 4: superseded by 'The Value if sprayed correctly will be 6-12 months depending on any conducive conditions' (PDF p6)",
    },
    {
      text: 'Flush Out Period',
      cite: 'service-report-submitted.md:102',
      reason: "Rule 4: superseded by '6 WEEKS FLUSH OUT PERIOD' (PDF p6)",
    },
    {
      text: 'Please allow 6 weeks for your treatment to work.',
      cite: 'service-report-submitted.md:102',
      reason: "Rule 4: superseded by 'PLEASE GIVE IT 6 WEEKS FOR YOUR TREATMENT TO WORK' (PDF p6)",
    },
    {
      text: 'Living across or next to bushland will result in more insects regularly as they get blown in by the wind.',
      cite: 'service-report-submitted.md:104',
      reason: "Rule 4: superseded by 'Living Across or next to bushland will give you more insects more regularly as they get blown in by the wind etc.' (PDF p6)",
    },
    {
      text: 'Insects will still be affected by the applied chemicals and die when they make contact with the insecticide.',
      cite: 'service-report-submitted.md:105',
      reason: "Rule 4: superseded by 'The insects will still be affected by the applied chemicals and Die when they make contact with the insecticide.' (PDF p6)",
    },
    {
      text: 'Pests must come into contact with the insecticide for them to die (insecticides do not work by smell).',
      cite: 'service-report-submitted.md:106',
      reason: "Rule 4: superseded by 'Pests have to come into Contact with the insecticide for them to die,' (PDF p6)",
    },
    {
      text: 'Estimated Time to Die After Contact',
      cite: 'service-report-submitted.md:108',
      reason: 'Rule 4: paraphrase heading; the PDF (p6) prints none',
    },
    {
      text: '1 Month Post-Treatment',
      cite: 'service-report-submitted.md:109',
      reason: "Rule 4: superseded by '1 Month up to 2 Days estimate to Die' (PDF p6)",
    },
    {
      text: '2 Months Post-Treatment',
      cite: 'service-report-submitted.md:110',
      reason: "Rule 4: superseded by '2 Months up to 4-6 Days estimate to Die' (PDF p6)",
    },
    {
      text: '3 Months Post-Treatment',
      cite: 'service-report-submitted.md:111',
      reason: "Rule 4: superseded by '3 Months up to 6-8 Days estimate to Die' (PDF p6)",
    },
    {
      text: 'Pest Treatment, Wait Time & Expectations Table',
      cite: 'service-report-submitted.md:113',
      reason: "Rule 4: superseded by 'Pest Treatment, Wait Time, Expectations' (PDF p6, space corrected)",
    },
    {
      text: 'Treatment Expectations & Details',
      cite: 'service-report-submitted.md:115',
      reason: "Rule 4: the export's table column header; the PDF (p6-7) prints headed bullet groups, not a table",
    },
    {
      text: 'Large Cockroaches, Webbing Spiders, Redback Spiders, Carpet Beetles, Silverfish, Creamy Coloured Crickets, Existing Wasp Nests',
      cite: 'service-report-submitted.md:117',
      reason: "Rule 4: superseded by 'Large cockroaches, webbing spiders, red back spiders, carpet beetles, silverfish, creamy coloured crickets, any existing wasp nests' (PDF p6)",
    },
    {
      text: 'Cockroaches will be flushed out and continue to be flushed out for up to 6 weeks. If you receive regular yearly treatments, pests will die all year round. You might notice cockroaches and other pests walking slowly. Insects must make contact with the chemical to die.',
      cite: 'service-report-submitted.md:117',
      reason: 'Rule 4: paraphrase of the four bullets under the large cockroaches group (PDF p6)',
    },
    {
      text: 'Expect a 70–80% reduction in the first week. All should be gone within 6 weeks. Severe infestations may require 2 treatments.',
      cite: 'service-report-submitted.md:118',
      reason: 'Rule 4: paraphrase of the three German Cockroaches bullets (PDF p6)',
    },
    {
      text: 'Spiders will be flushed out. Spiders around windows reduced by 80–90%. Redbacks reduced by 90–100% depending on initial severity. For severe redback issues, a follow-up external treatment after 3 months is recommended. Properties near bushy areas or trees will not reach 100% elimination.',
      cite: 'service-report-submitted.md:119',
      reason: 'Rule 4: paraphrase of the five Spiders bullets (PDF p6)',
    },
    {
      text: 'Common to continue seeing ants up to 3 weeks post-treatment as they carry insecticide back to the nest. Use ant bait as instructed by the technician. Scattered or dying ants indicate treatment is working.',
      cite: 'service-report-submitted.md:120',
      reason: 'Rule 4: paraphrase of the four Ants bullets (PDF p7)',
    },
    {
      text: 'Rats / Mice',
      cite: 'service-report-submitted.md:121',
      reason: "Rule 4: superseded by 'Rats/Mice' (PDF p7)",
    },
    {
      text: 'Increased rodent activity is common initially as they are attracted to the bait. You may hear rodents moving or dragging bait blocks in the roof void; activity subsides over 3–4 weeks. Do not seal entrance/exit points until infestation is controlled.',
      cite: 'service-report-submitted.md:121',
      reason: 'Rule 4: paraphrase of the five Rats/Mice bullets (PDF p7)',
    },
    {
      text: 'Second treatments may be required. Vacuum daily starting the day after treatment to stimulate egg hatching and pupae release. You may continue to see fleas and receive bites for up to 3 weeks.',
      cite: 'service-report-submitted.md:122',
      reason: 'Rule 4: paraphrase of the three Fleas bullets (PDF p7)',
    },

    // --- service-report-printed.pdf: record data in the sample ------------------------------
    {
      text: '28 Aug 2026',
      cite: 'service-report-printed.pdf:p2',
      reason: "Record data (sample 'Date:' answer and title-band date)",
    },
    {
      text: 'J. Sample',
      cite: 'service-report-printed.pdf:p2',
      reason: "Record data printed from context (redacted): 'Client Name' is derived from client.name",
    },
    {
      text: 'Lat: -32.000000 Lng: 115.000000 Alt: 35.000000',
      cite: 'service-report-printed.pdf:p2',
      reason: "Record data (redacted sample GPS), presented by kind 'gps' format 'lines'",
    },
    {
      text: '10:25 am',
      cite: 'service-report-printed.pdf:p2',
      reason: 'Record data (sample Start Time answer)',
    },
    {
      text: '11:10 am',
      cite: 'service-report-printed.pdf:p2',
      reason: 'Record data (sample Finish Time answer)',
    },
    {
      text: 'Biflex Ultra (100 g/L Bifenthrin), Sumilarv IGR (20 g/L PYRIPROXYFEN ), Stardust Pro (20 g/kg Permethrin 40:60 5 g/kg Triflumuron)',
      cite: 'service-report-printed.pdf:p3',
      reason: 'Record data: one submitted treatment row, comma-joined by the vendor (layout decision: one value per line); each value is a product option',
    },
    {
      text: '100ml/10L, 1-5 grams',
      cite: 'service-report-printed.pdf:p3',
      reason: 'Record data: one submitted treatment row, comma-joined; each value is a quantity option',
    },
    {
      text: 'Hand Held Battery Operated Sprayer, Hand Compression Sprayer, Dusting with Blower in Roof Space',
      cite: 'service-report-printed.pdf:p3',
      reason: 'Record data: one submitted treatment row, comma-joined; each value is a method option',
    },
    {
      text: "Just a reminder about the cans in the garage ( cockroaches) and the trees that's touching the roof ( rodents)",
      cite: 'service-report-printed.pdf:p4',
      reason: "Record data (sample Technician's Comments answer)",
    },
  ],

  validationNotes: [
    "Technician's Signature is required to finalise. The source form does not require it; owner-relaxable later through template settings.",
    'Treatments grid has no minimum (min 0), so an inspection-only visit finalises. A row with some but not all of Treatment, Product & Active Ingredient, Quantity of Chemicals Used and Chemical Application Method answered is invalid; an entirely empty row is valid and discarded on save.',
    "'Date:' is required.",
    "'Weather on the Day' is multi-select (checks) per the spec (rule 2), although the sample PDF happened to print one value and the as-submitted export said 'Checkboxes / Radio'.",
    "'Is it safe to commence work?' is required: the form's own mandatory gate (spec.md:108). Either answer finalises — a job stopped as unsafe must be recordable.",
    "'Additional action taken to eliminate any risk was' is a multi-line area per the spec's 'Text area input' (rule 2); the as-submitted export described it as single-line.",
    "'Report Photos' shows only while 'Add Photos?' is Yes, as on the source form.",
    "The warning under 'Email Report To' is shown on screen only (printed: false); it instructs the technician and the client never needs it.",
    "'Email Report To' accepts a v1 draft's single string as well as a list, so a v1 draft switching to v2 keeps its answer.",
    'A suggestion the app made (forecast weather, a scheduled start time, answers copied from the last visit) must be confirmed before finalising — enforced by the engine, not by this schema (fidelity.md Validation).',
  ],
}
