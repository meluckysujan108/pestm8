import { describe, expect, test } from 'vitest'
import { joinJobTypes, normaliseJobTypes, splitJobTypes } from './jobTypes'

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
