import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  parsePhotonResponse,
  photonUrl,
  postcodeStateHint,
  searchAddresses,
} from './addressLookup'
import { PHOTON } from './addressLookup.fixtures'
import type { PhotonFixture } from './addressLookup.fixtures'

function labels(fixture: PhotonFixture, biasState = fixture.biasState) {
  return parsePhotonResponse(fixture.json, fixture.typed, biasState).map(
    (s) => s.label,
  )
}

function paramsOf(url: string) {
  return new URL(url).searchParams
}

/** One Photon feature, shaped like the real ones in the fixtures. */
function feature(properties: Record<string, unknown>) {
  return {
    type: 'Feature',
    properties: {
      type: 'street',
      osm_key: 'highway',
      osm_value: 'primary',
      name: 'Walcott Street',
      district: 'Mount Lawley',
      city: 'Perth',
      state: 'Western Australia',
      postcode: '6050',
      countrycode: 'AU',
      ...properties,
    },
  }
}

function reply(...features: Array<unknown>) {
  return { type: 'FeatureCollection', features }
}

function lines(json: unknown, typed: string) {
  return parsePhotonResponse(json, typed).map((s) => s.addressLine)
}

describe('the Photon request', () => {
  test('asks for Australian houses and streets only', () => {
    const params = paramsOf(photonUrl('Walcott Street Mount Lawley'))
    expect(params.get('q')).toBe('Walcott Street Mount Lawley')
    expect(params.get('bbox')).toBe('112,-44,154,-10')
    expect(params.getAll('layer')).toEqual(['house', 'street'])
    expect(params.has('lat')).toBe(false)
  })

  test("leans toward the business's capital when its state is known", () => {
    const perth = paramsOf(photonUrl('Walcott St', 'WA'))
    expect([perth.get('lat'), perth.get('lon')]).toEqual([
      '-31.9523',
      '115.8613',
    ])
    const darwin = paramsOf(photonUrl('Smith St', 'nt'))
    expect([darwin.get('lat'), darwin.get('lon')]).toEqual([
      '-12.4637',
      '130.8444',
    ])
    expect(paramsOf(photonUrl('Smith St', 'XX')).has('lat')).toBe(false)
  })

  test('sends the street without the house, unit or lot number', () => {
    const q = (typed: string) => paramsOf(photonUrl(typed)).get('q')
    expect(q('12 Walcott St Mt Lawley')).toBe('Walcott St Mt Lawley')
    expect(q('3/12 Smith St Perth')).toBe('Smith St Perth')
    expect(q('Unit 3/12 Smith St')).toBe('Smith St')
    expect(q('12-14 Smith St')).toBe('Smith St')
    expect(q('Lot 50 Whitewood Road Howard Springs')).toBe(
      'Whitewood Road Howard Springs',
    )
    expect(q('3rd Avenue Mount Lawley')).toBe('3rd Avenue Mount Lawley')
    expect(q('Unit 3, 12 Walcott St')).toBe('Walcott St')
    expect(q('Shop 2/45 Beaufort St')).toBe('Beaufort St')
    expect(q('5 3rd Avenue Mount Lawley')).toBe('3rd Avenue Mount Lawley')
  })
})

describe('numbered streets', () => {
  const third = feature({ name: 'Third Avenue' })

  test('"3rd" finds Third Avenue, with the house carried over', () => {
    expect(lines(reply(third), '5 3rd Avenue Mount Lawley')).toEqual([
      '5 Third Avenue',
    ])
    expect(lines(reply(third), '3rd Ave')).toEqual(['Third Avenue'])
  })

  test('and "Third" finds a street filed as "3rd"', () => {
    expect(
      lines(reply(feature({ name: '3rd Avenue' })), '5 Third Ave'),
    ).toEqual(['5 3rd Avenue'])
  })

  test('a different number is a different street', () => {
    expect(lines(reply(third), '5 2nd Avenue')).toEqual([])
  })
})

describe('suggestions from real Photon replies', () => {
  test('carries the typed number onto the street', () => {
    expect(
      parsePhotonResponse(
        PHOTON.walcottStreet.json,
        PHOTON.walcottStreet.typed,
        'WA',
      ),
    ).toEqual([
      {
        key: '12 walcott street|mount lawley|6050',
        label: '12 Walcott Street, Mount Lawley WA 6050',
        addressLine: '12 Walcott Street',
        suburb: 'Mount Lawley',
        state: 'WA',
        postcode: '6050',
      },
    ])
  })

  test('leaves out a hospital found by its name, on another street', () => {
    // St John of God Mt Lawley Hospital is on Thirlmere Road. The optometrist
    // is on Walcott Street, so it is Walcott Street again, once.
    expect(labels(PHOTON.walcottStMtLawley)).toEqual([
      '12 Walcott Street, Mount Lawley WA 6050',
    ])
  })

  test('takes the suburb, and none of the bus stops nearby', () => {
    expect(labels(PHOTON.mudstoneRoad)).toEqual([
      '10 Mudstone Road, Treeby WA 6164',
    ])
  })

  test('drops shared paths filed as streets', () => {
    expect(labels(PHOTON.romeoRoad)).toEqual(['15 Romeo Road, Alkimos WA 6038'])
  })

  test('keeps the unit on each Smith Street in Perth, five at most', () => {
    // First is the church at 31 Smith Street, as the street it is on; the
    // bus stop is on South Street.
    expect(labels(PHOTON.smithStUnit)).toEqual([
      '3/12 Smith Street, Highgate WA 6003',
      '3/12 Smith Street, Perth WA 6000',
      '3/12 Smith Street, Dianella WA 6059',
      '3/12 Smith Street, Morley WA 6062',
      '3/12 Smith Street, Claremont WA 6010',
    ])
  })

  test('keeps the lot, once, over every business along the road', () => {
    // Also the suburb (Howard Springs) over the city Photon files the road
    // under (Palmerston).
    expect(labels(PHOTON.whitewoodRoadLot)).toEqual([
      'Lot 50 Whitewood Road, Howard Springs NT 0835',
    ])
  })

  test('reads "Pt" as Point, from a bus stop the road has', () => {
    expect(labels(PHOTON.eastPointRoad)).toEqual([
      '12 East Point Road, Fannie Bay NT 0820',
    ])
  })

  test('makes a street out of the shops on it, but not Little Marine Parade', () => {
    // All ten results are shops, sights and lanes; the state comes back as
    // "WA" on some and in full on others.
    expect(labels(PHOTON.marineParade)).toEqual([
      '88 Marine Parade, Cottesloe WA 6011',
    ])
  })

  test('finds the road from a shop when "Mt" would have sunk it', () => {
    expect(labels(PHOTON.scarboroughBeachRoad)).toEqual([
      '25 Scarborough Beach Road, Mount Hawthorn WA 6016',
    ])
  })

  test('offers each suburb a street runs through', () => {
    expect(labels(PHOTON.beaufortStreet)).toEqual([
      '15 Beaufort Street, Mount Lawley WA 6050',
      '15 Beaufort Street, Perth WA 6000',
      '15 Beaufort Street, Inglewood WA 6052',
    ])
  })

  test('completes a street name still being typed', () => {
    expect(labels(PHOTON.partlyTyped)).toEqual([
      '25 Scarborough Beach Road, Mount Hawthorn WA 6016',
      '25 Scarborough Beach Road, Osborne Park WA 6017',
      '25 Scarborough Beach Road, Doubleview WA 6018',
    ])
  })

  test('falls back to the town when there is no suburb', () => {
    expect(labels(PHOTON.toddStreet)).toEqual([
      'Todd Street, Alice Springs NT 0870',
    ])
  })

  test("puts the business's own state first, otherwise in Photon's order", () => {
    expect(labels(PHOTON.smithSt)).toEqual([
      '12 Smith Street, Collingwood VIC 3066',
      '12 Smith Street, East Melbourne VIC 3002',
      '12 Smith Street, Fitzroy VIC 3065',
      '12 Smith Street, Clifton Hill VIC 3068',
      '12 Smith Street, Darwin City NT 0800',
    ])
    expect(labels(PHOTON.smithSt, 'nt')[0]).toBe(
      '12 Smith Street, Darwin City NT 0800',
    )
  })

  test('keeps nothing from overseas', () => {
    // The bare query's reply: Trinidad, New Zealand, Canada, Scotland, and
    // one Perth church.
    expect(labels(PHOTON.smithStUnitUnfiltered)).toEqual([
      '3/12 Smith Street, Highgate WA 6003',
    ])
  })

  test('an empty reply or a refusal is no suggestions', () => {
    expect(labels(PHOTON.nothing)).toEqual([])
    expect(labels(PHOTON.refused)).toEqual([])
  })
})

describe('the house number carried onto a street', () => {
  test.each([
    ['12 walcott', '12 Walcott Street'],
    ['12a Walcott St', '12A Walcott Street'],
    ['3/12 Walcott', '3/12 Walcott Street'],
    ['3 / 12 Walcott', '3/12 Walcott Street'],
    ['unit 3/12 Walcott', 'Unit 3/12 Walcott Street'],
    ['12-14 Walcott', '12-14 Walcott Street'],
    ['12 - 14 Walcott', '12-14 Walcott Street'],
    ['lot 50 Walcott', 'Lot 50 Walcott Street'],
    ['12, Walcott', '12 Walcott Street'],
    ['  12   Walcott  ', '12 Walcott Street'],
    ['Walcott St', 'Walcott Street'],
    // The unit's word comes along, and so does the comma form after one.
    ['U3/12 Walcott St', 'Unit 3/12 Walcott Street'],
    ['Unit3/12 Walcott', 'Unit 3/12 Walcott Street'],
    ['Unit 3, 12 Walcott St', 'Unit 3, 12 Walcott Street'],
    ['1-3/12 Walcott', '1-3/12 Walcott Street'],
    ['Shop 2/45 Walcott St', 'Shop 2/45 Walcott Street'],
    ['suite 4, 100 Walcott', 'Suite 4, 100 Walcott Street'],
    ['Level 2, 100 Walcott', 'Level 2, 100 Walcott Street'],
    ['Apt 7/3 Walcott', 'Apt 7/3 Walcott Street'],
  ])('%j fills %j', (typed, addressLine) => {
    expect(lines(reply(feature({})), typed)).toEqual([addressLine])
  })

  test("never a house's own number in place of the one typed", () => {
    const house = feature({
      type: 'house',
      osm_key: 'building',
      osm_value: 'house',
      name: undefined,
      housenumber: '10',
      street: 'Walcott Street',
    })
    expect(lines(reply(house), '14 Walcott')).toEqual(['14 Walcott Street'])
    expect(lines(reply(house), 'Walcott')).toEqual(['Walcott Street'])
  })
})

describe('whether a result is the street typed', () => {
  test.each([
    ['Mount Eliza Road', 'Mt Eliza Rd'],
    ['North Lake Road', 'Nth Lake Rd'],
    ['Great Eastern Highway', 'Gt Eastern Hwy'],
    ['St Georges Terrace', 'St Georges Tce Perth'],
    ['Mudstone Road', 'Mudstone Rd'],
    ['Mudstone Road', 'Mudstome Rd'],
    ['Walcott Street', 'Wal'],
    ['The Esplanade', 'Esplanade Scarborough'],
  ])('%j is kept for %j', (street, typed) => {
    expect(lines(reply(feature({ name: street })), `12 ${typed}`)).toHaveLength(
      1,
    )
  })

  test.each([
    ['Walgett Street', 'Walcott'],
    ['Waycott Avenue', 'Walcott'],
    ['Little Walcott Street', 'Walcott St North Perth'],
    ['Ross Smith Avenue', 'Smith St'],
  ])('%j is not kept for %j', (street, typed) => {
    expect(lines(reply(feature({ name: street })), `12 ${typed}`)).toEqual([])
  })
})

describe('whatever Photon sends back', () => {
  test.each([
    null,
    undefined,
    'Walcott Street',
    42,
    [],
    {},
    { features: 'none' },
    { features: [null, 7, 'x', {}, { properties: null }, { properties: [] }] },
  ])('%j is no suggestions', (json) => {
    expect(parsePhotonResponse(json, '12 Walcott')).toEqual([])
  })

  test('drops a result without a street, a suburb, or any state', () => {
    const json = reply(
      feature({ name: '' }),
      feature({ type: 'house', name: 'Some Cafe', street: undefined }),
      feature({ district: undefined, city: undefined, locality: undefined }),
      feature({ state: undefined, postcode: undefined }),
      feature({ type: 'district' }),
      feature({ type: 'city' }),
      feature({ countrycode: 'NZ' }),
    )
    expect(parsePhotonResponse(json, '12 Walcott')).toEqual([])
  })

  test('reads the state from the postcode when Photon leaves it out', () => {
    const json = reply(
      feature({
        name: 'East Point Road',
        district: 'Fannie Bay',
        state: undefined,
        postcode: '0820',
      }),
    )
    expect(parsePhotonResponse(json, '12 East Point')[0].state).toBe('NT')
  })

  test('keeps only a four-digit postcode, and copes with numbers', () => {
    const [bad] = parsePhotonResponse(
      reply(feature({ postcode: '6050;6051' })),
      '12 Walcott',
    )
    expect([bad.postcode, bad.label]).toEqual([
      '',
      '12 Walcott Street, Mount Lawley WA',
    ])
    const [numeric] = parsePhotonResponse(
      reply(feature({ postcode: 6050 })),
      '12 Walcott',
    )
    expect(numeric.postcode).toBe('6050')
  })
})

describe('searchAddresses', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function online(respond: () => Promise<Response>) {
    const fetchFake = vi.fn(respond)
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('fetch', fetchFake)
    return fetchFake
  }

  const signal = new AbortController().signal

  test('returns the suggestions from a reply', async () => {
    const fetchFake = online(() =>
      Promise.resolve(Response.json(PHOTON.walcottStMtLawley.json)),
    )
    const found = await searchAddresses('12 Walcott St Mt Lawley', {
      signal,
      biasState: 'WA',
    })
    expect(found.map((s) => s.label)).toEqual([
      '12 Walcott Street, Mount Lawley WA 6050',
    ])
    const [url, init] = fetchFake.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(paramsOf(url).get('lat')).toBe('-31.9523')
    expect(init.signal?.aborted).toBe(false)
  })

  /** A fetch that never answers, and fails the way fetch does once aborted. */
  function hanging() {
    let seen: AbortSignal | undefined
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined
        return new Promise<Response>((_, reject) => {
          seen?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        })
      }),
    )
    return () => seen
  }

  test('a newer keystroke cancels the request in flight', async () => {
    const seen = hanging()
    const caller = new AbortController()
    const found = searchAddresses('12 Walcott', { signal: caller.signal })
    await Promise.resolve()
    caller.abort()
    expect(await found).toEqual([])
    expect(seen()?.aborted).toBe(true)
  })

  test('a request that stalls is given up after a few seconds', async () => {
    vi.useFakeTimers()
    try {
      const seen = hanging()
      const found = searchAddresses('12 Walcott', { signal })
      await vi.advanceTimersByTimeAsync(5_999)
      expect(seen()?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await found).toEqual([])
      expect(seen()?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('never throws: a failed, refused or garbled reply is no suggestions', async () => {
    online(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await searchAddresses('12 Walcott', { signal })).toEqual([])

    online(() =>
      Promise.reject(
        new DOMException('The user aborted a request.', 'AbortError'),
      ),
    )
    expect(await searchAddresses('12 Walcott', { signal })).toEqual([])

    online(() =>
      Promise.resolve(new Response('Too Many Requests', { status: 429 })),
    )
    expect(await searchAddresses('12 Walcott', { signal })).toEqual([])

    online(() => Promise.resolve(new Response('<html>', { status: 200 })))
    expect(await searchAddresses('12 Walcott', { signal })).toEqual([])
  })

  test('does not ask while offline, or before a street is typed', async () => {
    const fetchFake = vi.fn()
    vi.stubGlobal('fetch', fetchFake)
    vi.stubGlobal('navigator', { onLine: false })
    expect(await searchAddresses('12 Walcott', { signal })).toEqual([])

    vi.stubGlobal('navigator', { onLine: true })
    expect(await searchAddresses('12 Wa', { signal })).toEqual([])
    expect(await searchAddresses('Lot 50', { signal })).toEqual([])
    expect(await searchAddresses('3/12', { signal })).toEqual([])
    // Numbers it cannot read as a house: asking would find junk.
    expect(await searchAddresses('3, 12 Walcott St', { signal })).toEqual([])
    expect(await searchAddresses('12/ Walcott St', { signal })).toEqual([])
    expect(fetchFake).not.toHaveBeenCalled()
  })
})

describe('the postcode and state hint', () => {
  test('names the postcode’s own state when it disagrees', () => {
    // Both from prod: "Fannybay WA 0810" and "Darwin 2209".
    expect(postcodeStateHint('0810', 'WA')).toEqual({
      state: 'NT',
      message: '0810 is an NT postcode.',
    })
    expect(postcodeStateHint('2209', 'NT')).toEqual({
      state: 'NSW',
      message: '2209 is an NSW postcode.',
    })
    expect(postcodeStateHint('6050', 'NT')?.message).toBe(
      '6050 is a WA postcode.',
    )
  })

  test('says nothing when they agree, or the postcode is not one yet', () => {
    expect(postcodeStateHint('0820', 'NT')).toBeNull()
    expect(postcodeStateHint(' 6050 ', 'wa')).toBeNull()
    expect(postcodeStateHint('', 'WA')).toBeNull()
    expect(postcodeStateHint('08', 'WA')).toBeNull()
    expect(postcodeStateHint('6O50', 'NT')).toBeNull()
  })

  test('still hints for a border town, where the person may know better', () => {
    // Barooga NSW really is 3644: the hint offers VIC, it does not insist.
    expect(postcodeStateHint('3644', 'NSW')?.state).toBe('VIC')
  })
})
