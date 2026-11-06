import { describe, expect, test } from 'vitest'
import {
  computeStaffLoad,
  dayTravelHints,
  daySortOf,
  filterDayJobs,
  filterSearchOf,
  hasService,
  isOnJob,
  recurringSortOf,
  servicesOf,
  sortDayJobs,
  sortParamOf,
} from './scheduleFilters'
import type { JobStatus } from '../../convex/lib/jobStatus'

const job = (who: string, status: JobStatus) => ({
  assignedMembershipId: who,
  assigneeName: who,
  assigneeColour: '#0A84FF',
  status,
  jobType: 'General Pest Control',
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

describe('the day’s Service filter', () => {
  test('matches any of the services a job’s label joins, whatever the case', () => {
    const both = { jobType: 'General Pest Control, Termite Inspection' }
    expect(hasService(both, 'Termite Inspection')).toBe(true)
    expect(hasService(both, 'termite inspection')).toBe(true)
    expect(hasService(both, 'General Pest Control')).toBe(true)
    expect(hasService(both, 'Termite')).toBe(false)
  })

  test('offers each of the day’s services once, A–Z, and keeps the one chosen', () => {
    const day = [
      { jobType: 'Termite Inspection' },
      { jobType: 'General Pest Control, termite inspection' },
      { jobType: 'Bees' },
    ]
    expect(servicesOf(day, 'all')).toEqual([
      'Bees',
      'General Pest Control',
      'Termite Inspection',
    ])
    // Chosen yesterday and on no job today: still there to take back.
    expect(servicesOf(day, 'Possums')).toContain('Possums')
    expect(servicesOf(day, 'bees')).toHaveLength(3)
  })

  test('narrows the day with the other filters', () => {
    const day = [
      { ...job('kevin', 'booked'), jobType: 'Bees, Wasps' },
      { ...job('kevin', 'completed'), jobType: 'Wasps' },
      job('sam', 'booked'),
    ]
    expect(filterDayJobs(day, 'all', 'all', 'Wasps')).toHaveLength(2)
    expect(filterDayJobs(day, 'booked', 'all', 'wasps')).toHaveLength(1)
    expect(filterDayJobs(day, 'all', 'sam', 'Wasps')).toHaveLength(0)
    expect(filterSearchOf('all', 'all', 'all', 'Wasps')).toEqual({
      service: 'Wasps',
    })
  })
})

describe('the day’s sort', () => {
  const at = (h: number) => Date.UTC(2026, 10, 6, h)
  const card = (
    id: string,
    who: string,
    suburb: string,
    hour: number,
    status: JobStatus = 'booked',
  ) => ({
    _id: id,
    assignedMembershipId: who,
    assigneeName: who,
    suburb,
    scheduledAt: at(hour),
    status,
  })
  // As `listDay` sends it: by start, finished work last.
  const day = [
    card('a', 'Terence', 'Subiaco', 8),
    card('b', 'Kevin', 'Bayswater', 9),
    card('c', 'Terence', 'Bayswater', 10),
    card('d', 'Kevin', 'Subiaco', 11),
    card('e', 'Kevin', 'Armadale', 7, 'completed'),
  ]
  const ids = (jobs: Array<{ _id: string }>) => jobs.map((j) => j._id)

  test('by time is the day as the server sent it', () => {
    expect(sortDayJobs(day, 'time')).toBe(day)
  })

  test('by suburb, A–Z then by time, with finished work still last', () => {
    expect(ids(sortDayJobs(day, 'suburb'))).toEqual(['b', 'c', 'a', 'd', 'e'])
  })

  test('by technician, each person’s jobs together in time order', () => {
    expect(ids(sortDayJobs(day, 'technician'))).toEqual([
      'b',
      'd',
      'a',
      'c',
      'e',
    ])
  })

  test('puts a job with no suburb after the rest', () => {
    const blank = card('f', 'Kevin', '', 6)
    expect(ids(sortDayJobs([blank, ...day], 'suburb')).at(-2)).toBe('f')
  })

  test('is one parameter in the address, each view’s default left out', () => {
    expect(daySortOf(undefined)).toBe('time')
    expect(daySortOf('suburb')).toBe('suburb')
    // The Recurring view's sort is no sort of the day's.
    expect(daySortOf('client')).toBe('time')
    expect(recurringSortOf('client')).toBe('client')
    expect(recurringSortOf('suburb')).toBe('toBook')
    expect(sortParamOf('time')).toBeUndefined()
    expect(sortParamOf('toBook')).toBeUndefined()
    expect(sortParamOf('technician')).toBe('technician')
  })
})

describe('the hops between the day’s cards', () => {
  const stop = (id: string, who: string, lat: number) => ({
    _id: id,
    assignedMembershipId: who,
    suburb: id,
    lat,
  })
  const coords = (s: { lat: number }) => ({ lat: s.lat, lng: 115.8 })
  // Kevin, then Terence, then Kevin again: half a degree apart each.
  const jobs = [stop('a', 'kevin', -31.9), stop('b', 'terence', -32.4)]
  const later = stop('c', 'kevin', -31.4)

  test('by time run down the day', () => {
    const hints = dayTravelHints([...jobs, later], 'time', coords)
    expect(hints.a).toBeNull()
    expect(hints.b).toMatch(/km/)
    expect(hints.c).toMatch(/km/)
  })

  test('by technician begin again at each person', () => {
    const hints = dayTravelHints(
      [jobs[0], later, jobs[1]],
      'technician',
      coords,
    )
    expect(hints.a).toBeNull()
    expect(hints.c).toMatch(/km/)
    // Terence's first job: no hop from Kevin's last.
    expect(hints.b).toBeNull()
  })

  test('by suburb are left out: the card above is no stop on a route', () => {
    expect(dayTravelHints([...jobs, later], 'suburb', coords)).toEqual({})
  })
})
