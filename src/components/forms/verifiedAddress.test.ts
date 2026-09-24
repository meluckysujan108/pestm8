import { afterEach, describe, expect, test, vi } from 'vitest'
import { addressSignature } from '#/lib/addressVerify'
import { STRUCTURED } from '#/lib/addressVerify.fixtures'
import { LOOKUP_UNDER_AUTOMATION_KEY } from '#/lib/addressLookup'
import {
  addressBlank,
  addressChanged,
  addressCheckFor,
  addressCheckToSend,
  checkStreetAtSave,
  issuesWithoutState,
  postcodeProblem,
} from './verifiedAddress'
import type { AddressIssue, AddressValue } from '#/lib/addressVerify'

function address(
  addressLine: string,
  suburb: string,
  state: string,
  postcode: string,
): AddressValue {
  return { addressLine, suburb, state, postcode }
}

const picked = address('12 Walcott Street', 'Mount Lawley', 'WA', '6050')
const pickedSignature = addressSignature(picked)

describe('addressCheckFor', () => {
  test('nothing picked is typed', () => {
    expect(addressCheckFor(picked, null)).toBe('typed')
  })

  test('the picked address, or it with the house number put right, stays picked', () => {
    expect(addressCheckFor(picked, pickedSignature)).toBe('picked')
    expect(
      addressCheckFor(
        { ...picked, addressLine: '14 Walcott Street' },
        pickedSignature,
      ),
    ).toBe('picked')
    expect(
      addressCheckFor(
        { ...picked, addressLine: '3/14 Walcott St' },
        pickedSignature,
      ),
    ).toBe('picked')
  })

  test('autofill rewriting the suburb, state or postcode after the pick makes it typed', () => {
    expect(
      addressCheckFor({ ...picked, postcode: '6051' }, pickedSignature),
    ).toBe('typed')
    expect(
      addressCheckFor({ ...picked, suburb: 'Maylands' }, pickedSignature),
    ).toBe('typed')
    expect(addressCheckFor({ ...picked, state: 'NSW' }, pickedSignature)).toBe(
      'typed',
    )
    expect(
      addressCheckFor(
        { ...picked, addressLine: '12 Beaufort Street' },
        pickedSignature,
      ),
    ).toBe('typed')
  })
})

describe('addressChanged', () => {
  test('a new record always has', () => {
    expect(addressChanged(picked)).toBe(true)
  })

  test('spaces around a field and the state’s case are not a change', () => {
    const saved = address('12 Walcott Street', 'Mount Lawley', 'wa', '6050')
    expect(
      addressChanged(
        address(' 12 Walcott Street ', 'Mount Lawley ', 'WA', '6050'),
        saved,
      ),
    ).toBe(false)
  })

  test('any field typed differently is', () => {
    expect(addressChanged({ ...picked, suburb: 'mount lawley' }, picked)).toBe(
      true,
    )
    expect(addressChanged({ ...picked, postcode: '6051' }, picked)).toBe(true)
  })
})

describe('addressBlank', () => {
  test('only the state, which starts on the business’s, is still blank', () => {
    expect(addressBlank(address('', ' ', 'WA', ''))).toBe(true)
    expect(addressBlank(address('', '', 'WA', '6050'))).toBe(false)
    expect(addressBlank(address('12 Walcott Street', '', '', ''))).toBe(false)
  })
})

describe('addressCheckToSend', () => {
  test('sent for a new address, and for an edited one', () => {
    expect(addressCheckToSend('picked', picked)).toBe('picked')
    expect(
      addressCheckToSend('typed', { ...picked, postcode: '6051' }, picked),
    ).toBe('typed')
  })

  test('left out for an address left as saved, or none', () => {
    expect(addressCheckToSend('typed', picked, picked)).toBeUndefined()
    expect(
      addressCheckToSend('typed', address('', '', 'WA', '')),
    ).toBeUndefined()
  })
})

describe('postcodeProblem', () => {
  test('a four-digit postcode, or none, has no problem', () => {
    expect(postcodeProblem(picked)).toBeNull()
    expect(postcodeProblem({ ...picked, postcode: '' })).toBeNull()
  })

  test('one typed now that is not four digits blocks', () => {
    const problem = postcodeProblem({ ...picked, postcode: '605' })
    expect(problem?.blocks).toBe(true)
    expect(problem?.issue.message).toBe('A postcode has 4 digits.')
  })

  test('one saved that way and left alone only warns, with its fix', () => {
    const saved = address('12 East Point Road', 'Fannie Bay', 'NT', '820')
    const problem = postcodeProblem(saved, saved)
    expect(problem?.blocks).toBe(false)
    expect(problem?.issue.fix).toEqual({
      label: 'Use 0820',
      patch: { postcode: '0820' },
    })
  })

  test('edited to another bad one, it blocks again', () => {
    const saved = address('12 East Point Road', 'Fannie Bay', 'NT', '820')
    expect(postcodeProblem({ ...saved, postcode: '82' }, saved)?.blocks).toBe(
      true,
    )
  })
})

describe('issuesWithoutState', () => {
  const outside: AddressIssue = {
    field: 'state',
    level: 'warning',
    message: 'This address is in NT — outside WA, where you work.',
  }
  const moveState: AddressIssue = {
    field: 'postcode',
    level: 'warning',
    message: '0820 is an NT postcode.',
    fix: { label: 'Use NT', patch: { state: 'NT' } },
  }
  const usual: AddressIssue = {
    field: 'postcode',
    level: 'warning',
    message: "Mount Lawley's postcode is usually 6050.",
    fix: { label: 'Use 6050', patch: { postcode: '6050' } },
  }

  test('drops what is about the state, and fixes that would change it', () => {
    expect(issuesWithoutState([outside, moveState, usual])).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: '0820 is an NT postcode.',
      },
      usual,
    ])
  })
})

describe('checkStreetAtSave', () => {
  const typo = STRUCTURED.walcotTypo.value

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function answer(json: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(json)))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  test('a street the map has is found', async () => {
    answer(STRUCTURED.walcottStreet.json)
    expect(
      await checkStreetAtSave(STRUCTURED.walcottStreet.value, {
        workState: 'WA',
      }),
    ).toEqual({ status: 'found' })
  })

  test('a street the map does not have, in a suburb it knows, is not found, with the fix', async () => {
    answer(STRUCTURED.walcotTypo.json)
    const outcome = await checkStreetAtSave(typo, { workState: 'WA' })
    expect(outcome.status).toBe('not-found')
    expect(outcome.status === 'not-found' && outcome.issue.field).toBe(
      'addressLine',
    )
  })

  test('an answer that says nothing clear is unknown', async () => {
    answer({ type: 'FeatureCollection', features: [] })
    expect(await checkStreetAtSave(typo, { workState: 'WA' })).toEqual({
      status: 'unknown',
    })
  })

  test('no answer is no signal, never thrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError())),
    )
    expect(await checkStreetAtSave(typo, {})).toEqual({ status: 'no-signal' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    )
    expect(await checkStreetAtSave(typo, {})).toEqual({ status: 'no-signal' })
  })

  test('offline is no signal without asking', async () => {
    const fetchMock = answer(STRUCTURED.walcotTypo.json)
    vi.stubGlobal('navigator', { onLine: false })
    expect(await checkStreetAtSave(typo, {})).toEqual({ status: 'no-signal' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('under a test runner, or with too little typed, it is not asked', async () => {
    const fetchMock = answer(STRUCTURED.walcotTypo.json)
    expect(await checkStreetAtSave({ ...typo, suburb: '' }, {})).toEqual({
      status: 'skipped',
    })

    vi.stubGlobal('navigator', { webdriver: true, onLine: true })
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(await checkStreetAtSave(typo, {})).toEqual({ status: 'skipped' })
    expect(fetchMock).not.toHaveBeenCalled()

    // A spec about the lookup opts in.
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === LOOKUP_UNDER_AUTOMATION_KEY ? 'on' : null,
    })
    expect((await checkStreetAtSave(typo, {})).status).toBe('not-found')
  })
})
