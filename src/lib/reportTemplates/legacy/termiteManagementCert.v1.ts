/**
 * FROZEN — the v1 wording, exactly as it shipped before the verbatim rewrite.
 *
 * Every report written against v1 resolves through this file, signed or still
 * a draft, and the snapshot backfill freezes from it. Its canonical hash is
 * pinned in `engine.test.ts` against the rows already on the dev deployment,
 * so any edit here — including to `shared.v1.ts` — fails the build rather than
 * silently changing what a signed document says, or making production mint a
 * different snapshot row from dev.
 *
 * Remove only once production reports zero finalised rows without a snapshot
 * AND no v1 drafts remain on any deployment.
 */
import { z } from 'zod'
import { REINSPECTION_INTERVALS, apvmaNumber, requiredText } from './shared.v1'
import type { ReportTemplate } from '../types'

/** AS 3660.2-2017 / NCC termite management certificate. */
export const termiteManagementCert: ReportTemplate = {
  id: 'termiteManagementCert',
  // v1 — the paraphrased wording that shipped before the verbatim rewrite.
  version: 1,
  name: 'Termite Management Certificate',
  shortName: 'Certificate',
  legalBasis: 'AS 3660.2-2017',
  blurb:
    'Certificate for an installed termite management system, with durable notice.',
  fields: [
    {
      kind: 'select',
      key: 'systemType',
      label: 'System type',
      options: [
        { value: 'chemical', label: 'Chemical soil barrier' },
        { value: 'physical', label: 'Physical barrier' },
        { value: 'baiting', label: 'Baiting and monitoring system' },
      ],
      required: true,
    },
    { kind: 'text', key: 'product', label: 'Product used', required: true },
    {
      kind: 'text',
      key: 'apvmaNumber',
      label: 'APVMA registration no.',
      required: true,
    },
    { kind: 'text', key: 'batchNumber', label: 'Batch number', required: true },
    {
      kind: 'text',
      key: 'lifeExpectancy',
      label: 'Life expectancy per label',
      placeholder: 'e.g. 8 years',
      required: true,
      hint: 'As stated on the product label — do not estimate.',
    },
    {
      kind: 'text',
      key: 'installDate',
      label: 'Installation date',
      placeholder: 'DD/MM/YYYY',
      required: true,
    },
    {
      kind: 'select',
      key: 'reinspectionInterval',
      label: 'Recommended re-inspection',
      options: REINSPECTION_INTERVALS,
      required: true,
    },
    {
      kind: 'area',
      key: 'treatedZones',
      label: 'Areas treated / system extent',
      rows: 3,
      required: true,
    },
    {
      kind: 'photos',
      key: 'photos',
      label: 'Photos',
      slots: ['Installation', 'Durable notice in place'],
    },
  ],
  schema: z.object({
    systemType: z.enum(['chemical', 'physical', 'baiting'], {
      message: 'Choose a system type',
    }),
    product: requiredText('Product'),
    apvmaNumber,
    batchNumber: requiredText('Batch number'),
    lifeExpectancy: requiredText('Life expectancy'),
    installDate: requiredText('Installation date'),
    reinspectionInterval: z.string().min(1, 'Choose a re-inspection interval'),
    treatedZones: requiredText('Areas treated'),
  }),
  boilerplate: [
    'This certificate records the installation of a termite management system in accordance with AS 3660.2-2017 and the National Construction Code.',
    'A termite management system reduces the risk of concealed termite entry. It is not a guarantee that termites will not attack the building. Regular competent inspections at the interval stated above remain essential.',
    'The system must not be bridged, breached or disturbed. Landscaping, paving, garden beds, concrete or attachments placed against the building after installation may render the system ineffective.',
    'A durable notice must be fixed in a prominent location — typically the meter box — recording the details of this installation.',
  ].join('\n\n'),
}

/** The label text itself, rendered in mono and printed for the meter box. */
export function durableNoticeText(input: {
  businessName: string
  /** Technician name, when known. Omitted rather than echoing the company. */
  installerName?: string
  licenceNumber?: string
  systemType: string
  product: string
  apvmaNumber: string
  installDate: string
  lifeExpectancy: string
  reinspectionInterval: string
  addressLine: string
  suburb: string
}): string {
  const systemLabel =
    input.systemType === 'chemical'
      ? 'Chemical soil barrier'
      : input.systemType === 'physical'
        ? 'Physical barrier'
        : 'Baiting and monitoring system'

  return [
    'TERMITE MANAGEMENT SYSTEM',
    'Installed to AS 3660.2',
    '',
    `Property:    ${input.addressLine}, ${input.suburb}`,
    `System:      ${systemLabel}`,
    `Product:     ${input.product}`,
    `APVMA no.:   ${input.apvmaNumber}`,
    `Installed:   ${input.installDate}`,
    `Life exp.:   ${input.lifeExpectancy}`,
    `Re-inspect:  every ${input.reinspectionInterval} months`,
    '',
    ...(input.installerName ? [`Installer:   ${input.installerName}`] : []),
    `Company:     ${input.businessName}`,
    ...(input.licenceNumber ? [`Licence:     ${input.licenceNumber}`] : []),
    '',
    'DO NOT REMOVE THIS NOTICE',
  ].join('\n')
}
