import { z } from 'zod'
import { REINSPECTION_INTERVALS, apvmaNumber, requiredText } from './shared'
import type { ReportTemplate } from './types'

/**
 * AS 3660.2-2017 / NCC termite management certificate.
 *
 * The durable notice is the reason this template has an onFinalise hook: the
 * standard requires a physical notice fixed to the building, which no app can
 * do. Generating the label and then quietly considering the job finished would
 * leave a compliance gap the operator believes is closed (§1.4).
 */
export const termiteManagementCert: ReportTemplate = {
  id: 'termiteManagementCert',
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
  onFinalise: () => [
    {
      kind: 'durableNotice',
      label: 'Fix durable notice in meter box',
      detail:
        'AS 3660.2 / NCC require a physical notice fixed to the building. The label text is on the certificate — print it and fix it on site.',
    },
  ],
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
