import { z } from 'zod'
import { apvmaNumber, requiredText } from './shared'
import type { ReportTemplate } from './types'

const TREATED_AREAS = [
  'Kitchen',
  'Bathrooms',
  'Living areas',
  'Bedrooms',
  'Laundry',
  'Garage',
  'Roof void',
  'Subfloor',
  'External perimeter',
  'Fence line',
  'Garden beds',
]

/**
 * APVMA record-keeping. Applying a registered pesticide obliges the operator to
 * record what was used, at what rate, and where — this is the record that has
 * to exist if anyone ever asks.
 */
export const treatmentRecord: ReportTemplate = {
  id: 'treatmentRecord',
  // v1 — the paraphrased wording that shipped before the verbatim rewrite.
  version: 1,
  name: 'Treatment Record',
  shortName: 'Treatment',
  legalBasis: 'APVMA',
  blurb: 'Chemical application record: product, rate, target pest and areas.',
  fields: [
    { kind: 'text', key: 'product', label: 'Product name', required: true },
    {
      kind: 'text',
      key: 'activeConstituent',
      label: 'Active constituent',
      required: true,
    },
    {
      kind: 'text',
      key: 'apvmaNumber',
      label: 'APVMA registration no.',
      required: true,
      hint: 'On the product label.',
    },
    { kind: 'text', key: 'batchNumber', label: 'Batch number', required: true },
    {
      kind: 'text',
      key: 'dilutionRate',
      label: 'Dilution rate',
      placeholder: 'e.g. 10 mL per 1 L',
      required: true,
    },
    { kind: 'text', key: 'targetPest', label: 'Target pest', required: true },
    {
      kind: 'chips',
      key: 'treatedAreas',
      label: 'Treated areas',
      options: TREATED_AREAS.map((a) => ({ value: a, label: a })),
      required: true,
    },
    {
      kind: 'text',
      key: 'weather',
      label: 'Weather conditions',
      placeholder: 'e.g. Fine, 24°C, light NE wind',
    },
    {
      kind: 'area',
      key: 'notes',
      label: 'Notes',
      rows: 3,
      placeholder: 'Anything the client should know.',
    },
    {
      kind: 'photos',
      key: 'photos',
      label: 'Photos',
      slots: ['Before', 'After'],
    },
  ],
  schema: z.object({
    product: requiredText('Product name'),
    activeConstituent: requiredText('Active constituent'),
    apvmaNumber,
    batchNumber: requiredText('Batch number'),
    dilutionRate: requiredText('Dilution rate'),
    targetPest: requiredText('Target pest'),
    treatedAreas: z
      .array(z.string())
      .min(1, 'Select at least one treated area'),
    weather: z.string().optional(),
    notes: z.string().optional(),
  }),
  boilerplate: [
    'This record documents a pesticide application carried out by a licensed pest management technician.',
    'The product named above is registered with the Australian Pesticides and Veterinary Medicines Authority (APVMA) and was applied strictly in accordance with its approved label directions.',
    'Re-entry and ventilation periods stated on the product label must be observed. Keep children and pets away from treated surfaces until dry.',
    'Retain this record for the period required by your state or territory regulator.',
  ].join('\n\n'),
}
