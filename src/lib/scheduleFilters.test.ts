import { describe, expect, test } from 'vitest'
import {
  computeStaffLoad,
  filterDayJobs,
  filterSearchOf,
  isOnJob,
} from './scheduleFilters'
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

describe('a job for more than one person', () => {
  const shared = {
    ...job('Terence', 'booked'),
    alsoGoing: [{ _id: 'Kevin', name: 'Kevin', colour: '#0F766E' }],
  }

  test('counts for each person on it', () => {
    const load = computeStaffLoad([shared, job('Kevin', 'booked')])
    expect(load).toEqual([
      expect.objectContaining({ membershipId: 'Kevin', count: 2 }),
      expect.objectContaining({ membershipId: 'Terence', count: 1 }),
    ])
  })

  test('is on the list of each person on it, and no one else', () => {
    expect(isOnJob(shared, 'Terence')).toBe(true)
    expect(isOnJob(shared, 'Kevin')).toBe(true)
    expect(isOnJob(shared, 'Sam')).toBe(false)
    expect(isOnJob(job('Sam', 'booked'), 'Sam')).toBe(true)
  })
})

describe('the Schedule’s filters in its address', () => {
  test('say nothing at their defaults, so an unfiltered day’s address is bare', () => {
    expect(filterSearchOf('all', 'all', 'all')).toEqual({
      status: undefined,
      staff: undefined,
    })
    // The phone opens on the viewer's own jobs: that is no filter to write.
    expect(filterSearchOf('all', 'me', 'me')).toEqual({
      status: undefined,
      staff: undefined,
    })
  })

  test('write what differs: "everyone" is written where the device opens on someone', () => {
    expect(filterSearchOf('booked', 'all', 'me')).toEqual({
      status: 'booked',
      staff: 'all',
    })
    expect(filterSearchOf('all', 'kevin', 'all')).toEqual({
      status: undefined,
      staff: 'kevin',
    })
  })

  test('narrow the day by status and by whoever is on the job', () => {
    const day = [
      { ...job('kevin', 'booked'), alsoGoing: [{ _id: 'sam' }] },
      job('sam', 'completed'),
      job('terence', 'booked'),
    ]
    expect(filterDayJobs(day, 'all', 'all')).toHaveLength(3)
    expect(filterDayJobs(day, 'booked', 'all')).toHaveLength(2)
    // Sam's filter keeps the job he is also going on.
    expect(filterDayJobs(day, 'all', 'sam')).toHaveLength(2)
    expect(filterDayJobs(day, 'booked', 'sam')).toHaveLength(1)
    expect(filterDayJobs(day, 'invoiced', 'all')).toHaveLength(0)
  })
})
