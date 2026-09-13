import { z } from 'zod'
import { CERTIFICATE_TERMS } from './terms/certificateTerms'
import type { Option, RichDoc, ReportTemplate } from './types'

/**
 * Pest M8 Pest Control Timber Pest Inspection Report (AS 4349.3-2010) — Warranty,
 * reproduced word for word (version 2).
 *
 * Source: docs/sources/timber-pest-inspection.md (Formitize form 24915944). It is
 * the only source for this form (docs/reports/fidelity.md precedence rule 5), so
 * every heading, label, option and printed paragraph below is that file's text.
 * Corpus: src/lib/reportTemplates/spec/timberPestInspection.generated.ts.
 *
 * Precedence rules applied:
 * - Rule 5: one markdown source, used for everything.
 * - Rule 1 (by analogy, no PDF exists for this form): the markdown's `**Label:**`
 *   trailing colons are markdown formatting, not wording, so labels carry none —
 *   except where the colon is inside the sentence the form prints (`...every:`).
 * - Rule 7: the builder shows `1. CLIENT DETAILS`; the document prints the same
 *   numbered heading (`print.numbering: 'numbered'`), so no `print.heading`.
 * - Rule 8: unanswered fields are omitted from the printed document.
 *
 * Corrections applied: none. fidelity.md lists no correction for this form, and
 * every string below is verbatim, including the flagged ones.
 *
 * Decisions recorded in fidelity.md and applied here:
 * - The `Terms and Conditions Toggle` (a Formitize screen artefact) is dropped;
 *   terms always print, and until the owner exports the Formitize form 24915944
 *   terms body, the Certificate's §9 terms print as an interim (`terms`).
 * - The §7 guidance column prints only when that row's condition is flagged.
 *
 * For the owner to decide (also returned as open questions):
 * - Every `// FLAG:` below (fidelity.md "Kept verbatim, flagged for the owner"),
 *   above all the §9 acceptance statement, which has the client agree "that the
 *   Property is free of Timber Pests". Raise before it prints under a signature.
 * - The interim terms.
 * - Which answers of `Slab Edge Exposure` and `Weep Holes` mean a problem.
 */

/** Free text is the value, so it prints as itself on the finished record. */
const asOptions = (values: Array<string>): Array<Option> =>
  values.map((value) => ({ value, label: value }))

/** Plain printed paragraphs. The source carries no emphasis, so no marks. */
const doc = (...paragraphs: Array<string>): RichDoc => ({
  type: 'doc',
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  })),
})

// --- Answer scales used by more than one question (all inline: AS-referenced) --

// src: timber-pest-inspection.md:169, :179, :213
const YES_NO = asOptions(['Yes', 'No'])
// src: timber-pest-inspection.md:31
const YES_NO_NA = asOptions(['Yes', 'No', 'N/A'])
// src: timber-pest-inspection.md:83-85
const SEE_SECTION_5 = asOptions([
  'Yes, see Section 5',
  'No, read report in full',
])
// src: timber-pest-inspection.md:86-91
const SEE_SECTION_6 = asOptions([
  'Yes, see Section 6',
  'No, read report in full',
])
// src: timber-pest-inspection.md:216, :217, :219, :221
const ADEQUATE_INADEQUATE_NA = asOptions(['Adequate', 'Inadequate', 'N/A'])

export const timberPestInspection: ReportTemplate = {
  id: 'timberPestInspection',
  version: 2,
  name: 'Timber Pest Inspection',
  shortName: 'Inspection',
  legalBasis: 'AS 4349.3-2010',
  blurb:
    'The 12-monthly warranty timber pest inspection: summary, property, access, findings and conducive conditions.',
  fields: [],
  sections: [
    // ---------------------------------------------------------------------------
    // Header block. Its two heading lines and the standards line print from
    // `print`; this section exists for the one control the header carries.
    // ---------------------------------------------------------------------------
    {
      id: 'header',
      // src: timber-pest-inspection.md:11
      title: 'TIMBER PEST WARRANTY INSPECTION',
      // The header lines already print above the first section.
      print: { heading: null },
      fields: [
        {
          // src: timber-pest-inspection.md:13-22
          kind: 'checks',
          key: 'inspectionTypeWarranty',
          label: 'Inspection Type Warranty',
          // src: timber-pest-inspection.md:14-22
          options: asOptions([
            '12 Monthly Timber Pest Visual Inspection to maintain Warranty',
            'Year 1',
            'Year 2',
            'Year 3',
            'Year 4',
            'Year 5',
            'Year 6',
            'Year 7',
            'Year 8',
          ]),
          // src: timber-pest-inspection.md:14 — `[x]`, pre-ticked: it is what this document IS.
          locked: [
            '12 Monthly Timber Pest Visual Inspection to maintain Warranty',
          ],
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:27
    // ---------------------------------------------------------------------------
    {
      id: 'clientDetails',
      number: 1,
      title: 'CLIENT DETAILS',
      // src: timber-pest-inspection.md:29
      // FLAG: "for who" — "for whom"; the Certificate says "whom".
      preamble:
        'The Client is the person or entity for who the inspection is being undertaken.',
      fields: [
        {
          // src: timber-pest-inspection.md:31
          kind: 'radio',
          key: 'clientAgreesToInspection',
          label: 'Client Agrees that an inspection can be completed',
          options: YES_NO_NA, // src: timber-pest-inspection.md:31
        },
        {
          // src: timber-pest-inspection.md:32
          kind: 'derived',
          key: 'clientName',
          label: 'Client Name',
          source: 'client.name',
        },
        {
          // src: timber-pest-inspection.md:33
          kind: 'derived',
          key: 'clientAddress',
          label: 'Client Address',
          source: 'client.address',
          format: 'address',
        },
        {
          // src: timber-pest-inspection.md:34
          kind: 'derived',
          key: 'clientPhone',
          label: 'Client Phone',
          source: 'client.phone',
        },
        {
          // src: timber-pest-inspection.md:35
          kind: 'derived',
          key: 'clientEmail',
          label: 'Client Email',
          source: 'client.email',
        },
        {
          // src: timber-pest-inspection.md:36
          kind: 'toggle',
          key: 'sendCopyToClient',
          // Drives delivery, never printed — as the same vendor's Service Report
          // PDF shows for its identical control.
          printed: false,
          label:
            'Send a copy of the Report to the email address above when you submit this form?',
        },
        {
          // src: timber-pest-inspection.md:37
          kind: 'derived',
          key: 'propertyInspectedAddress',
          label: 'Property Inspected Address',
          source: 'property.address',
          format: 'address',
        },
        {
          // src: timber-pest-inspection.md:38 — "Date picker (Default: Current Date)"
          kind: 'date',
          key: 'inspectionDate',
          label: 'Inspection Date',
          defaultToday: true,
          required: true,
        },
        {
          // src: timber-pest-inspection.md:39
          kind: 'time',
          key: 'inspectionTime',
          label: 'Inspection Time',
        },
        {
          // src: timber-pest-inspection.md:40
          kind: 'note',
          key: 'recommendationNotice',
          label: 'Recommendation notice',
          body: doc(
            'It is highly recommended that the Property be re-inspected if this Report is being considered more than thirty days after the Inspection Date.',
          ),
        },
        {
          // src: timber-pest-inspection.md:41-50
          kind: 'checks',
          key: 'peoplePresent',
          label: 'People present at the time of Inspection',
          optionsFrom: 'peoplePresent',
          // src: timber-pest-inspection.md:42-50
          options: asOptions([
            'Vendor',
            'Client',
            'Purchaser',
            'Real Estate Agent',
            'Technician',
            // FLAG: "Client Gave Access away at time of Inspection"
            'Client Gave Access away at time of Inspection',
            'House Empty access given',
            'Building Inspector',
            'Seller',
          ]),
        },
        {
          // src: timber-pest-inspection.md:51-58 — "Radio buttons": one answer
          kind: 'radio',
          key: 'weatherConditions',
          label: 'Weather Conditions at time of inspection',
          // src: timber-pest-inspection.md:52-58
          options: asOptions([
            'Dry',
            'Prolonged Dry Period',
            'Wet',
            'Prolonged Wet Period',
            'Overcast',
            'Windy',
            'Sunny',
          ]),
        },
        {
          // src: timber-pest-inspection.md:59
          kind: 'note',
          key: 'largePropertyClause',
          label: 'Large property clause',
          // FLAG: "thirty (30) meters" — US spelling in an Australian standard document.
          body: doc(
            'On a large Property (as reasonably determined by the Inspection Provider), the part of the Property subject to the Inspection will be thirty (30) meters from the main building (as nominated by the Client).',
          ),
        },
        {
          // src: timber-pest-inspection.md:60
          kind: 'note',
          key: 'strataPropertiesClause',
          label: 'Strata properties clause',
          body: doc(
            'If the Inspection relates to a Property that is part of any kind of strata or company title, the Inspection will be limited to the interior of the nominated residence/unit and the immediate exterior of the building/features being Inspected. The Inspection will not include any of the common areas, any areas not owned by the Client, or documents or records related to the body corporate of the Property.',
          ),
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:64
    // ---------------------------------------------------------------------------
    {
      id: 'aboutOurAgreement',
      number: 2,
      title: 'ABOUT OUR AGREEMENT',
      fields: [
        {
          // src: timber-pest-inspection.md:66 — a fixed value. Its label is given two
          // ways ("Inspection Requested / Inspection Type requested"), so which one
          // the form prints is an open question; the value prints on its own.
          kind: 'note',
          key: 'inspectionRequested',
          label: 'Inspection requested',
          body: doc(
            'Visual Timber Pest Inspection In accordance with AS4349.3-2010',
          ),
        },
        {
          // src: timber-pest-inspection.md:67
          kind: 'note',
          key: 'agreementDetailsNote',
          label: 'Agreement details note',
          body: doc(
            'This Report has been prepared in accordance with the Agreement detailed below (and attached to this Report) and with Australian Standard AS4349.3-2010 that sets a minimum standard for the Inspection.',
          ),
        },
        {
          // src: timber-pest-inspection.md:68
          kind: 'date',
          key: 'agreementDate',
          label: 'Agreement Date',
        },
        {
          // src: timber-pest-inspection.md:69
          kind: 'note',
          key: 'inspectionProviderDetailsNote',
          label: 'Inspection provider note',
          body: doc(
            'The Inspection Provider is the legal entity responsible for the Inspection and issuing the Report.',
          ),
        },
        {
          // src: timber-pest-inspection.md:70 — value `Pest M8 South` is the trading name.
          // Label dropped by the extractor's META_VALUE_LABEL; verbatim from the source.
          kind: 'derived',
          key: 'inspectionProviderName',
          label: 'Name (hereafter "Inspection Provider")',
          source: 'business.tradingName',
        },
        {
          // src: timber-pest-inspection.md:71
          kind: 'derived',
          key: 'inspectionProviderAddress',
          label: 'Address',
          source: 'business.address',
          format: 'address',
        },
        {
          // src: timber-pest-inspection.md:72 — value `+611800737868`
          kind: 'derived',
          key: 'inspectionProviderPhone',
          label: 'Phone',
          source: 'business.phone',
        },
        {
          // src: timber-pest-inspection.md:73 — value `info@pestm8.com.au`
          kind: 'derived',
          key: 'inspectionProviderEmail',
          label: 'Email',
          source: 'business.email',
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:77
    // ---------------------------------------------------------------------------
    {
      id: 'inspectionSummary',
      number: 3,
      title: 'INSPECTION SUMMARY',
      // src: timber-pest-inspection.md:79
      preamble:
        'It is very important to note that the following is a Summary only and must be read together with the entire Report. There are Limitations, Notes, Terms and Conditions that must be read, understood and acknowledged as part of the entire Report that is not included in this Summary. If any discrepancy exists between this Summary and the main Report, the main Report will prevail in terms of that inconsistency.',
      fields: [
        {
          // src: timber-pest-inspection.md:83
          kind: 'radio',
          key: 'summaryHinderedAccess',
          label:
            'Are there any areas that were hindered and access should be gained?',
          options: SEE_SECTION_5, // src: timber-pest-inspection.md:83
        },
        {
          // src: timber-pest-inspection.md:84
          kind: 'radio',
          key: 'summaryRestrictedAccess',
          label:
            'Are there any areas that were restricted and access should be gained?',
          options: SEE_SECTION_5, // src: timber-pest-inspection.md:84
        },
        {
          // src: timber-pest-inspection.md:85
          kind: 'radio',
          key: 'summaryHighRiskAreas',
          label:
            'Are there any areas that are High Risk and access should be gained?',
          options: SEE_SECTION_5, // src: timber-pest-inspection.md:85
        },
        {
          // src: timber-pest-inspection.md:86
          kind: 'radio',
          key: 'summaryActiveTermites',
          label: 'Were active termites found?',
          options: SEE_SECTION_6, // src: timber-pest-inspection.md:86
        },
        {
          // src: timber-pest-inspection.md:87
          kind: 'radio',
          key: 'summaryTermiteNest',
          label: 'Was a termite nest located?',
          options: SEE_SECTION_6, // src: timber-pest-inspection.md:87
        },
        {
          // src: timber-pest-inspection.md:88
          kind: 'radio',
          key: 'summaryTermiteWorkings',
          label: 'Was visible evidence of termite workings or damage found?',
          options: SEE_SECTION_6, // src: timber-pest-inspection.md:88
        },
        {
          // src: timber-pest-inspection.md:89
          kind: 'radio',
          key: 'summaryBorers',
          label: 'Was visible evidence of borers of seasoned timbers found?',
          options: SEE_SECTION_6, // src: timber-pest-inspection.md:89
        },
        {
          // src: timber-pest-inspection.md:90
          kind: 'radio',
          key: 'summaryFungalDecay',
          label: 'Was visible evidence of damage caused by fungal decay?',
          options: SEE_SECTION_6, // src: timber-pest-inspection.md:90
        },
        {
          // src: timber-pest-inspection.md:91
          kind: 'radio',
          key: 'summaryFurtherInspections',
          label: 'Are further inspections recommended?',
          options: SEE_SECTION_6, // src: timber-pest-inspection.md:91
        },
        {
          // src: timber-pest-inspection.md:92
          kind: 'radio',
          key: 'summarySusceptibility',
          label:
            'In our opinion, the susceptibility of this property to timber pests is considered to be',
          // src: timber-pest-inspection.md:92
          options: asOptions([
            'HIGH, read report in full',
            'MODERATE, read report in full',
            'LOW, read report in full',
          ]),
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:96
    // ---------------------------------------------------------------------------
    {
      id: 'aboutTheProperty',
      number: 4,
      title: 'ABOUT THE PROPERTY INSPECTED',
      fields: [
        {
          // src: timber-pest-inspection.md:98
          kind: 'cover',
          key: 'propertyPhoto',
          label: 'Property Photo',
          addLabel: '1 Photo only, take in Landscape', // src: timber-pest-inspection.md:98
        },
        {
          // src: timber-pest-inspection.md:99
          kind: 'select',
          key: 'facadeFaces',
          label: 'The front facade of the dwelling faces',
          optionsFrom: 'facade',
          blankOption: '-', // src: timber-pest-inspection.md:99
          // src: timber-pest-inspection.md:99
          options: asOptions([
            'Approximately North',
            'Approximately Northeast',
            'Approximately East',
            'Approximately Southeast',
            'Approximately South',
            'Approximately Southwest',
            'Approximately West',
            'Approximately Northwest',
          ]),
        },
        {
          // src: timber-pest-inspection.md:100
          kind: 'select',
          key: 'siteTopography',
          label: 'Site Topography',
          optionsFrom: 'topography',
          blankOption: '-', // src: timber-pest-inspection.md:100
          // src: timber-pest-inspection.md:100
          options: asOptions([
            'Falls to the North',
            'Falls to the Northeast',
            'Falls to the East',
            'Falls to the Southeast',
            'Falls to the South',
            'Falls to the Southwest',
            'Falls to the West',
            'Falls to the Northwest',
          ]),
        },
        {
          // src: timber-pest-inspection.md:101
          kind: 'select',
          key: 'structureType',
          label: 'Type of Structure',
          optionsFrom: 'structureType',
          blankOption: '-', // src: timber-pest-inspection.md:101
          // src: timber-pest-inspection.md:101
          options: asOptions([
            'Detached house',
            'Apartment',
            'Unit',
            'Villa',
            'Duplex',
            'Flat',
            'Townhouse',
            'House',
            'Park Home',
          ]),
        },
        {
          // src: timber-pest-inspection.md:102
          kind: 'select',
          key: 'structureHeight',
          label: 'Height of Structure',
          optionsFrom: 'structureHeight',
          blankOption: '-', // src: timber-pest-inspection.md:102
          // src: timber-pest-inspection.md:102
          options: asOptions([
            'Single Storey',
            'Two Storey',
            'Split Level',
            'Multistorey',
          ]),
        },
        {
          // src: timber-pest-inspection.md:103
          kind: 'checks',
          key: 'wallConstruction',
          label: 'Wall Construction',
          optionsFrom: 'wallConstruction',
          // src: timber-pest-inspection.md:103 — the source lists these comma-separated
          options: asOptions([
            'Double Brick',
            'Brick Veneer',
            'Weatherboard',
            'Cladding',
            'Concrete Block',
            'Stone',
            'Timber structured walls',
          ]),
        },
        {
          // src: timber-pest-inspection.md:104
          kind: 'checks',
          key: 'floorType',
          label: 'Floor Type',
          optionsFrom: 'floorType',
          // src: timber-pest-inspection.md:104 — the source lists these comma-separated
          options: asOptions([
            'Timber Floor',
            'Concrete Slab',
            'Infill Concrete Slab',
            'Timber Flooring with Concrete Areas',
          ]),
        },
        {
          // src: timber-pest-inspection.md:105
          kind: 'note',
          key: 'concreteSlabDisclaimer',
          label: 'Concrete slab disclaimer',
          body: doc(
            'Please note that If the building, or any part thereof, includes a concrete slab, there is the possibility of a concealed termite entry and therefore a higher probability of termite attack.',
          ),
        },
        {
          // src: timber-pest-inspection.md:106
          kind: 'checks',
          key: 'roofType',
          label: 'Roof Type',
          optionsFrom: 'roofType',
          // src: timber-pest-inspection.md:106 — the source lists these comma-separated
          options: asOptions([
            'Conventional Cut Roof',
            'Trusses',
            'Steel Sheeting',
            'Terracotta Tile',
            'Cement Tile',
            'Tiled Roof',
          ]),
        },
        {
          // src: timber-pest-inspection.md:107
          kind: 'area',
          key: 'propertyComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:108-111
          kind: 'radio',
          key: 'furnishingStatus',
          label: 'Property Furnishing Status',
          // src: timber-pest-inspection.md:109-111
          options: asOptions([
            'At the time of the inspection the property was fully furnished',
            'At the time of the inspection the property was partially furnished',
            'At the time of the inspection the property was unfurnished',
          ]),
        },
        {
          // src: timber-pest-inspection.md:112-114
          kind: 'radio',
          key: 'occupancyStatus',
          label: 'Property Occupancy Status',
          // src: timber-pest-inspection.md:113-114
          options: asOptions([
            'At the time of inspection the property was occupied',
            'At the time of inspection the property was unoccupied',
          ]),
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:118
    // ---------------------------------------------------------------------------
    {
      id: 'areasUnableToInspect',
      number: 5,
      title: 'AREAS WE WERE UNABLE TO INSPECT & WHY',
      fields: [
        // src: timber-pest-inspection.md:120
        {
          kind: 'heading',
          key: 'headingHinderedAccess',
          label: 'Hindered Access',
          text: 'Hindered Access',
        },
        {
          // src: timber-pest-inspection.md:121
          kind: 'note',
          key: 'noteHinderedAccess',
          label: 'Hindered access note',
          body: doc(
            'The Inspection did not include areas that were inaccessible. Hindered access areas are areas that were not accessible at the time of inspection due to temporary obstructions.',
          ),
        },
        {
          // src: timber-pest-inspection.md:123
          kind: 'toggle',
          key: 'hinderedAccess',
          label:
            'Were there any obstructions that may conceal possible timber pest attack?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:124
          kind: 'area',
          key: 'hinderedAccessComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:125
          kind: 'note',
          key: 'hinderedAccessRiskNotice',
          label: 'Hindered access risk notice',
          body: doc(
            'It is important to note that as an inspection of the above areas was not possible at the time of the inspection, timber pest activity or damage may therefore exist in these areas.',
          ),
        },

        // src: timber-pest-inspection.md:127
        {
          kind: 'heading',
          key: 'headingRestrictedAccess',
          label: 'Restricted Access',
          text: 'Restricted Access',
        },
        {
          // src: timber-pest-inspection.md:128
          kind: 'note',
          key: 'noteRestrictedAccess',
          label: 'Restricted access note',
          body: doc(
            'The Inspection did not include areas that were inaccessible. Restricted Access areas are areas that were not accessible at the time of inspection due to permanent restriction or locked entry.',
          ),
        },
        {
          // src: timber-pest-inspection.md:130
          kind: 'toggle',
          key: 'restrictedAccess',
          label:
            'Were there any normally accessible areas that had restricted access?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:131
          kind: 'area',
          key: 'restrictedAccessComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:133
        {
          kind: 'heading',
          key: 'headingHighRiskAreas',
          label: 'High Risk Areas',
          text: 'High Risk Areas',
        },
        {
          // src: timber-pest-inspection.md:134
          kind: 'note',
          key: 'noteHighRiskAreas',
          label: 'High risk areas note',
          body: doc(
            'The Inspection did not include areas that were inaccessible. High Risk areas are areas where access was not possible at the time of the Inspection but are deemed to be of high risk for concealed Timber Pest Activity.',
          ),
        },
        {
          // src: timber-pest-inspection.md:136
          kind: 'toggle',
          key: 'highRiskAreas',
          label:
            'Were there any High Risk Area(s) to which access should be gained or fully gained?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:137
          kind: 'area',
          key: 'highRiskAreasComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:139
        {
          kind: 'heading',
          key: 'headingInvasiveInspection',
          label: 'Invasive Inspection',
          text: 'Invasive Inspection',
        },
        {
          // src: timber-pest-inspection.md:140
          kind: 'note',
          key: 'noteInvasiveInspection',
          label: 'Invasive inspection note',
          body: doc(
            'The Inspection requested is a visual, non-invasive inspection in accordance with our Agreement and the Standard and as such, has limitations that would be effectively addressed through an Invasive Inspection.',
          ),
        },
        {
          // src: timber-pest-inspection.md:142
          kind: 'toggle',
          key: 'invasiveInspectionRecommended',
          label: 'Is an Invasive Inspection recommended to this property?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:143
          kind: 'area',
          key: 'invasiveInspectionComments',
          label: 'Additional Comments',
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:147
    // ---------------------------------------------------------------------------
    {
      id: 'findingsAndObservations',
      number: 6,
      title: 'FINDINGS & OBSERVATIONS',
      // src: timber-pest-inspection.md:149
      preamble:
        'Report on the location and details of timber pest activity detected at the time of the Inspection in accordance with the Scope of the Inspection.',
      fields: [
        // src: timber-pest-inspection.md:151
        {
          kind: 'heading',
          key: 'headingActiveTermites',
          label: 'Active termites',
          text: 'Active Termites (Live Insects)',
        },
        {
          // src: timber-pest-inspection.md:152
          kind: 'toggle',
          key: 'liveTermites',
          label: 'Were live termites found at the time of the inspection?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:153
          kind: 'area',
          key: 'liveTermitesComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:155
        {
          kind: 'heading',
          key: 'headingTermiteNests',
          label: 'Termite nests',
          text: 'Termite Nest(s)',
        },
        {
          // src: timber-pest-inspection.md:156
          kind: 'note',
          key: 'noteTermiteNests',
          label: 'Termite nests note',
          body: doc(
            'Where a termite nest is located on or near the property, the risk of termite infestation is increased.',
          ),
        },
        {
          // src: timber-pest-inspection.md:158
          kind: 'toggle',
          key: 'termiteNest',
          label: 'Was a termite nest found at the time of Inspection?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:159
          kind: 'area',
          key: 'termiteNestComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:161
        {
          kind: 'heading',
          key: 'headingTermiteWorkings',
          label: 'Termite damage and workings',
          text: 'Termite Damage and/or Workings',
        },
        {
          // src: timber-pest-inspection.md:162
          kind: 'toggle',
          key: 'termiteWorkings',
          label: 'Was evidence of termite workings or damage found?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:163
          kind: 'gallery',
          key: 'termiteWorkingsPhotos',
          label: 'Pictures of Termite Damage and/or Workings',
        },
        {
          // src: timber-pest-inspection.md:164
          kind: 'text',
          key: 'termiteWorkingsPhotoComments',
          label: 'Photo Comments',
        },
        {
          // src: timber-pest-inspection.md:165
          kind: 'area',
          key: 'termiteWorkingsComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:166
          kind: 'note',
          key: 'termiteActivityDisclaimer',
          label: 'Termite activity disclaimer',
          tone: 'important',
          // FLAG: "Licenced Builder"
          body: doc(
            'IMPORTANT: If Live Termites, Termite Nests, Termite Damage or any Termite Activity has been detected at the Property, then it is highly likely that concealed termite activity and timber pest damage exists. A more invasive inspection is highly recommended to be carried out. This is outside the Scope of our Agreement for this Inspection. It is strongly recommended that the full extent of any such activity and damage be fully understood through the engagement of a Licenced Builder, Structural Engineer or appropriately qualified expert.',
          ),
        },

        // src: timber-pest-inspection.md:168
        {
          kind: 'heading',
          key: 'headingTermiteTreatment',
          label: 'Termite treatment',
          text: 'Subterranean Termite Treatment',
        },
        {
          // src: timber-pest-inspection.md:169
          kind: 'radio',
          key: 'termiteTreatmentRecommended',
          label: 'Is a termite treatment recommended?',
          options: YES_NO, // src: timber-pest-inspection.md:169
        },
        {
          // src: timber-pest-inspection.md:170
          kind: 'area',
          key: 'termiteTreatmentComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:172
        {
          kind: 'heading',
          key: 'headingPreviousTreatment',
          label: 'Previous treatment',
          text: 'Evidence of a Possible Previous Treatment',
        },
        {
          // src: timber-pest-inspection.md:173
          kind: 'toggle',
          key: 'previousTreatment',
          label:
            'Was evidence of a previous treatment located? (this may include drill holes, dusting or baiting)',
        },
        {
          // src: timber-pest-inspection.md:174
          kind: 'area',
          key: 'previousTreatmentComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:176
        {
          kind: 'heading',
          key: 'headingDurableNotice',
          label: 'Durable notice',
          text: 'Durable Notice',
        },
        {
          // src: timber-pest-inspection.md:177
          kind: 'note',
          key: 'noteDurableNotice',
          label: 'Durable notice note',
          body: doc(
            'If a Property has a history of Termite Activity, records or details related to previous action taken can be useful in determining whether the action taken was appropriate. A Notice of Application or a Durable Notice are examples of this type of record and are often located in the meter box, sub-floor joist or kitchen cupboard and provide useful information in determining future pest management.',
          ),
        },
        {
          // src: timber-pest-inspection.md:179
          kind: 'radio',
          key: 'durableNoticeFound',
          label: 'Was a durable Notice found at the time of this inspection?',
          options: YES_NO, // src: timber-pest-inspection.md:179
        },
        {
          // src: timber-pest-inspection.md:180
          kind: 'area',
          key: 'durableNoticeComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:181
          kind: 'note',
          key: 'historicalDisclaimer',
          label: 'Historical disclaimer',
          body: doc(
            'The Inspection undertaken is a visual inspection only and therefore no representations can be made with regard to work historically performed. We strongly recommend that if possible, the client requests copies of any reporting related to previous activity or treatments including related warranties and dates of actions.',
          ),
        },

        // src: timber-pest-inspection.md:183
        {
          kind: 'heading',
          key: 'headingWoodBorers',
          label: 'Wood borers',
          text: 'Wood Borers',
        },
        {
          // src: timber-pest-inspection.md:184
          kind: 'note',
          key: 'noteWoodBorers',
          label: 'Wood borers note',
          body: doc(
            'Borers are beetles that are considered a timber pest as the borer larvae live and feed within timber. If damage is identified, the Borers should be considered as active. Borer activity is often identified by the exit holes or Frass (borer dust), however there may be delays between the initial infestation and visibility of the activity, so it is possible that borer activity exists that is not visible at the time of inspection.',
          ),
        },
        {
          // src: timber-pest-inspection.md:186
          kind: 'toggle',
          key: 'borers',
          label:
            'Was visible evidence of borers found at the time of Inspection?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:187
          kind: 'gallery',
          key: 'borersPhotos',
          label: 'Photos',
        },
        {
          // src: timber-pest-inspection.md:188
          kind: 'area',
          key: 'borersComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:190
        {
          kind: 'heading',
          key: 'headingFungalDecay',
          label: 'Fungal decay',
          text: 'Fungal Decay',
        },
        {
          // src: timber-pest-inspection.md:191
          kind: 'note',
          key: 'noteFungalDecay',
          label: 'Fungal decay note',
          body: doc(
            'Fungal Decay is often found in conjunction with Timber Pest damage and early stages of decay may not be detectable visually. A very small number of species can be found in or on the surface of timber and only certain types of fungi actually damage wood. Mould fungi for example are only found on the surface of the timber but do not damage the wood. Other fungi such as Sapstain fungi consume the sapwood sugars but do not significantly impact the structural strength of the timber. Other types of rot such as Brown Cubical Rot or White Rot Fungi can cause wood to decay especially in poorly ventilated subfloor zones leading to destruction of the timber.',
          ),
        },
        {
          // src: timber-pest-inspection.md:193
          kind: 'toggle',
          key: 'fungalDecay',
          label:
            'Was evidence of Fungal Decay found at the time of the inspection?',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:194
          kind: 'gallery',
          key: 'fungalDecayPhotos',
          label: 'Photos',
        },
        {
          // src: timber-pest-inspection.md:195
          kind: 'area',
          key: 'fungalDecayComments',
          label: 'Additional Comments',
        },

        // src: timber-pest-inspection.md:197
        {
          kind: 'heading',
          key: 'headingInspectionFrequency',
          label: 'Frequency of inspections',
          text: 'Frequency of Inspections for the Detection of Termite Infestations',
        },
        {
          // src: timber-pest-inspection.md:198
          kind: 'note',
          key: 'noteInspectionFrequency',
          label: 'Frequency of inspections note',
          body: doc(
            'Timber Pest activity is a very regular occurrence in Australia and so regular monitoring and inspections are encouraged to assist in early detection and therefore help mitigate damage done. The overall risk is assessed by the Inspector at the time of Inspection taking into account variables such as the Property location, the building components and conducive conditions that are present. Risk levels are subjective and can only be used as an indicative guide. Australian Standard AS 3660.2-2017 recommends that inspections be undertaken no less than every twelve months and where the likelihood of timber pest activity is greater, the regularity should be increased. It is important to note that the Inspections themselves will not stop timber pest activity, however the sooner the activity is detected, the sooner action can be taken.',
          ),
        },
        {
          // src: timber-pest-inspection.md:200 — the printed sentence is the label; the
          // dropdown completes it.
          kind: 'select',
          key: 'inspectionFrequency',
          label:
            'Due to the degree of risk of subterranean termite infestation noted above and all other findings of this report, it is essential that a full inspection and written report in accord with AS 4349.3 or AS 3660.2-2017 is conducted at this property every:',
          blankOption: '-', // src: timber-pest-inspection.md:200
          // src: timber-pest-inspection.md:200
          options: asOptions([
            '1 month',
            '3 months',
            '6 months',
            '9 months',
            '12 months',
          ]),
        },
        {
          // src: timber-pest-inspection.md:201
          kind: 'radio',
          key: 'susceptibilityRating',
          label: 'Susceptibility Rating',
          options: asOptions(['LOW', 'MODERATE', 'HIGH']), // src: timber-pest-inspection.md:201
        },
        {
          // src: timber-pest-inspection.md:202
          kind: 'gallery',
          key: 'supportingPhotos',
          label: 'Additional supporting pictures',
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:206
    // Each row: its control, then (where the source has them) photos and comments,
    // then its guidance, which prints only when the row's answer is flagged.
    // The source table names the photo and comment controls only by type
    // ("Photo Dropzone", "Comments Field"); they carry the labels this form uses
    // for the same controls everywhere else, `Photos` and `Additional Comments`.
    // ---------------------------------------------------------------------------
    {
      id: 'conduciveConditions',
      number: 7,
      title: 'CONDUCIVE CONDITIONS TO TIMBER PEST ATTACK',
      // src: timber-pest-inspection.md:208
      preamble:
        'Conducive Conditions are elements around a Property or environmental factors that could increase the likelihood of Timber Pest attack. In addition to Timber Pest damage and the existence of Timber Pests at the Property, Conducive Conditions can be identified due to certain construction methods, types of timber used, reduced sub-floor ventilation, increased moisture levels or dampness, storage of timber materials under and around the property and close proximity of garden beds to concrete slabs.',
      fields: [
        // --- src: timber-pest-inspection.md:212 ---
        // src: timber-pest-inspection.md:212
        {
          kind: 'toggle',
          key: 'waterLeaks',
          label: 'Water Leaks',
          flaggedValue: true,
        },
        // src: timber-pest-inspection.md:212
        { kind: 'gallery', key: 'waterLeaksPhotos', label: 'Photos' },
        // src: timber-pest-inspection.md:212
        {
          kind: 'area',
          key: 'waterLeaksComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:212
          kind: 'note',
          key: 'guidanceWaterLeaks',
          label: 'Water leaks guidance',
          attachedTo: 'waterLeaks',
          printed: 'whenFlagged',
          body: doc(
            'Engage a qualified plumber or builder to rectify as soon as possible.',
          ),
        },

        // --- src: timber-pest-inspection.md:213 ---
        {
          // src: timber-pest-inspection.md:213
          kind: 'radio',
          key: 'waterTanks',
          label: 'Water Tanks',
          options: YES_NO, // src: timber-pest-inspection.md:213
          flaggedValues: ['Yes'],
        },
        {
          // src: timber-pest-inspection.md:213
          kind: 'note',
          key: 'guidanceWaterTanks',
          label: 'Water tanks guidance',
          attachedTo: 'waterTanks',
          printed: 'whenFlagged',
          body: doc(
            'Recommend suitable drainage to prevent moisture build-up.',
          ),
        },

        // --- src: timber-pest-inspection.md:214 ---
        {
          // src: timber-pest-inspection.md:214
          kind: 'toggle',
          key: 'highMoistureReadings',
          label: 'High Moisture Readings',
          flaggedValue: true,
        },
        // src: timber-pest-inspection.md:214
        { kind: 'gallery', key: 'highMoistureReadingsPhotos', label: 'Photos' },
        {
          // src: timber-pest-inspection.md:214
          kind: 'area',
          key: 'highMoistureReadingsComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:214
          kind: 'note',
          key: 'guidanceHighMoistureReadings',
          label: 'High moisture readings guidance',
          attachedTo: 'highMoistureReadings',
          printed: 'whenFlagged',
          body: doc(
            'Obtain expert advice to determine cause, extent, and rectification cost.',
          ),
        },

        // --- src: timber-pest-inspection.md:215 ---
        {
          // src: timber-pest-inspection.md:215
          kind: 'radio',
          key: 'siteDrainage',
          label: 'Site Drainage',
          options: asOptions(['Adequate', 'Inadequate']), // src: timber-pest-inspection.md:215
          flaggedValues: ['Inadequate'],
        },
        // src: timber-pest-inspection.md:215
        {
          kind: 'area',
          key: 'siteDrainageComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:215
          kind: 'note',
          key: 'guidanceSiteDrainage',
          label: 'Site drainage guidance',
          attachedTo: 'siteDrainage',
          printed: 'whenFlagged',
          body: doc(
            'Sloping sites with run-off require effective site drainage to prevent moisture retention.',
          ),
        },

        // --- src: timber-pest-inspection.md:216 ---
        {
          // src: timber-pest-inspection.md:216
          kind: 'radio',
          key: 'subfloorDrainage',
          label: 'Subfloor Drainage',
          options: ADEQUATE_INADEQUATE_NA, // src: timber-pest-inspection.md:216
          flaggedValues: ['Inadequate'],
        },
        {
          // src: timber-pest-inspection.md:216
          kind: 'area',
          key: 'subfloorDrainageComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:216
          kind: 'note',
          key: 'guidanceSubfloorDrainage',
          label: 'Subfloor drainage guidance',
          attachedTo: 'subfloorDrainage',
          printed: 'whenFlagged',
          body: doc(
            'Poor subfloor drainage leads to water retention and wood decay.',
          ),
        },

        // --- src: timber-pest-inspection.md:217 ---
        {
          // src: timber-pest-inspection.md:217
          kind: 'radio',
          key: 'ventilation',
          label: 'Ventilation',
          options: ADEQUATE_INADEQUATE_NA, // src: timber-pest-inspection.md:217
          flaggedValues: ['Inadequate'],
        },
        // src: timber-pest-inspection.md:217
        {
          kind: 'area',
          key: 'ventilationComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:217
          kind: 'note',
          key: 'guidanceVentilation',
          label: 'Ventilation guidance',
          attachedTo: 'ventilation',
          printed: 'whenFlagged',
          body: doc(
            'Subfloor ventilation keeps floor frame dry. Blockages must be cleared.',
          ),
        },

        // --- src: timber-pest-inspection.md:218 ---
        // src: timber-pest-inspection.md:218
        { kind: 'toggle', key: 'mould', label: 'Mould', flaggedValue: true },
        // src: timber-pest-inspection.md:218
        { kind: 'area', key: 'mouldComments', label: 'Additional Comments' },
        {
          // src: timber-pest-inspection.md:218
          kind: 'note',
          key: 'guidanceMould',
          label: 'Mould guidance',
          attachedTo: 'mould',
          printed: 'whenFlagged',
          body: doc(
            'Mould indicates high moisture / poor ventilation. Engage specialist if found.',
          ),
        },

        // --- src: timber-pest-inspection.md:219 ---
        {
          // src: timber-pest-inspection.md:219
          kind: 'radio',
          key: 'externalExposedTimbers',
          label: 'External Exposed Timbers',
          options: ADEQUATE_INADEQUATE_NA, // src: timber-pest-inspection.md:219
          flaggedValues: ['Inadequate'],
        },
        {
          // src: timber-pest-inspection.md:219
          kind: 'area',
          key: 'externalExposedTimbersComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:219
          kind: 'note',
          key: 'guidanceExternalExposedTimbers',
          label: 'External exposed timbers guidance',
          attachedTo: 'externalExposedTimbers',
          printed: 'whenFlagged',
          // FLAG: "Minimize" — US spelling.
          body: doc(
            'Minimize damage via regular painting/treatment or replacement with suitable materials.',
          ),
        },

        // --- src: timber-pest-inspection.md:220 ---
        {
          // src: timber-pest-inspection.md:220
          kind: 'radio',
          key: 'slabEdgeExposure',
          label: 'Slab Edge Exposure',
          options: YES_NO_NA, // src: timber-pest-inspection.md:220
          // Assumed: "No" = the slab edge is not exposed for inspection. Open with the owner.
          flaggedValues: ['No'],
        },
        {
          // src: timber-pest-inspection.md:220
          kind: 'area',
          key: 'slabEdgeExposureComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:220
          kind: 'note',
          key: 'guidanceSlabEdgeExposure',
          label: 'Slab edge exposure guidance',
          attachedTo: 'slabEdgeExposure',
          printed: 'whenFlagged',
          body: doc(
            'Maintain a visible inspection zone of at least 75mm along concrete slab edge.',
          ),
        },

        // --- src: timber-pest-inspection.md:221 ---
        {
          // src: timber-pest-inspection.md:221
          kind: 'radio',
          key: 'antCapping',
          label: 'Ant Capping',
          options: ADEQUATE_INADEQUATE_NA, // src: timber-pest-inspection.md:221
          flaggedValues: ['Inadequate'],
        },
        // src: timber-pest-inspection.md:221
        {
          kind: 'area',
          key: 'antCappingComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:221
          kind: 'note',
          key: 'guidanceAntCapping',
          label: 'Ant capping guidance',
          attachedTo: 'antCapping',
          printed: 'whenFlagged',
          body: doc(
            'All joins should be adequately soldered and sealed to maintain shield integrity.',
          ),
        },

        // --- src: timber-pest-inspection.md:222 ---
        {
          // src: timber-pest-inspection.md:222
          kind: 'radio',
          key: 'weepHoles',
          label: 'Weep Holes',
          options: asOptions(['Yes', 'No', 'No weep holes located']), // src: timber-pest-inspection.md:222
          // Assumed: "No" = the weep holes are not clear. Open with the owner.
          flaggedValues: ['No'],
        },
        // src: timber-pest-inspection.md:222
        {
          kind: 'area',
          key: 'weepHolesComments',
          label: 'Additional Comments',
        },
        {
          // src: timber-pest-inspection.md:222
          kind: 'note',
          key: 'guidanceWeepHoles',
          label: 'Weep holes guidance',
          attachedTo: 'weepHoles',
          printed: 'whenFlagged',
          body: doc(
            'Weep holes must be clear and free flowing to maintain airflow and condensation release.',
          ),
        },

        // --- src: timber-pest-inspection.md:223 ---
        {
          // src: timber-pest-inspection.md:223
          kind: 'toggle',
          key: 'otherConduciveConditions',
          label: 'Other Conducive Conditions',
          flaggedValue: true,
        },
        {
          // src: timber-pest-inspection.md:223
          kind: 'gallery',
          key: 'otherConduciveConditionsPhotos',
          label: 'Photos',
        },
        {
          // src: timber-pest-inspection.md:223
          kind: 'note',
          key: 'guidanceOtherConduciveConditions',
          label: 'Other conducive conditions guidance',
          attachedTo: 'otherConduciveConditions',
          // An instruction to the inspector, not advice to the client: screen only.
          printed: false,
          body: doc('Capture any additional custom conducive factors.'),
        },
        // src: timber-pest-inspection.md:224 — `Terms and Conditions Toggle` dropped
        // (fidelity.md): terms always print. See `superseded`.
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:228
    // ---------------------------------------------------------------------------
    {
      id: 'contactTheInspector',
      number: 8,
      title: 'CONTACT THE INSPECTOR',
      // src: timber-pest-inspection.md:230
      preamble:
        'The Inspector is the individual that performed the Inspection on behalf of the Inspection Provider. If anything is unclear or you would like to better understand any item in this Report, please contact the Inspector immediately. All items should be clearly understood before any action is taken on this Report.',
      fields: [
        {
          // src: timber-pest-inspection.md:232
          kind: 'member',
          key: 'inspectorName',
          label: 'Inspector Name',
          roleWord: 'Inspector',
          defaultTo: 'jobAssignee',
        },
        {
          // src: timber-pest-inspection.md:233
          kind: 'derived',
          key: 'inspectorAddress',
          label: 'Inspector Address',
          source: 'technician.address',
          member: 'inspectorName',
          format: 'address',
        },
        {
          // src: timber-pest-inspection.md:234
          kind: 'derived',
          key: 'inspectorLicence',
          label: 'Inspector Licence',
          source: 'technician.licence',
          member: 'inspectorName',
        },
        {
          // src: timber-pest-inspection.md:235 — value `+61435917546`
          kind: 'derived',
          key: 'inspectorPhone',
          label: 'Inspector Phone',
          source: 'technician.phone',
          member: 'inspectorName',
        },
        {
          // src: timber-pest-inspection.md:236 — value `Pest M8 South`.
          // Label dropped by the extractor's META_VALUE_LABEL; verbatim from the source.
          kind: 'derived',
          key: 'signedOnBehalfOf',
          label: 'Signed on behalf of',
          source: 'business.tradingName',
        },
        {
          // src: timber-pest-inspection.md:237
          kind: 'signature',
          key: 'inspectorSignature',
          label: 'Inspector Signature',
          slot: 'technician',
          role: 'technician',
          required: true,
        },
        {
          // src: timber-pest-inspection.md:238
          kind: 'date',
          key: 'inspectorSignedDate',
          label: 'Date',
          required: true,
        },
        {
          // src: timber-pest-inspection.md:239 — a form instruction; never printed.
          kind: 'note',
          key: 'emailReportToWarning',
          label: 'Email report warning',
          tone: 'warning',
          printed: false,
          body: doc(
            'Warning: Any email address added to this field will receive a copy of the PDF when you hit "Submit"',
          ),
        },
        {
          // src: timber-pest-inspection.md:240
          kind: 'emails',
          key: 'emailReportTo',
          label: 'Email Report To',
          // A delivery instruction, not document content.
          printed: false,
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // src: timber-pest-inspection.md:244
    // ---------------------------------------------------------------------------
    {
      id: 'clientAcknowledgment',
      number: 9,
      title: 'CLIENT ACKNOWLEDGMENT OF THIS REPORT',
      fields: [
        {
          // src: timber-pest-inspection.md:246
          kind: 'note',
          key: 'clientAcceptanceStatement',
          label: 'Client acceptance statement',
          tone: 'statement',
          // FLAG: the client acknowledges "that the Property is free of Timber Pests and
          // damage caused by Timber Pests". A client cannot agree to that, and the rest of
          // the report says the opposite. Raise before it prints under a signature.
          body: doc(
            'The Client acknowledges and agrees with the contents of this Report. The Client acknowledges and agrees that the Inspection has limitations, that the Property is free of Timber Pests and damage caused by Timber Pests and accepts and relies on the Inspection and Report solely at its own risk.',
          ),
        },
        {
          // src: timber-pest-inspection.md:247
          kind: 'derived',
          key: 'acknowledgmentClientName',
          label: 'Client Name',
          source: 'client.name',
        },
        {
          // src: timber-pest-inspection.md:248
          kind: 'signature',
          key: 'clientSignature',
          label: 'Signature',
          slot: 'client',
          role: 'client',
        },
        {
          // src: timber-pest-inspection.md:249
          kind: 'date',
          key: 'clientSignedDate',
          label: 'Date',
        },
      ],
    },
  ],

  schema: z.object({
    // Header
    inspectionTypeWarranty: z.array(z.string()).optional(),

    // 1. CLIENT DETAILS
    clientAgreesToInspection: z.string().optional(),
    sendCopyToClient: z.boolean().optional(),
    inspectionDate: z
      .string({ error: 'Inspection Date is required' })
      .min(1, 'Inspection Date is required'),
    inspectionTime: z.string().optional(),
    peoplePresent: z.array(z.string()).optional(),
    weatherConditions: z.string().optional(),

    // 2. ABOUT OUR AGREEMENT
    agreementDate: z.string().optional(),

    // 3. INSPECTION SUMMARY
    summaryHinderedAccess: z.string().optional(),
    summaryRestrictedAccess: z.string().optional(),
    summaryHighRiskAreas: z.string().optional(),
    summaryActiveTermites: z.string().optional(),
    summaryTermiteNest: z.string().optional(),
    summaryTermiteWorkings: z.string().optional(),
    summaryBorers: z.string().optional(),
    summaryFungalDecay: z.string().optional(),
    summaryFurtherInspections: z.string().optional(),
    summarySusceptibility: z.string().optional(),

    // 4. ABOUT THE PROPERTY INSPECTED
    facadeFaces: z.string().optional(),
    siteTopography: z.string().optional(),
    structureType: z.string().optional(),
    structureHeight: z.string().optional(),
    wallConstruction: z.array(z.string()).optional(),
    floorType: z.array(z.string()).optional(),
    roofType: z.array(z.string()).optional(),
    propertyComments: z.string().optional(),
    furnishingStatus: z.string().optional(),
    occupancyStatus: z.string().optional(),

    // 5. AREAS WE WERE UNABLE TO INSPECT & WHY
    hinderedAccess: z.boolean().optional(),
    hinderedAccessComments: z.string().optional(),
    restrictedAccess: z.boolean().optional(),
    restrictedAccessComments: z.string().optional(),
    highRiskAreas: z.boolean().optional(),
    highRiskAreasComments: z.string().optional(),
    invasiveInspectionRecommended: z.boolean().optional(),
    invasiveInspectionComments: z.string().optional(),

    // 6. FINDINGS & OBSERVATIONS
    liveTermites: z.boolean().optional(),
    liveTermitesComments: z.string().optional(),
    termiteNest: z.boolean().optional(),
    termiteNestComments: z.string().optional(),
    termiteWorkings: z.boolean().optional(),
    termiteWorkingsPhotoComments: z.string().optional(),
    termiteWorkingsComments: z.string().optional(),
    termiteTreatmentRecommended: z.string().optional(),
    termiteTreatmentComments: z.string().optional(),
    previousTreatment: z.boolean().optional(),
    previousTreatmentComments: z.string().optional(),
    durableNoticeFound: z.string().optional(),
    durableNoticeComments: z.string().optional(),
    borers: z.boolean().optional(),
    borersComments: z.string().optional(),
    fungalDecay: z.boolean().optional(),
    fungalDecayComments: z.string().optional(),
    inspectionFrequency: z.string().optional(),
    susceptibilityRating: z.string().optional(),

    // 7. CONDUCIVE CONDITIONS TO TIMBER PEST ATTACK
    waterLeaks: z.boolean().optional(),
    waterLeaksComments: z.string().optional(),
    waterTanks: z.string().optional(),
    highMoistureReadings: z.boolean().optional(),
    highMoistureReadingsComments: z.string().optional(),
    siteDrainage: z.string().optional(),
    siteDrainageComments: z.string().optional(),
    subfloorDrainage: z.string().optional(),
    subfloorDrainageComments: z.string().optional(),
    ventilation: z.string().optional(),
    ventilationComments: z.string().optional(),
    mould: z.boolean().optional(),
    mouldComments: z.string().optional(),
    externalExposedTimbers: z.string().optional(),
    externalExposedTimbersComments: z.string().optional(),
    slabEdgeExposure: z.string().optional(),
    slabEdgeExposureComments: z.string().optional(),
    antCapping: z.string().optional(),
    antCappingComments: z.string().optional(),
    weepHoles: z.string().optional(),
    weepHolesComments: z.string().optional(),
    otherConduciveConditions: z.boolean().optional(),

    // 8. CONTACT THE INSPECTOR
    inspectorName: z.string().optional(),
    inspectorSignature: z.object(
      { signedAt: z.number() },
      { error: 'Inspector Signature is required' },
    ),
    inspectorSignedDate: z
      .string({ error: 'Date is required' })
      .min(1, 'Date is required'),
    emailReportTo: z.array(z.string()).optional(),

    // 9. CLIENT ACKNOWLEDGMENT OF THIS REPORT
    clientSignature: z.unknown().optional(),
    clientSignedDate: z.string().optional(),
  }),

  boilerplate: '',

  // Interim (fidelity.md "Open with the owner"): the Certificate's §9 terms, until
  // the owner exports the terms body of Formitize form 24915944.
  terms: CERTIFICATE_TERMS,

  print: {
    // Fidelity rule 8: unanswered fields are omitted from the printed document.
    omitEmpty: true,
    // src: timber-pest-inspection.md:12 — the form's own printed name. The Form Title
    // (line 9) is file metadata the extractor drops, so the sub heading names it.
    formName: 'PEST M8 PEST CONTROL TIMBER PEST INSPECTION REPORT',
    numbering: 'numbered',
    headings: [
      'TIMBER PEST WARRANTY INSPECTION', // src: timber-pest-inspection.md:11
      'PEST M8 PEST CONTROL TIMBER PEST INSPECTION REPORT', // src: timber-pest-inspection.md:12
    ],
    // src: timber-pest-inspection.md:23
    standardsLine:
      'Prepared in accordance with Australian Standard: AS 4349.3-2010: Inspection of Buildings - Timber Pest Inspections',
    cover: {
      title: 'TIMBER PEST WARRANTY INSPECTION', // src: timber-pest-inspection.md:11
      subtitle: 'PEST M8 PEST CONTROL TIMBER PEST INSPECTION REPORT', // src: timber-pest-inspection.md:12
    },
  },

  sourceRef: 'docs/sources/timber-pest-inspection.md',

  corrections: [],

  superseded: [
    {
      text: 'Form Header & Operational Metadata',
      cite: 'timber-pest-inspection.md:7',
      reason:
        "Form chrome: the data dictionary's own heading for the header block. The block prints from `print.headings` and `print.standardsLine`.",
    },
    {
      text: 'Pest M8 South',
      cite: 'timber-pest-inspection.md:70',
      reason:
        'Record data printed from context: the Inspection Provider name (line 70) and `Signed on behalf of` (line 236) are `derived` from business.tradingName.',
    },
    {
      text: '+611800737868',
      cite: 'timber-pest-inspection.md:72',
      reason:
        "Record data printed from context: the Inspection Provider's `Phone` is `derived` from business.phone.",
    },
    {
      text: 'info@pestm8.com.au',
      cite: 'timber-pest-inspection.md:73',
      reason:
        "Record data printed from context: the Inspection Provider's `Email` is `derived` from business.email.",
    },
    {
      text: 'Control Type & Selection Options',
      cite: 'timber-pest-inspection.md:81',
      reason:
        "Form chrome: a column header of the data dictionary's §3 table, not form text.",
    },
    {
      text: 'Double Brick, Brick Veneer, Weatherboard, Cladding, Concrete Block, Stone, Timber structured walls',
      cite: 'timber-pest-inspection.md:103',
      reason:
        'The option list of `Wall Construction`, written comma-separated (not backticked) so the extractor kept it whole. Printed as its seven options, each verbatim.',
    },
    {
      text: 'Timber Floor, Concrete Slab, Infill Concrete Slab, Timber Flooring with Concrete Areas',
      cite: 'timber-pest-inspection.md:104',
      reason:
        'The option list of `Floor Type`, written comma-separated. Printed as its four options, each verbatim.',
    },
    {
      text: 'Conventional Cut Roof, Trusses, Steel Sheeting, Terracotta Tile, Cement Tile, Tiled Roof',
      cite: 'timber-pest-inspection.md:106',
      reason:
        'The option list of `Roof Type`, written comma-separated. Printed as its six options, each verbatim.',
    },
    {
      text: 'Due to the degree of risk of subterranean termite infestation noted above and all other findings of this report, it is essential that a full inspection and written report in accord with AS 4349.3 or AS 3660.2-2017 is conducted at this property every: Dropdown (`-`, `1 month`, `3 months`, `6 months`, `9 months`, `12 months`)',
      cite: 'timber-pest-inspection.md:200',
      reason:
        'The extractor kept the sentence and its control description as one note. The sentence up to `every:` is the `inspectionFrequency` label, verbatim; `-` is its `blankOption` and the five intervals its options.',
    },
    {
      text: 'Terms and Conditions Toggle',
      cite: 'timber-pest-inspection.md:224',
      reason:
        'Dropped (fidelity.md "Open with the owner"): a Formitize screen artefact that previews a terms body the source does not contain. Terms always print; the Certificate §9 terms print as an interim.',
    },
    {
      text: 'Controls inline preview of standard T&Cs on form screen.',
      cite: 'timber-pest-inspection.md:224',
      reason:
        "The data dictionary's description of the dropped `Terms and Conditions Toggle`, not form text.",
    },
    {
      text: '+61435917546',
      cite: 'timber-pest-inspection.md:235',
      reason:
        'Record data printed from context: `Inspector Phone` is `derived` from technician.phone.',
    },
    {
      text: 'Re-sign signature',
      cite: 'timber-pest-inspection.md:237',
      reason:
        "Form chrome: the Formitize signature pad's own buttons, supplied by the app's signature control.",
    },
    {
      text: 'Re-sign with stamp',
      cite: 'timber-pest-inspection.md:237',
      reason:
        "Form chrome: the Formitize signature pad's own buttons. Stamps are not offered.",
    },
    {
      text: 'Warning: Any email address added to this field will receive a copy of the PDF when you hit "Submit',
      cite: 'timber-pest-inspection.md:239',
      reason:
        'Extractor artefact: `unquote()` strips the closing quote. The template carries the source\'s full text, ending `"Submit"`.',
    },
  ],

  validationNotes: [
    '`Inspection Date` is required (the form defaults it to the current date).',
    "`Inspector Signature` is required to finalise (fidelity.md Validation: the technician's signature is required). Owner-relaxable once `templateSettings.requiredSigners` ships; until then the zod schema enforces it.",
    "The inspector's signature `Date` is required; the client's `Date` and `Signature` are not.",
    '`12 Monthly Timber Pest Visual Inspection to maintain Warranty` is locked on: the source pre-ticks it and it is what the document is. `Year 1`...`Year 8` are optional.',
    '`Weather Conditions at time of inspection` is single-choice: the source declares radio buttons (unlike the Service Report, whose weather is multi-select).',
    'Toggles store a boolean and are seeded absent, so an unanswered question is never printed as "No".',
    'The `-` first entry of the four §4 dropdowns and the inspection frequency is a blank option: offered, never stored.',
    'Every other question is optional, as on the source form.',
    "§7's guidance notes print only when their row's answer is flagged (toggle Yes, `Inadequate`, `Water Tanks` Yes, `Slab Edge Exposure` No, `Weep Holes` No). The vendor form shows the column always; this is a layout decision. `Other Conducive Conditions` guidance is an instruction to the inspector and never prints.",
    'Terms: INTERIM. The source form has a `Terms and Conditions Toggle` but no terms body, so the toggle is dropped (terms always print) and the Certificate of Installation §9 terms print in their place, pending the terms text of Formitize form 24915944.',
    'The `Email Report To` warning is shown on screen only; it is a form instruction, not report content.',
  ],
}
