import { expect, test } from 'vitest'
import { stateOfPostcode } from './postcodes'

test.each([
  ['6062', 'WA'], // Morley
  [' 6053 ', 'WA'],
  ['0800', 'NT'], // Darwin
  ['0200', 'ACT'],
  ['2600', 'ACT'], // Canberra, inside NSW's range
  ['2620', 'NSW'], // Queanbeyan, just past it
  ['2913', 'ACT'],
  ['2000', 'NSW'],
  ['3000', 'VIC'],
  ['8001', 'VIC'],
  ['4000', 'QLD'],
  ['9726', 'QLD'],
  ['5000', 'SA'],
  ['7000', 'TAS'],
])('%s is in %s', (postcode, state) => {
  expect(stateOfPostcode(postcode)).toBe(state)
})

test.each(['', '0000', '6O53', '60530', '605'])(
  '"%s" is not a postcode',
  (postcode) => {
    expect(stateOfPostcode(postcode)).toBeUndefined()
  },
)
