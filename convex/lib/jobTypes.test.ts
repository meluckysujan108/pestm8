import { describe, expect, test } from 'vitest'
import {
  DEFAULT_JOB_TYPES,
  canonicalJobTypeLabel,
  findJobType,
  joinJobTypes,
  jobTypeNameProblem,
  normaliseJobTypes,
  splitJobTypes,
} from './jobTypes'
import {
  suggestTemplates,
  treatmentsForJobType,
} from '../../src/lib/reportTemplates/suggest'

describe('a job label naming several services', () => {
  test('a single service reads back as itself', () => {
    expect(splitJobTypes('Termite Inspection')).toEqual(['Termite Inspection'])
    // Punctuation other than a comma is part of the name.
    const long =
      'Commercial kitchen follow-up: German cockroach flush and gel baiting (after hours)'
    expect(splitJobTypes(long)).toEqual([long])
  })

  test('several services come back in the order they were chosen', () => {
    expect(
      splitJobTypes('General Pest Control, Termite Inspection, Rodents'),
    ).toEqual(['General Pest Control', 'Termite Inspection', 'Rodents'])
  })

  test('stray spaces, empty entries and repeats are tidied away', () => {
    expect(splitJobTypes('  Ants ,, rodents,  Rodents ,Wasps  ')).toEqual([
      'Ants',
      'rodents',
      'Wasps',
    ])
    expect(splitJobTypes('Bed   Bugs')).toEqual(['Bed Bugs'])
  })

  test('nothing is no services', () => {
    expect(splitJobTypes('')).toEqual([])
    expect(splitJobTypes(' , ')).toEqual([])
    expect(splitJobTypes(undefined)).toEqual([])
    expect(splitJobTypes(null)).toEqual([])
  })

  test('joining is what splitting reads back', () => {
    const label = joinJobTypes(['General Pest Control', 'Rodents'])
    expect(label).toBe('General Pest Control, Rodents')
    expect(splitJobTypes(label)).toEqual(['General Pest Control', 'Rodents'])
    expect(joinJobTypes(['Ants'])).toBe('Ants')
    expect(joinJobTypes([])).toBe('')
  })

  test('a name typed with a comma in it is two services', () => {
    expect(normaliseJobTypes(['Ants', 'Possums, rats'])).toEqual([
      'Ants',
      'Possums',
      'rats',
    ])
    expect(joinJobTypes(['Possums,rats', 'possums'])).toBe('Possums, rats')
  })
})

describe('a label read against the business’s own list', () => {
  const list = [
    { name: 'Rodent Baiting', formerNames: ['Rodents', 'Rats'] },
    { name: 'Ants', formerNames: [] },
    // A current name wins over someone else's old one.
    { name: 'Rats', formerNames: [] },
  ]

  test('finds a service by its name in any capitals, or by an old name', () => {
    expect(findJobType(list, 'ANTS')?.name).toBe('Ants')
    expect(findJobType(list, 'rodents')?.name).toBe('Rodent Baiting')
    expect(findJobType(list, 'rats')?.name).toBe('Rats')
    expect(findJobType(list, 'Possums')).toBeUndefined()
  })

  test('spells each known service the list’s way and leaves the rest as typed', () => {
    expect(canonicalJobTypeLabel('ants, rodents, Possum Removal', list)).toBe(
      'Ants, Rodent Baiting, Possum Removal',
    )
  })

  test('comes back untouched when nothing changes, spacing and all', () => {
    const label = 'Ants,Possum Removal'
    expect(canonicalJobTypeLabel(label, list)).toBe(label)
  })

  test('a swap replaces one service with several, each named once', () => {
    expect(
      canonicalJobTypeLabel('Gpc & Tpi, Ants', list, {
        from: 'gpc & tpi',
        to: ['Ants', 'Rodent Baiting'],
      }),
    ).toBe('Ants, Rodent Baiting')
  })

  test('a name with a comma, blank or too long is no service', () => {
    expect(jobTypeNameProblem('Possums, rats')).toBe('JOB_TYPE_COMMA')
    expect(jobTypeNameProblem('  ')).toBe('JOB_TYPE_EMPTY')
    expect(jobTypeNameProblem('x'.repeat(61))).toBe('JOB_TYPE_TOO_LONG')
    expect(jobTypeNameProblem(' Possum  Removal ')).toBeNull()
  })
})

describe('the report a service produces', () => {
  test('the built-in nine suggest what the fixed table always did', () => {
    for (const entry of DEFAULT_JOB_TYPES) {
      expect(suggestTemplates(entry.name, DEFAULT_JOB_TYPES)).toEqual(
        suggestTemplates(entry.name),
      )
    }
  })

  test('the list answers first, No report included', () => {
    const list = [
      {
        name: 'Rodent Bait Top-Up',
        report: 'serviceReport' as const,
        formerNames: [],
      },
      { name: 'Termite Inspection', report: 'none' as const, formerNames: [] },
    ]
    expect(suggestTemplates('Rodent Bait Top-Up', list)).toEqual([
      'serviceReport',
    ])
    expect(suggestTemplates('Termite Inspection', list)).toEqual([])
    // Not on the list: the old table and wording rules, as before.
    expect(suggestTemplates('Termite Barrier Top-Up', list)).toEqual([
      'termiteManagementCert',
    ])
  })

  test('a renamed service still ticks the treatment of the name it had', () => {
    const list = [
      {
        name: 'Rodent Baiting',
        report: 'serviceReport' as const,
        formerNames: ['Rodents'],
      },
    ]
    expect(treatmentsForJobType('Rodent Baiting', list)).toEqual(['Rodents'])
    expect(treatmentsForJobType('Rodent Baiting')).toEqual([])
  })
})

describe('a swap read against the list as it is now', () => {
  test('a target renamed since the swap was asked for is written as its new name', () => {
    const list = [
      { name: 'Pest Control', formerNames: ['General Pest Control'] },
    ]
    expect(
      canonicalJobTypeLabel('Gpc', list, {
        from: 'Gpc',
        to: ['General Pest Control'],
      }),
    ).toBe('Pest Control')
  })
})
