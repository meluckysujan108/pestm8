import { describe, expect, test } from 'vitest'
import { computeStaffLoad } from './scheduleFilters'
import type { JobStatus } from '../../convex/lib/jobStatus'

const job = (who: string, status: JobStatus) => ({
  assignedMembershipId: who,
  assigneeName: who,
  assigneeColour: '#0A84FF',
  status,
})

describe('the staff filter’s per-person count', () => {
  test('counts booked jobs, not projected visits (brief §2: never counted)', () => {
    const load = computeStaffLoad([
      job('Terence', 'booked'),
      job('Terence', 'recurring'),
      job('Kevin', 'pending'),
      job('Kevin', 'completed'),
      job('Kevin', 'recurring'),
    ])
    expect(load).toEqual([
      expect.objectContaining({ name: 'Kevin', count: 2 }),
      expect.objectContaining({ name: 'Terence', count: 1 }),
    ])
  })

  test('still lists someone whose only visit is a projection, at 0', () => {
    const load = computeStaffLoad([
      job('Terence', 'booked'),
      job('Priya', 'recurring'),
    ])
    expect(load.find((s) => s.name === 'Priya')).toMatchObject({ count: 0 })
  })
})
