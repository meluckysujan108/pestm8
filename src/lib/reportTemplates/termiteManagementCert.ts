/**
 * Existing Structure Certificate of Installation — Subterranean Termite
 * Management System (AS 3660.2-2017), reproduced word for word.
 *
 * SOURCE
 *   docs/sources/termite-certificate.md — the only source for this form
 *   (fidelity.md precedence rule 5). The mechanically extracted corpus is
 *   spec/termiteManagementCert.generated.ts; `superseded[]` below lists every
 *   corpus string that does not appear in this template and why.
 *
 * PRECEDENCE RULES APPLIED (docs/reports/fidelity.md)
 *   1  The md's `**Label:**` colons are markdown formatting, not wording, so no
 *      label here carries a trailing colon (there is no PDF of this form to say
 *      otherwise).
 *   2  Control types come from the source's own control descriptions: `Radio`
 *      stays radio, `Toggle` stays toggle, `Checkboxes` stays checks, `Dropdown`
 *      stays select.
 *   5  One source: every string is the md's.
 *   7  The builder shows the numbered title ("1. CLIENT & PROPERTY DETAILS");
 *      AS forms print the same numbered heading, so `print.numbering` is
 *      'numbered' and no section overrides `print.heading`.
 *   8  Unanswered fields are omitted from the printed certificate.
 *
 * CORRECTIONS — exactly one, from the fidelity.md Corrections table:
 *   §3 `Linear metres $m$ or Area $m^2$` → `Linear metres (m) or Area (m²)`.
 *
 * FLAGGED FOR THE OWNER (kept verbatim) — all live in the §9 terms, see
 *   ./terms/certificateTerms.ts: "This Plan" (×2), the dangling cross-references
 *   "Inspection Report" / "Inspection Agreement" / "Property Address",
 *   "Purpose Of Termite Management Systems", "Constructions issues and faults:",
 *   "species in Australian including".
 *
 * FOR THE OWNER TO DECIDE
 *   - `System Type Installed` is described as "Checkboxes / Radio". It is
 *     authored as radio (single choice) because the list offers its own
 *     `Combination System` answer, which only makes sense for a single choice.
 *   - §7 repeats `Installer Name`, `Licence / Accreditation Number` and
 *     `Installer Phone` from §2, as the form does. §7's installer is a second
 *     member picker defaulting to the job's assignee; the engine cannot yet
 *     echo §2's choice (see the Phase 2 needs list).
 *   - §8 `Client Name` is typed (the source says single-line text input), not
 *     derived: the person acknowledging on site may be an agent or tenant.
 *   - The Formitize signature pad's `Re-sign signature` / `Re-sign with stamp`
 *     buttons are not reproduced (a saved signature is a later phase).
 */
import { z } from 'zod'
import { CERTIFICATE_TERMS } from './terms/certificateTerms'
import type { ReportTemplate } from './types'

// src: termite-certificate.md:30-36 — AS-referenced weather set, inline
const WEATHER = [
  'Dry',
  'Prolonged Dry Period',
  'Wet',
  'Prolonged Wet Period',
  'Overcast',
  'Windy',
  'Sunny',
]

// src: termite-certificate.md:62 — AS 3660.2 system types, inline
const SYSTEM_TYPES = [
  'Chemical Soil Barrier',
  'Chemical Reticulation System',
  'Physical Barrier',
  'Baiting & Monitoring System',
  'Combination System',
]

// src: termite-certificate.md:68 — AS 3660.2 application methods, inline
const APPLICATION_METHODS = [
  'Trenching & Soil Treatment',
  'Drilling & Chemical Injection',
  'Reticulation Charge',
  'Bait Station Installation',
]

// src: termite-certificate.md:77-83 — owner-editable defaults (optionsFrom 'areasTreated')
const AREAS_TREATED = [
  'External Soil Perimeter',
  'External Concrete / Paved Perimeter',
  'Subfloor Zone Soil & Piers',
  'Concrete Slab Edge / Penetrations',
  'Attached Structures (Patio, Carport, Verandah, Garage)',
  'Reticulation Pipe Network',
  'In-Ground Termite Monitoring / Baiting Stations',
]

// src: termite-certificate.md:96-100 — owner-editable defaults (optionsFrom 'limitationFactors')
const LIMITATION_FACTORS = [
  'Concrete / paved pathways abutting structure (undrilled)',
  'Zero lot line / property boundary restrictions',
  'Restricted subfloor clearance (<400mm)',
  'Hot water units, air conditioning compressors, or fixtures',
  'Landscaping / retaining walls against structure',
]

// src: termite-certificate.md:112-115 — owner-editable defaults (optionsFrom 'noticeLocation')
const NOTICE_LOCATIONS = [
  'Electricity Meter Box',
  'Subfloor Access Entrance',
  'Kitchen Cupboard',
  'Garage / Main Entrance',
]

// src: termite-certificate.md:117 — inspection frequency, inline; `-` is the blankOption, never stored
const INSPECTION_FREQUENCIES = [
  '1 month',
  '3 months',
  '6 months',
  '9 months',
  '12 months',
]

// src: termite-certificate.md:25, :110 — Yes | No
const YES_NO = ['Yes', 'No']

/** Option values are the verbatim source strings: value === label. */
const verbatim = (list: Array<string>) =>
  list.map((text) => ({ value: text, label: text }))

const text = (t: string) => ({ type: 'text' as const, text: t })
const paragraph = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [text(t)] }],
})

export const termiteManagementCert: ReportTemplate = {
  id: 'termiteManagementCert',
  // v2 — the word-for-word reproduction of the Formitize form. v1 was paraphrased.
  version: 2,
  name: 'Existing Structure Certificate of Installation',
  shortName: 'Certificate',
  legalBasis: 'AS 3660.2-2017',
  blurb:
    'Certificate of installation for a subterranean termite management system in an existing structure.',
  fields: [],
  sections: [
    // src: termite-certificate.md:17
    {
      id: 'client',
      number: 1,
      title: 'CLIENT & PROPERTY DETAILS',
      fields: [
        // src: termite-certificate.md:19
        {
          kind: 'note',
          key: 'clientNote',
          label: 'Client explanatory note',
          tone: 'note',
          body: paragraph(
            'The Client is the person or entity for whom the installation is being undertaken.',
          ),
        },
        // src: termite-certificate.md:21
        {
          kind: 'derived',
          key: 'clientName',
          label: 'Client Name',
          source: 'client.name',
        },
        // src: termite-certificate.md:22
        {
          kind: 'derived',
          key: 'clientAddress',
          label: 'Client Address',
          source: 'client.address',
          format: 'address',
        },
        // src: termite-certificate.md:23
        {
          kind: 'derived',
          key: 'clientPhone',
          label: 'Client Phone',
          source: 'client.phone',
        },
        // src: termite-certificate.md:24
        {
          kind: 'derived',
          key: 'clientEmail',
          label: 'Client Email',
          source: 'client.email',
        },
        // src: termite-certificate.md:25
        {
          kind: 'toggle',
          key: 'sendCopy',
          // Drives delivery, never printed — as the same vendor's Service Report
          // PDF shows for its identical control.
          printed: false,
          label:
            'Send a copy of the Report to the email address above when you submit this form?',
          yes: 'Yes',
          no: 'No',
        },
        // src: termite-certificate.md:26
        {
          kind: 'derived',
          key: 'propertyAddress',
          label: 'Property Inspected / Installed Address',
          source: 'property.address',
          format: 'address',
        },
        // src: termite-certificate.md:27 — "Date picker (Default: Current Date)"
        {
          kind: 'date',
          key: 'installDate',
          label: 'Installation Date',
          defaultToday: true,
          required: true,
        },
        // src: termite-certificate.md:28
        { kind: 'time', key: 'installTime', label: 'Time of Installation' },
        // src: termite-certificate.md:29-36 — "(Radio buttons)"
        {
          kind: 'radio',
          key: 'weather',
          label: 'Weather Conditions at time of installation',
          options: verbatim(WEATHER),
        },
      ],
    },

    // src: termite-certificate.md:40
    {
      id: 'agreement',
      number: 2,
      title: 'AGREEMENT & INSTALLER DETAILS',
      fields: [
        // src: termite-certificate.md:42 — "Standards Compliance"
        {
          kind: 'note',
          key: 'standardsNote',
          label: 'Standards compliance',
          body: paragraph(
            'AS 3660.2-2017 Termite Management - In and Around Existing Buildings and Structures',
          ),
        },
        // src: termite-certificate.md:43
        { kind: 'date', key: 'agreementDate', label: 'Agreement Date' },
        // src: termite-certificate.md:44
        {
          kind: 'heading',
          key: 'providerHeading',
          label: 'Provider details heading',
          text: 'Inspection / Installation Provider Details',
        },
        // src: termite-certificate.md:45 — the value `Pest M8 South` is the business's trading name.
        // The extractor's META_VALUE_LABEL drops this label from the corpus; it is verbatim source text.
        {
          kind: 'derived',
          key: 'providerName',
          label: 'Name (hereafter "Inspection Provider")',
          source: 'business.tradingName',
        },
        // src: termite-certificate.md:46
        {
          kind: 'derived',
          key: 'providerAddress',
          label: 'Address',
          source: 'business.address',
          format: 'address',
        },
        // src: termite-certificate.md:47 — value `+611800737868` is the business's phone
        {
          kind: 'derived',
          key: 'providerPhone',
          label: 'Phone',
          source: 'business.phone',
        },
        // src: termite-certificate.md:48 — value `info@pestm8.com.au` is the business's email
        {
          kind: 'derived',
          key: 'providerEmail',
          label: 'Email',
          source: 'business.email',
        },
        // src: termite-certificate.md:49
        {
          kind: 'heading',
          key: 'installerHeading',
          label: 'Installer details heading',
          text: 'Installer Details',
        },
        // src: termite-certificate.md:50 — the source's value is a named technician (record data)
        {
          kind: 'member',
          key: 'installer',
          label: 'Installer Name',
          roleWord: 'Installer',
          defaultTo: 'jobAssignee',
        },
        // src: termite-certificate.md:51
        {
          kind: 'derived',
          key: 'installerLicence',
          label: 'Licence / Accreditation Number',
          source: 'technician.licence',
          member: 'installer',
        },
        // src: termite-certificate.md:52 — value `+61435917546` is the technician's phone
        {
          kind: 'derived',
          key: 'installerPhone',
          label: 'Installer Phone',
          source: 'technician.phone',
          member: 'installer',
        },
      ],
    },

    // src: termite-certificate.md:56
    {
      id: 'system',
      number: 3,
      title: 'DETAILS OF TERMITE MANAGEMENT SYSTEM INSTALLED',
      // src: termite-certificate.md:58 — "Preamble"
      preamble:
        'Details of the subterranean termite management system, chemical barrier, reticulation, physical barrier, or baiting system installed at the existing structure.',
      fields: [
        // src: termite-certificate.md:62 — "Checkboxes / Radio"; radio, see header
        {
          kind: 'radio',
          key: 'systemType',
          label: 'System Type Installed',
          options: verbatim(SYSTEM_TYPES),
        },
        // src: termite-certificate.md:63
        {
          kind: 'text',
          key: 'product',
          label: 'Product / Brand Name',
          placeholder: 'e.g. Termidor HE, Biflex Ultra, Altriset, Exterra',
        },
        // src: termite-certificate.md:64
        {
          kind: 'text',
          key: 'activeConstituent',
          label: 'Active Constituent',
          placeholder: 'e.g. Fipronil 100g/L, Bifenthrin 100g/L',
        },
        // src: termite-certificate.md:65
        {
          kind: 'text',
          key: 'concentration',
          label: 'Concentration / Mix Rate',
          placeholder: 'e.g. 6.25mL / Litre of water',
        },
        // src: termite-certificate.md:66
        {
          kind: 'text',
          key: 'totalQuantity',
          label: 'Total Quantity / Volume Applied',
          placeholder: 'e.g. 350 Litres / 12 Stations',
        },
        // src: termite-certificate.md:67 — corrected: `Linear metres $m$ or Area $m^2$` (LaTeX artefact)
        {
          kind: 'text',
          key: 'extentOfTreatment',
          label: 'Extent of Treatment',
          placeholder: 'Linear metres (m) or Area (m²)',
        },
        // src: termite-certificate.md:68 — "Checkboxes"
        {
          kind: 'checks',
          key: 'applicationMethod',
          label: 'Application Method',
          options: verbatim(APPLICATION_METHODS),
        },
        // src: termite-certificate.md:69
        {
          kind: 'text',
          key: 'holeSpacing',
          label: 'Hole Spacing (if drilled)',
          placeholder: 'e.g. 200mm c/c',
        },
        // src: termite-certificate.md:70
        {
          kind: 'text',
          key: 'trenchDimensions',
          label: 'Trench Dimensions',
          placeholder: 'e.g. 150mm wide x 150mm deep to footings',
        },
      ],
    },

    // src: termite-certificate.md:74
    {
      id: 'areas',
      number: 4,
      title: 'AREAS TREATED & SITE DETAILS',
      fields: [
        // src: termite-certificate.md:76-83 — "(Checkboxes)"
        {
          kind: 'checks',
          key: 'areasTreated',
          label: 'Areas Treated',
          optionsFrom: 'areasTreated',
          options: verbatim(AREAS_TREATED),
        },
        // src: termite-certificate.md:84 — "Multi-image uploader dropzone"
        {
          kind: 'gallery',
          key: 'installationPhotos',
          label: 'Installation Photos',
        },
        // src: termite-certificate.md:85
        { kind: 'text', key: 'photoComments', label: 'Photo Comments' },
        // src: termite-certificate.md:86
        {
          kind: 'area',
          key: 'additionalComments',
          label: 'Additional Comments',
        },
      ],
    },

    // src: termite-certificate.md:90
    {
      id: 'limitations',
      number: 5,
      title: 'LIMITATIONS & UNTREATED AREAS',
      fields: [
        // src: termite-certificate.md:92
        {
          kind: 'note',
          key: 'limitationsNote',
          label: 'Limitations explanatory note',
          tone: 'note',
          body: paragraph(
            'Identification of any structural or physical limitations where a continuous termite management system could not be fully established.',
          ),
        },
        // src: termite-certificate.md:94 — "Toggle (`Yes` | `No`)"
        {
          kind: 'toggle',
          key: 'limitationsPresent',
          label:
            'Were there any obstructions or areas where treatment was limited?',
          yes: 'Yes',
          no: 'No',
          flaggedValue: true,
        },
        // src: termite-certificate.md:95-100 — "(Checkboxes)"
        {
          kind: 'checks',
          key: 'limitationFactors',
          label: 'Limitation Factors',
          optionsFrom: 'limitationFactors',
          options: verbatim(LIMITATION_FACTORS),
          visibleWhen: { when: 'limitationsPresent', eq: true },
        },
        // src: termite-certificate.md:101
        {
          kind: 'area',
          key: 'limitationDetails',
          label: 'Details of Inaccessible or Incomplete Areas',
          visibleWhen: { when: 'limitationsPresent', eq: true },
        },
        // src: termite-certificate.md:102 — "Risk Warning"; prints always, as the form does
        {
          kind: 'note',
          key: 'riskWarning',
          label: 'Risk warning',
          tone: 'warning',
          attachedTo: 'limitationsPresent',
          body: paragraph(
            'Where a complete and continuous management system cannot be installed, subterranean termites may gain concealed entry into the structure. Regular visual inspections are vital.',
          ),
        },
      ],
    },

    // src: termite-certificate.md:106
    {
      id: 'durableNotice',
      number: 6,
      title: 'DURABLE NOTICE & MAINTENANCE REQUIREMENTS',
      fields: [
        // src: termite-certificate.md:108
        {
          kind: 'note',
          key: 'durableNoticeNote',
          label: 'Durable notice explanatory note',
          tone: 'note',
          body: paragraph(
            'Australian Standard AS 3660.2 requires a Durable Notice to be permanently attached to the building upon installation of a termite management system.',
          ),
        },
        // src: termite-certificate.md:110 — "Radio (`Yes` | `No`)"
        {
          kind: 'radio',
          key: 'durableNoticeFitted',
          label: 'Was a Durable Notice fitted?',
          options: verbatim(YES_NO),
          flaggedValues: ['No'],
        },
        // src: termite-certificate.md:111-115 — "(Radio)"
        {
          kind: 'radio',
          key: 'durableNoticeLocation',
          label: 'Location of Durable Notice',
          optionsFrom: 'noticeLocation',
          options: verbatim(NOTICE_LOCATIONS),
          visibleWhen: { when: 'durableNoticeFitted', eq: 'Yes' },
        },
        // src: termite-certificate.md:116 — "Photo uploader dropzone" (one photo)
        {
          kind: 'gallery',
          key: 'durableNoticePhoto',
          label: 'Durable Notice Photo',
          maxPhotos: 1,
          visibleWhen: { when: 'durableNoticeFitted', eq: 'Yes' },
        },
        // src: termite-certificate.md:117 — "Dropdown (`-`, `1 month`, … `12 months`)"
        {
          kind: 'select',
          key: 'reinspectionInterval',
          label: 'Recommended Inspection Frequency',
          blankOption: '-',
          options: verbatim(INSPECTION_FREQUENCIES),
        },
        // src: termite-certificate.md:118
        {
          kind: 'date',
          key: 'nextInspectionDue',
          label: 'Next Inspection Due Date',
        },
      ],
    },

    // src: termite-certificate.md:122
    {
      id: 'certification',
      number: 7,
      title: 'INSTALLER CERTIFICATION & SIGNATURE',
      // src: termite-certificate.md:124 — "Preamble"
      preamble:
        'Statement of certification by the licensed installer confirming that the subterranean termite management system has been installed in accordance with AS 3660.2-2017 and manufacturer specifications.',
      fields: [
        // src: termite-certificate.md:126 — "Installer Certification Statement"
        {
          kind: 'note',
          key: 'certificationStatement',
          label: 'Installer certification statement',
          tone: 'statement',
          body: paragraph(
            'I hereby certify that the subterranean termite management system described in this Certificate has been installed at the specified property in accordance with Australian Standard AS 3660.2-2017 and manufacturer requirements.',
          ),
        },
        // src: termite-certificate.md:127 — repeats §2's installer, as the form does
        {
          kind: 'member',
          key: 'certifyingInstaller',
          label: 'Installer Name',
          roleWord: 'Installer',
          defaultTo: 'jobAssignee',
        },
        // src: termite-certificate.md:128
        {
          kind: 'derived',
          key: 'certifyingInstallerLicence',
          label: 'Licence / Accreditation Number',
          source: 'technician.licence',
          member: 'certifyingInstaller',
        },
        // src: termite-certificate.md:129
        {
          kind: 'derived',
          key: 'certifyingInstallerPhone',
          label: 'Installer Phone',
          source: 'technician.phone',
          member: 'certifyingInstaller',
        },
        // src: termite-certificate.md:130 — value `Pest M8 South` is the trading name.
        // The extractor's META_VALUE_LABEL drops this label from the corpus; it is verbatim source text.
        {
          kind: 'derived',
          key: 'signedOnBehalfOf',
          label: 'Signed on behalf of',
          source: 'business.tradingName',
        },
        // src: termite-certificate.md:131 — "Digital Canvas Pad"
        {
          kind: 'signature',
          key: 'installerSignature',
          label: 'Installer Signature',
          slot: 'installer',
          role: 'technician',
          required: true,
        },
        // src: termite-certificate.md:132
        {
          kind: 'date',
          key: 'installerDateSigned',
          label: 'Date Signed',
        },
        // src: termite-certificate.md:133
        {
          kind: 'emails',
          key: 'emailCertificateTo',
          label: 'Email Certificate To',
          // A delivery instruction, not document content.
          printed: false,
        },
      ],
    },

    // src: termite-certificate.md:137
    {
      id: 'acknowledgment',
      number: 8,
      title: 'CLIENT ACKNOWLEDGMENT',
      fields: [
        // src: termite-certificate.md:139 — "Client Acknowledgment Statement"
        {
          kind: 'note',
          key: 'acknowledgmentStatement',
          label: 'Client acknowledgment statement',
          tone: 'statement',
          body: paragraph(
            'The Client acknowledges receipt of this Certificate of Installation and agrees to maintain the property in accordance with the recommendations to preserve system effectiveness and warranty.',
          ),
        },
        // src: termite-certificate.md:140 — "Single-line text input"
        {
          kind: 'text',
          key: 'clientSignatoryName',
          label: 'Client Name',
        },
        // src: termite-certificate.md:141 — "Digital Canvas Pad"
        {
          kind: 'signature',
          key: 'clientSignature',
          label: 'Client Signature',
          slot: 'client',
          role: 'client',
        },
        // src: termite-certificate.md:142
        { kind: 'date', key: 'clientDateSigned', label: 'Date Signed' },
      ],
    },
  ],

  // Only answers are validated; derived, note, heading and gallery blocks hold
  // nothing in `data`. Hidden fields are pruned before this runs, so every
  // conditional field is optional here.
  schema: z.object({
    // §1
    sendCopy: z.boolean().optional(),
    installDate: z.string().min(1, 'Installation Date is required'),
    installTime: z.string().optional(),
    weather: z.string().optional(),
    // §2
    agreementDate: z.string().optional(),
    installer: z.string().optional(),
    // §3
    systemType: z.string().optional(),
    product: z.string().optional(),
    activeConstituent: z.string().optional(),
    concentration: z.string().optional(),
    totalQuantity: z.string().optional(),
    extentOfTreatment: z.string().optional(),
    applicationMethod: z.array(z.string()).optional(),
    holeSpacing: z.string().optional(),
    trenchDimensions: z.string().optional(),
    // §4
    areasTreated: z.array(z.string()).optional(),
    photoComments: z.string().optional(),
    additionalComments: z.string().optional(),
    // §5
    limitationsPresent: z.boolean().optional(),
    limitationFactors: z.array(z.string()).optional(),
    limitationDetails: z.string().optional(),
    // §6
    durableNoticeFitted: z.string().optional(),
    durableNoticeLocation: z.string().optional(),
    reinspectionInterval: z.string().optional(),
    nextInspectionDue: z.string().optional(),
    // §7 — the installer's signature is required, here, as the Timber and
    // Service Report schemas require theirs. An owner setting to relax it
    // arrives with template settings; until then nothing else enforces it.
    certifyingInstaller: z.string().optional(),
    installerSignature: z.object(
      { signedAt: z.number() },
      { error: 'Installer Signature is required' },
    ),
    installerDateSigned: z.string().optional(),
    emailCertificateTo: z.array(z.string()).optional(),
    // §8
    clientSignatoryName: z.string().optional(),
    clientSignature: z.unknown().optional(),
    clientDateSigned: z.string().optional(),
  }),

  boilerplate: '',
  terms: CERTIFICATE_TERMS,

  print: {
    // Fidelity rule 8: unanswered fields are omitted from the printed document.
    omitEmpty: true,
    // src: termite-certificate.md:1, :9 — "Form Title" (not extracted: META_DROP_LABEL / H1)
    formName:
      'Pest M8 Pest Control Existing Structure Certificate of Installation - Termite Management (AS 3660.2-2017)',
    numbering: 'numbered',
    // src: termite-certificate.md:11, :12 — "Main Heading", "Sub Heading"
    headings: [
      'EXISTING STRUCTURE CERTIFICATE OF INSTALLATION',
      'SUBTERRANEAN TERMITE MANAGEMENT SYSTEM',
    ],
    // src: termite-certificate.md:13 — "Standards Reference"
    standardsLine:
      'Prepared in accordance with Australian Standard: AS 3660.2-2017 Termite Management - In and Around Existing Buildings and Structures',
    // src: termite-certificate.md:146
    termsHeading: '9. TERMS AND CONDITIONS OF CERTIFICATE',
  },

  sourceRef: 'docs/sources/termite-certificate.md',

  corrections: [
    {
      where: 'Certificate §3, Extent of Treatment',
      source: 'Linear metres $m$ or Area $m^2$',
      printed: 'Linear metres (m) or Area (m²)',
      reason: 'LaTeX artefact in the source file',
      kind: 'typo',
    },
  ],

  superseded: [
    {
      text: 'Form Header & Operational Metadata',
      cite: 'termite-certificate.md:7',
      reason:
        'Form chrome: the data dictionary’s heading over the header block. What it describes prints as print.headings and print.standardsLine.',
    },
    {
      text: 'Pest M8 South',
      cite: 'termite-certificate.md:45',
      reason:
        'Record data printed from context: business.tradingName, under `Name (hereafter "Inspection Provider")` (§2) and `Signed on behalf of` (§7).',
    },
    {
      text: '+611800737868',
      cite: 'termite-certificate.md:47',
      reason: 'Record data printed from context: business.phone under `Phone`.',
    },
    {
      text: 'info@pestm8.com.au',
      cite: 'termite-certificate.md:48',
      reason: 'Record data printed from context: business.email under `Email`.',
    },
    {
      text: '+61435917546',
      cite: 'termite-certificate.md:52',
      reason:
        'Record data printed from context: technician.phone under `Installer Phone` (§2 and §7).',
    },
    {
      text: 'Control Type & Selection Options',
      cite: 'termite-certificate.md:60',
      reason:
        'Form chrome: the column header of the data dictionary’s §3 table, not form wording.',
    },
    {
      text: 'Re-sign signature',
      cite: 'termite-certificate.md:131',
      reason:
        'Form chrome: a Formitize signature-pad button. Never printed; a saved-signature affordance is deferred to a later phase.',
    },
    {
      text: 'Re-sign with stamp',
      cite: 'termite-certificate.md:131',
      reason:
        'Form chrome: a Formitize signature-pad button. Never printed; a saved-signature affordance is deferred to a later phase.',
    },
  ],

  validationNotes: [
    'The installer’s signature (`Installer Signature`) is required to finalise, enforced by the zod schema. An owner setting to relax it arrives with template settings.',
    '`Installation Date` is required — it is the certificate’s date, the equivalent of the Service Report’s `Date:`. It defaults to today, as the source says ("Default: Current Date").',
    'Nothing else is required: the source form validates nothing, and a certificate for a baiting-only or physical-barrier installation legitimately leaves the chemical rows (`Concentration / Mix Rate`, `Hole Spacing (if drilled)`, `Trench Dimensions`) blank. Blank rows are omitted from the print (rule 8).',
    '`Limitation Factors` and `Details of Inaccessible or Incomplete Areas` show only when `Were there any obstructions or areas where treatment was limited?` is Yes, so a certificate cannot print limitation factors under an answer of No. The source does not state this condition; the printed result for a consistent answer is unchanged. The `Risk Warning` prints regardless, as on the form.',
    '`Location of Durable Notice` and `Durable Notice Photo` show only when `Was a Durable Notice fitted?` is Yes, for the same reason. `No` is a flagged answer (AS 3660.2 requires the notice).',
    '`Recommended Inspection Frequency` offers `-` as a blank placeholder that is never stored; an unanswered frequency is omitted from the print.',
    '`System Type Installed` is single-choice (radio) although the source describes it as "Checkboxes / Radio"; its own `Combination System` answer covers the multi-system case.',
    '`Weather Conditions at time of installation` is single-choice, as the source’s "(Radio buttons)" says — unlike the Service Report’s multi-select `Weather on the Day`.',
  ],
}
