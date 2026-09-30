/**
 * What `jobTypes.manage` and `jobTypes.list` answer for the harness: the real
 * client's list as it would read after the owner's first visit to Settings →
 * Job types (names and counts from prod, read-only, 30 Sept 2026).
 */
type Report =
  'serviceReport' | 'timberPestInspection' | 'termiteManagementCert' | 'none'

const type = (
  name: string,
  report: Report,
  jobs: number,
  series = 0,
  offered = true,
) => ({ name, report, offered, formerNames: [] as Array<string>, jobs, series })

export const JOB_TYPES_MANAGE = {
  isDefault: true,
  complete: true,
  types: [
    type('Ants', 'serviceReport', 3),
    type('Bed Bugs', 'none', 0, 0, false),
    type('Cockroaches', 'serviceReport', 21, 2),
    type('General Pest Control', 'serviceReport', 38, 4),
    type('Rodents', 'serviceReport', 0),
    type('Spiders', 'serviceReport', 1),
    type('Termite Inspection', 'timberPestInspection', 1),
    type('Termite Treatment', 'termiteManagementCert', 2),
    type('Wasps', 'serviceReport', 0),
  ],
  typedIn: [
    { name: 'Ants Block Spray', jobs: 1, series: 0 },
    { name: 'Ants block Spray inc GPC', jobs: 1, series: 0 },
    { name: 'Block spray Ants & External Spiders only', jobs: 1, series: 0 },
    {
      name: 'Commercial Cockroach Treatment and Rodent Bait Top up',
      jobs: 0,
      series: 1,
    },
    { name: 'General Pest Control & Spot Ants', jobs: 1, series: 0 },
    { name: 'Gpc & Tpi', jobs: 1, series: 0 },
    { name: 'School Pest Control Commercial', jobs: 1, series: 0 },
  ],
}

export const JOB_TYPES_LIST = JOB_TYPES_MANAGE.types.map(
  ({ name, report, offered, formerNames }) => ({
    name,
    report,
    offered,
    formerNames,
  }),
)
