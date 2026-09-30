import { describe, expect, test } from 'vitest'
import { everyoneOnJob, firstName, namesOf } from './jobPeople'

describe('everyone on a job, as the app names them', () => {
  test('the lead first, then everyone also going', () => {
    const people = everyoneOnJob({
      assigneeName: 'Terence Walsh',
      assigneeColour: '#0A84FF',
      alsoGoing: [{ name: 'Kevin Doyle', colour: '#0F766E' }],
    })
    expect(people.map((p) => p.name)).toEqual(['Terence Walsh', 'Kevin Doyle'])
  })

  test('a backend older than shared jobs is just the lead', () => {
    expect(
      everyoneOnJob({ assigneeName: 'Terence', assigneeColour: '#0A84FF' }),
    ).toEqual([{ name: 'Terence', colour: '#0A84FF' }])
  })

  test('names read as a sentence', () => {
    expect(namesOf([{ name: 'Terence' }])).toBe('Terence')
    expect(namesOf([{ name: 'Terence' }, { name: 'Kevin' }])).toBe(
      'Terence and Kevin',
    )
    expect(
      namesOf([{ name: 'Terence' }, { name: 'Kevin' }, { name: 'Sam' }]),
    ).toBe('Terence, Kevin and Sam')
    expect(firstName('Kevin Doyle')).toBe('Kevin')
  })
})
