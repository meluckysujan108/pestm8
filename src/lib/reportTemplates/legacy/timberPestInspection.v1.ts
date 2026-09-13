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
import { REINSPECTION_INTERVALS, areasRecord } from './shared.v1'
import type { ReportTemplate } from '../types'

/** The areas AS 4349.3 expects a timber pest inspection to cover. */
export const INSPECTION_AREAS = [
  'Roof void',
  'Subfloor',
  'Interior',
  'Exterior cladding',
  'Decking and fencing',
  'Grounds',
]

/**
 * AS 4349.3-2010 timber pest inspection. The boilerplate is not decoration:
 * the scope limits are what make the report defensible, so they are locked and
 * rendered visibly non-editable.
 */
export const timberPestInspection: ReportTemplate = {
  id: 'timberPestInspection',
  // v1 — the paraphrased wording that shipped before the verbatim rewrite.
  version: 1,
  name: 'Timber Pest Inspection',
  shortName: 'Inspection',
  legalBasis: 'AS 4349.3-2010',
  blurb:
    'Visual inspection for termites, borers and fungal decay, with area-by-area access.',
  fields: [
    {
      kind: 'areas',
      key: 'areas',
      label: 'Areas inspected',
      rows: INSPECTION_AREAS,
      note: 'Any area not inspected needs a reason — this is the most common defect in a timber pest report.',
    },
    {
      kind: 'area',
      key: 'activityEvidence',
      label: 'Evidence of timber pest activity',
      rows: 3,
      placeholder:
        'Live activity, workings, mudding, frass. State None if none found.',
      required: true,
    },
    {
      kind: 'area',
      key: 'damageEvidence',
      label: 'Evidence of timber pest damage',
      rows: 3,
      placeholder: 'Location and extent. State None if none found.',
      required: true,
    },
    {
      kind: 'area',
      key: 'conduciveConditions',
      label: 'Conducive conditions',
      rows: 3,
      placeholder:
        'Poor ventilation, drainage, timber-to-ground contact, moisture.',
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
      key: 'recommendations',
      label: 'Recommendations',
      rows: 3,
    },
    {
      kind: 'photos',
      key: 'photos',
      label: 'Photos',
      slots: ['Roof void', 'Subfloor', 'Evidence', 'Other'],
    },
  ],
  schema: z.object({
    areas: areasRecord(INSPECTION_AREAS),
    activityEvidence: z.string().min(1, 'Record findings, or state None'),
    damageEvidence: z.string().min(1, 'Record findings, or state None'),
    conduciveConditions: z.string().min(1, 'Record findings, or state None'),
    reinspectionInterval: z.string().min(1, 'Choose a re-inspection interval'),
    recommendations: z.string().optional(),
  }),
  boilerplate: [
    'This is a visual inspection only, carried out in accordance with AS 4349.3-2010. It was limited to those areas and sections of the property to which reasonable access was available at the time of inspection.',
    'No invasive or destructive inspection was undertaken. No furniture, floor coverings, insulation or stored goods were moved. Areas recorded above as not inspected were inaccessible for the reason stated.',
    'This report reflects the condition of the property on the date of inspection only. Timber pest activity can commence at any time; this report should not be relied upon beyond approximately seven days from the date of inspection.',
    'This is NOT a structural inspection, a building compliance inspection, a safety inspection, or a warranty against future timber pest attack. If structural damage is suspected, a suitably qualified structural engineer should be engaged.',
  ].join('\n\n'),
}
