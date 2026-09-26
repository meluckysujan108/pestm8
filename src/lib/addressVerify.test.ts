import { afterEach, describe, expect, test, vi } from 'vitest'
import { editDistance } from '../../convex/lib/contactNames'
import { stateOfPostcode } from '../../convex/lib/postcodes'
import {
  addressErrors,
  addressSignature,
  checkAddressAtSave,
  checkAddressOffline,
  checkStreetOnline,
  closestSuburb,
  loadLocalities,
  parseLocalities,
  readStreetCheck,
  readStreetName,
  stillAsPicked,
  streetCheckUrl,
  suburbKey,
  suburbWords,
  withinDistance,
} from './addressVerify'
import { LOOKUP_UNDER_AUTOMATION_KEY } from './addressLookup'
import { STRUCTURED } from './addressVerify.fixtures'
import type { AddressValue, Locality, LocalityTable } from './addressVerify'

function address(
  addressLine: string,
  suburb: string,
  state: string,
  postcode: string,
): AddressValue {
  return { addressLine, suburb, state, postcode }
}

async function offline(value: AddressValue, workState = 'WA') {
  return checkAddressOffline(value, { workState })
}

describe('addressErrors: the only thing that blocks a save', () => {
  test('a four-digit postcode, or none yet, is no error', () => {
    expect(addressErrors(address('', '', 'WA', '6050'))).toEqual([])
    expect(addressErrors(address('', '', 'WA', ' 6050 '))).toEqual([])
    expect(addressErrors(address('', '', 'WA', ''))).toEqual([])
  })

  test('an NT postcode missing its 0 gets it back as the fix', () => {
    expect(addressErrors(address('', 'Nightcliff', 'NT', '810'))).toEqual([
      {
        field: 'postcode',
        level: 'error',
        message: 'A postcode has 4 digits. NT postcodes start with a 0.',
        fix: { label: 'Use 0810', patch: { postcode: '0810' } },
      },
    ])
    expect(addressErrors(address('', '', 'ACT', '200'))[0].fix).toEqual({
      label: 'Use 0200',
      patch: { postcode: '0200' },
    })
  })

  test('a 0 is never offered where the state has no such postcode', () => {
    // 0605 is nobody's: WA postcodes are 6xxx.
    expect(addressErrors(address('', '', 'WA', '605'))).toEqual([
      {
        field: 'postcode',
        level: 'error',
        message: 'A postcode has 4 digits.',
      },
    ])
  })

  test('a space inside four digits is taken out by the fix', () => {
    expect(addressErrors(address('', '', 'WA', '60 50'))[0].fix).toEqual({
      label: 'Use 6050',
      patch: { postcode: '6050' },
    })
  })

  test.each(['60500', '6O50', 'WA', '12345', '6-050'])(
    '"%s" is an error',
    (postcode) => {
      const [issue] = addressErrors(address('', '', 'WA', postcode))
      expect(issue).toMatchObject({ field: 'postcode', level: 'error' })
    },
  )
})

describe('the suburb tables', () => {
  test('parse one line a suburb, with every postcode it uses', () => {
    const table = parseLocalities(
      'NSW',
      'Sydney 2000\nPunchbowl 2196 2460\nSt Clair 2759 2330\n',
    )
    expect(table.all.map((l) => l.name)).toEqual([
      'Sydney',
      'Punchbowl',
      'St Clair',
    ])
    expect(table.byKey.get('punchbowl')?.[0].postcodes).toEqual([
      '2196',
      '2460',
    ])
    expect(table.byKey.has('saintclair')).toBe(true)
    expect([...table.postcodes]).toEqual([
      '2000',
      '2196',
      '2460',
      '2759',
      '2330',
    ])
  })

  test('load one state at a time, and nothing for a state that is not one', async () => {
    const wa = await loadLocalities('wa')
    expect(wa?.state).toBe('WA')
    expect(wa?.byKey.get('mountlawley')?.[0]).toEqual({
      name: 'Mount Lawley',
      key: 'mountlawley',
      postcodes: ['6050'],
    })
    expect(await loadLocalities('XX')).toBeNull()
    expect(await loadLocalities('')).toBeNull()
  })

  // The build script repeats `stateOfPostcode`'s ranges, and files every
  // suburb under the state its postcode's number belongs to. If the two
  // copies ever disagree, a suburb goes missing from the table the checks
  // look in.
  test("file every suburb under its postcode's own state", async () => {
    const states = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']
    const tables = new Map(
      await Promise.all(
        states.map(async (s) => [s, (await loadLocalities(s))!] as const),
      ),
    )
    const missing: Array<string> = []
    for (const table of tables.values()) {
      expect(table.all.length).toBeGreaterThan(100)
      for (const locality of table.all) {
        for (const postcode of locality.postcodes) {
          const own = stateOfPostcode(postcode)
          const there = own ? tables.get(own)?.byKey.get(locality.key) : null
          if (!there?.some((l) => l.postcodes.includes(postcode))) {
            missing.push(`${locality.name} ${postcode} (${table.state})`)
          }
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('compare suburb names the way people type them', () => {
    expect(suburbKey('Mt Lawley')).toBe(suburbKey('Mount Lawley'))
    expect(suburbKey('mount  lawley ')).toBe(suburbKey('MountLawley'))
    expect(suburbKey('St Kilda')).toBe(suburbKey('Saint Kilda'))
    expect(suburbKey('Nth Fremantle')).toBe(suburbKey('North Fremantle'))
    expect(suburbKey("O'Connor")).toBe(suburbKey('OConnor'))
    expect(suburbKey('Brighton-Le-Sands')).toBe(suburbKey('Brighton Le Sands'))
    expect(suburbKey('Fanny Bay')).not.toBe(suburbKey('Fannie Bay'))
  })
})

/** A repeatable run of random numbers in [0, 1), so a failure can be run
 * again as it was. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** `closestSuburb` as it was before `withinDistance`: `editDistance` in
 * full against every name of about the same length. The answers it gave
 * are the ones to keep. */
function closestSuburbBefore(
  table: LocalityTable,
  typed: string,
  postcode: string,
): Locality | null {
  const key = suburbKey(typed)
  if (key.length < 4) return null
  const allowed = key.length <= 7 ? 1 : 2
  const typedPostcode = table.postcodes.has(postcode) ? postcode : ''
  let best: Locality | null = null
  let bestScore = Infinity
  for (const locality of table.all) {
    if (Math.abs(locality.key.length - key.length) > allowed) continue
    const distance = editDistance(key, locality.key)
    if (distance > allowed) continue
    const uses = typedPostcode !== '' && locality.postcodes.includes(postcode)
    const score = uses ? distance : distance + allowed + 1
    if (score < bestScore) {
      best = locality
      bestScore = score
    }
  }
  if (best) return best
  const words = suburbWords(typed)
  const starting = table.all.filter((locality) => {
    const theirs = suburbWords(locality.name)
    return (
      theirs.length > words.length && words.every((w, i) => theirs[i] === w)
    )
  })
  return starting.length === 1 ? starting[0] : null
}

describe('closestSuburb: quick, with the answers it always gave', () => {
  test('withinDistance is editDistance, up to the most it is asked about', () => {
    expect(withinDistance('jhon', 'john', 1)).toBe(1)
    expect(withinDistance('fanniebay', 'fannybay', 2)).toBe(2)
    expect(withinDistance('fanniebay', 'fannybay', 1)).toBe(2)
    expect(withinDistance('abcd', 'wxyz', 2)).toBe(3)
    expect(withinDistance('', 'ab', 2)).toBe(2)
    expect(withinDistance('', 'ab', 1)).toBe(2)
    expect(withinDistance('mountlawley', 'mountlawley', 0)).toBe(0)
    // Longer than the rows it starts with: they grow.
    const long = 'a'.repeat(90)
    expect(withinDistance(long, `${long}b`, 2)).toBe(1)

    // A small alphabet, so swaps, repeats and near misses are common.
    const random = seeded(7)
    const letters = 'abc'
    const word = (length: number) =>
      Array.from(
        { length },
        () => letters[Math.floor(random() * letters.length)],
      ).join('')
    const differ: Array<string> = []
    for (let n = 0; n < 5000; n++) {
      const a = word(Math.floor(random() * 9))
      const b =
        random() < 0.5 ? word(Math.floor(random() * 9)) : misspell(a, random)
      const max = Math.floor(random() * 4)
      const want = Math.min(editDistance(a, b), max + 1)
      if (withinDistance(a, b, max) !== want) differ.push(`${a}|${b}|${max}`)
    }
    expect(differ).toEqual([])
  })

  test("the same suburb as before for a few hundred slips, in every state's table", async () => {
    const random = seeded(2026)
    const states = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']
    const differ: Array<string> = []
    let found = 0
    let asked = 0
    for (const state of states) {
      const table = (await loadLocalities(state))!
      const postcodes = [...table.postcodes]
      for (let n = 0; n < 50; n++) {
        const locality = table.all[Math.floor(random() * table.all.length)]
        const pick = random()
        const typed =
          pick < 0.7
            ? misspell(locality.name, random)
            : pick < 0.85
              ? // The start of a name, for the "starts with" guess.
                locality.name.split(' ').slice(0, -1).join(' ') ||
                locality.name.slice(0, 5)
              : // A name nothing like any.
                `${misspell(locality.name, random)} Heights Estate`
        const which = random()
        const postcode =
          which < 0.4
            ? locality.postcodes[0]
            : which < 0.7
              ? postcodes[Math.floor(random() * postcodes.length)]
              : which < 0.85
                ? ''
                : '9999'
        const now = closestSuburb(table, typed, postcode)
        const before = closestSuburbBefore(table, typed, postcode)
        asked += 1
        if (now) found += 1
        if (now !== before) {
          differ.push(
            `${state} "${typed}" ${postcode}: ${now?.name} (was ${before?.name})`,
          )
        }
      }
    }
    expect(differ).toEqual([])
    expect(asked).toBe(400)
    // Enough of both kinds of answer for the comparison to mean something.
    expect(found).toBeGreaterThan(150)
    expect(asked - found).toBeGreaterThan(50)
  }, 60_000)
})

/** One to three slips of the kind people make: a letter changed, left out,
 * doubled or swapped with its neighbour, or a space lost. */
function misspell(text: string, random: () => number): string {
  let out = text
  const slips = 1 + Math.floor(random() * 3)
  for (let n = 0; n < slips; n++) {
    const at = Math.floor(random() * Math.max(out.length, 1))
    const kind = Math.floor(random() * 5)
    const letter = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 26)]
    if (kind === 0) out = out.slice(0, at) + letter + out.slice(at + 1)
    else if (kind === 1) out = out.slice(0, at) + out.slice(at + 1)
    else if (kind === 2) out = out.slice(0, at) + out[at] + out.slice(at)
    else if (kind === 3 && at + 1 < out.length) {
      out = out.slice(0, at) + out[at + 1] + out[at] + out.slice(at + 2)
    } else out = out.replace(' ', '')
  }
  return out
}

describe('checkAddressOffline', () => {
  test('a suburb with its own postcode, in the work area, is fine', async () => {
    expect(
      await offline(address('12 Walcott St', 'Mount Lawley', 'WA', '6050')),
    ).toEqual([])
    expect(
      await offline(address('12 Walcott St', 'Mt Lawley', 'WA', '6050')),
    ).toEqual([])
    expect(
      await offline(address('12 Walcott St', 'mount lawley', 'wa', '6050')),
    ).toEqual([])
  })

  test("a postcode that is not the suburb's is usually another", async () => {
    expect(
      await offline(address('12 Walcott St', 'Mount Lawley', 'WA', '6000')),
    ).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: "Mount Lawley's postcode is usually 6050.",
        fix: { label: 'Use 6050', patch: { postcode: '6050' } },
      },
    ])
  })

  test('a PO-box postcode is never questioned', async () => {
    // 6001 is Perth's GPO boxes: no street address uses it.
    expect(await offline(address('PO Box 12', 'Perth', 'WA', '6001'))).toEqual(
      [],
    )
  })

  test('a suburb that is in two postcodes takes either', async () => {
    const nsw = await loadLocalities('NSW')
    const [spread] = nsw!.all.filter((l) => l.postcodes.length > 1)
    for (const postcode of spread.postcodes) {
      expect(
        await offline(
          address('1 Main St', spread.name, 'NSW', postcode),
          'NSW',
        ),
      ).toEqual([])
    }
  })

  test('a near miss of a suburb in the state is offered', async () => {
    for (const typed of ['Fanny Bay', 'Fannybay', 'Fannie']) {
      expect(
        await offline(address('12 East Point Rd', typed, 'NT', '0820'), 'NT'),
      ).toEqual([
        {
          field: 'suburb',
          level: 'warning',
          message: `Could not find ${typed} in NT. Did you mean Fannie Bay?`,
          fix: { label: 'Use Fannie Bay', patch: { suburb: 'Fannie Bay' } },
        },
      ])
    }
  })

  test('a near miss that uses the postcode typed beats one that does not', async () => {
    // "Artadale" is a letter from Armadale (6112) and from Attadale (6156).
    expect(
      (await offline(address('1 Main St', 'Artadale', 'WA', '6156')))[0]?.fix,
    ).toEqual({ label: 'Use Attadale', patch: { suburb: 'Attadale' } })
    // With no postcode to go on, the one more people live in.
    expect(
      (await offline(address('1 Main St', 'Artadale', 'WA', '')))[0]?.fix,
    ).toEqual({ label: 'Use Armadale', patch: { suburb: 'Armadale' } })
  })

  test('a compass point cut to its letter is that point', async () => {
    // "W Perth" is a letter from Perth; offered Perth, then Perth's 6000,
    // a right West Perth address became a wrong Perth one.
    for (const [typed, postcode] of [
      ['W Perth', '6005'],
      ['E Perth', '6004'],
      ['N Perth', '6006'],
      ['S Perth', '6151'],
      ['W. Perth', '6005'],
    ]) {
      expect(await offline(address('1 Hay St', typed, 'WA', postcode))).toEqual(
        [],
      )
    }
  })

  test("a suburb not found, whose postcode is one suburb's alone, is offered that one", async () => {
    expect(
      await offline(
        address('12 Felicia Crt', 'Dianella Heights', 'WA', '6059'),
      ),
    ).toEqual([
      {
        field: 'suburb',
        level: 'warning',
        message:
          "Could not find Dianella Heights in WA. 6059 is Dianella's postcode.",
        fix: { label: 'Use Dianella', patch: { suburb: 'Dianella' } },
      },
    ])
  })

  test('an address outside the work area is pointed out, even when right', async () => {
    expect(
      await offline(address('12 East Point Rd', 'Fannie Bay', 'NT', '0820')),
    ).toEqual([
      {
        field: 'state',
        level: 'warning',
        message: 'This address is in NT — outside WA, where you work.',
      },
    ])
  })

  test("a postcode from another state: the suburb's own when the state is right", async () => {
    // Prod has "Darwin 2209". "Darwin" is what everyone calls Darwin City.
    expect(
      await offline(address('12 Smith St', 'Darwin', 'NT', '2209'), 'NT'),
    ).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: "2209 is an NSW postcode. Darwin's is usually 0800.",
        fix: { label: 'Use 0800', patch: { postcode: '0800' } },
      },
    ])
  })

  test("a postcode from another state: the postcode's state when the suburb is there", async () => {
    // The state left on the business's own: said once, with the one fix.
    expect(
      await offline(address('12 East Point Rd', 'Fannie Bay', 'WA', '0820')),
    ).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: '0820 is an NT postcode.',
        fix: { label: 'Use NT', patch: { state: 'NT' } },
      },
    ])
  })

  test("a postcode from another state: that state's suburb of the same name, over this one's", async () => {
    // Casuarina NT 0810 with the state left on WA. Casuarina WA is 6167, a
    // Perth suburb: offering its postcode would move a Darwin address there.
    expect(
      await offline(address('12 Trower Rd', 'Casuarina', 'WA', '0810')),
    ).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: '0810 is an NT postcode. Casuarina NT uses it.',
        fix: { label: 'Use NT', patch: { state: 'NT' } },
      },
    ])
    expect(
      (await offline(address('1 Main St', 'Durack', 'WA', '0830')))[0]?.fix,
    ).toEqual({ label: 'Use NT', patch: { state: 'NT' } })
    // And the other way round, for an NT business.
    expect(
      await offline(address('1 Main St', 'Casuarina', 'NT', '6167'), 'NT'),
    ).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: '6167 is a WA postcode. Casuarina WA uses it.',
        fix: { label: 'Use WA', patch: { state: 'WA' } },
      },
    ])
  })

  test("a place that really uses the neighbour's postcode is left be", async () => {
    // The APY Lands in SA use the NT's 0872.
    expect(
      await offline(address('1 Main Rd', 'Amata', 'SA', '0872'), 'SA'),
    ).toEqual([])
    expect(
      await offline(address('1 Main Rd', 'Canberra', 'ACT', '2601'), 'ACT'),
    ).toEqual([])
  })

  test('a suburb in another state is named, with that state as the fix', async () => {
    expect(
      await offline(address('12 Walcott St', 'Mount Lawley', 'NT', ''), 'NT'),
    ).toEqual([
      {
        field: 'suburb',
        level: 'warning',
        message: 'Mount Lawley is in WA, not NT.',
        fix: { label: 'Use WA', patch: { state: 'WA' } },
      },
    ])
  })

  test('a misspelt suburb with another state\'s postcode: "Fannybay WA 0810"', async () => {
    const issues = await offline(
      address('1 Ross Smith Ave', 'Fannybay', 'WA', '0810'),
    )
    expect(issues).toEqual([
      {
        field: 'postcode',
        level: 'warning',
        message: '0810 is an NT postcode.',
        fix: { label: 'Use NT', patch: { state: 'NT' } },
      },
      {
        field: 'suburb',
        level: 'warning',
        message: 'Could not find Fannybay in WA. Did you mean Fannie Bay, NT?',
        fix: {
          label: 'Use Fannie Bay NT',
          patch: { suburb: 'Fannie Bay', state: 'NT' },
        },
      },
    ])
  })

  test('a suburb nobody has heard of is said plainly', async () => {
    expect(
      await offline(address('1 Main St', 'Zyxwvton', 'WA', '6050')),
    ).toEqual([
      {
        field: 'suburb',
        level: 'warning',
        message: 'Could not find a suburb called Zyxwvton in WA.',
      },
    ])
  })

  test('says nothing about what is not typed yet', async () => {
    expect(await offline(address('', '', 'WA', ''))).toEqual([])
    expect(await offline(address('', 'Mount Lawley', 'WA', ''))).toEqual([])
    expect(await offline(address('', '', 'WA', '6050'))).toEqual([])
    // A postcode being typed is `addressErrors`' business.
    expect(await offline(address('', 'Mount Lawley', 'WA', '60'))).toEqual([])
  })

  test('without a work area, only the address itself is checked', async () => {
    expect(
      await checkAddressOffline(
        address('12 East Point Rd', 'Fannie Bay', 'NT', '0820'),
        {},
      ),
    ).toEqual([])
  })
})

describe('street names', () => {
  test.each([
    ['Walcott Street', 'walcott', 'street'],
    ['Walcott St', 'walcott', 'street'],
    ['walcott st, Mt Lawley', 'walcott', 'street'],
    ['East Pt Rd', 'east point', 'road'],
    ['St Georges Tce', 'saint georges', 'terrace'],
    ["St George's Terrace", 'saint georges', 'terrace'],
    ['3rd Ave', 'third', 'avenue'],
    ['Third Avenue', 'third', 'avenue'],
    ['The Esplanade', 'esplanade', ''],
    ['Esplanade', 'esplanade', ''],
    ['Walcott', 'walcott', ''],
    ['Great Eastern Hwy', 'great eastern', 'highway'],
    ['Felicia Crt', 'felicia', 'court'],
    ['Kent Dve', 'kent', 'drive'],
    ['Kings Park Gdns', 'kings park', 'gardens'],
    ['Roe Pkwy', 'roe', 'parkway'],
    ['Roe Pwy', 'roe', 'parkway'],
    ['Riverside Prom', 'riverside', 'promenade'],
    ['Mitchell Fwy', 'mitchell', 'freeway'],
    ['Lakes Cir', 'lakes', 'circle'],
  ])('"%s" is %s %s', (typed, name, type) => {
    expect(readStreetName(typed)).toMatchObject({ name, type })
  })
})

describe('addressSignature', () => {
  const picked = address('12 Walcott Street', 'Mount Lawley', 'WA', '6050')

  test('survives the house number being put right, and "St" for "Street"', () => {
    for (const line of [
      '14 Walcott Street',
      '3/12 Walcott Street',
      'Unit 3/12 Walcott St',
      'Unit 3 12 Walcott Street',
      'U3 12 Walcott St',
      'No. 12 Walcott St',
      '#12 Walcott St',
      'Walcott Street',
    ]) {
      expect(addressSignature({ ...picked, addressLine: line })).toBe(
        addressSignature(picked),
      )
    }
    expect(stillAsPicked(picked, { ...picked, suburb: 'Mt Lawley' })).toBe(true)
  })

  test('does not survive autofill changing the suburb, state or postcode', () => {
    expect(stillAsPicked(picked, { ...picked, suburb: 'Inglewood' })).toBe(
      false,
    )
    expect(stillAsPicked(picked, { ...picked, postcode: '6052' })).toBe(false)
    expect(stillAsPicked(picked, { ...picked, state: 'NT' })).toBe(false)
    expect(
      stillAsPicked(picked, { ...picked, addressLine: '12 Beaufort Street' }),
    ).toBe(false)
  })

  test('nothing picked is never as picked', () => {
    expect(stillAsPicked(null, picked)).toBe(false)
    expect(stillAsPicked(undefined, picked)).toBe(false)
  })
})

describe('the street check request', () => {
  test('sends the street and suburb, never the house number', () => {
    const url = new URL(
      streetCheckUrl(address('12 Walcott St', 'Mt Lawley', 'WA', '6050'))!,
    )
    expect(url.origin + url.pathname).toBe(
      'https://photon.komoot.io/structured',
    )
    expect(url.searchParams.get('street')).toBe('walcott st')
    expect(url.searchParams.get('city')).toBe('Mt Lawley')
    expect(url.searchParams.get('countrycode')).toBe('AU')
    expect(url.searchParams.get('layer')).toBe('street')
    expect(url.search).not.toMatch(/12/)
  })

  test.each([
    ['Unit 3/12 Walcott St', 'walcott st'],
    ['Lot 50 Mudstone Road', 'mudstone road'],
    ['12 Walcott St Mt Lawley', 'walcott st'],
    ['12 3rd Ave', '3rd ave'],
    ['Unit 3 12 Walcott Street', 'walcott street'],
    ['U3 12 Walcott St', 'walcott st'],
    ['Apt 4 12 Walcott St', 'walcott st'],
    ['Shop 2 12 Walcott St', 'walcott st'],
    ['No. 12 Walcott St', 'walcott st'],
    ['#12 Walcott St', 'walcott st'],
    ['12 Felicia Crt Dianella', 'felicia crt'],
  ])('"%s" sends "%s"', (line, street) => {
    const url = streetCheckUrl(address(line, 'Mount Lawley', 'WA', '6050'))!
    expect(new URL(url).searchParams.get('street')).toBe(street)
  })

  test('never sends a number it could not read as the house', () => {
    for (const line of [
      'Townhouse 3 12 Walcott St',
      '3 12 Walcott St',
      'Unit 3 3rd Ave',
    ]) {
      expect(
        streetCheckUrl(address(line, 'Mount Lawley', 'WA', '6050')),
      ).toBeNull()
    }
  })

  test('asks nothing without a street or a suburb', () => {
    expect(streetCheckUrl(address('12', 'Mount Lawley', 'WA', ''))).toBeNull()
    expect(
      streetCheckUrl(address('12 Wa', 'Mount Lawley', 'WA', '')),
    ).toBeNull()
    expect(streetCheckUrl(address('12 Walcott St', '', 'WA', ''))).toBeNull()
    expect(
      streetCheckUrl(address('3, 12', 'Mount Lawley', 'WA', '')),
    ).toBeNull()
  })
})

describe('the street check, from real replies', () => {
  const check = (fixture: { value: AddressValue; json: unknown }) =>
    readStreetCheck(fixture.json, fixture.value, 'WA')

  test('finds the street in the suburb, however it was shortened', () => {
    expect(check(STRUCTURED.walcottStreet)).toEqual({ status: 'found' })
    expect(check(STRUCTURED.walcottStMtLawley)).toEqual({ status: 'found' })
    expect(check(STRUCTURED.eastPtRd)).toEqual({ status: 'found' })
    // Filed under the estate (Calleya) as well as the suburb.
    expect(check(STRUCTURED.mudstoneTreeby)).toEqual({ status: 'found' })
  })

  test('an informal type, a unit or a "No." does not lose the street', () => {
    // "Crt" read as part of the name, and "Unit 3 12" as a street called
    // "unit 3 12 walcott", were both not found, with nothing offered.
    expect(check(STRUCTURED.feliciaCrt)).toEqual({ status: 'found' })
    const walcott = STRUCTURED.walcottStreet
    for (const line of [
      'Unit 3 12 Walcott Street',
      'U3 12 Walcott Street',
      'Apt 4 12 Walcott Street',
      'Shop 2 12 Walcott Street',
      'No. 12 Walcott Street',
      '#12 Walcott Street',
    ]) {
      expect(
        readStreetCheck(walcott.json, { ...walcott.value, addressLine: line }),
      ).toEqual({ status: 'found' })
    }
  })

  test("a last word that shortens the map's type is that type", () => {
    const { json, value } = STRUCTURED.feliciaCrt
    expect(
      readStreetCheck(json, { ...value, addressLine: '12 Felicia Cour' }),
    ).toEqual({ status: 'found' })
    // A slip in the name as well: offered, never a bare "couldn't find".
    expect(
      readStreetCheck(json, { ...value, addressLine: '12 Felisia Crt' }).issue
        ?.fix,
    ).toEqual({
      label: 'Use Felicia Court',
      patch: { addressLine: '12 Felicia Court' },
    })
  })

  test('the suburb is the district, not the city the street is in', () => {
    // Walcott Street is in North Perth and Mount Lawley, and every street
    // in metro Perth has the city Perth. Found through the city, "Street
    // found" backed a wrong suburb.
    expect(check(STRUCTURED.walcottPerth)).toEqual({
      status: 'not-found',
      issue: {
        field: 'suburb',
        level: 'warning',
        message:
          'Could not find Walcott St in Perth itself on the map, only in North Perth and Mount Lawley.',
      },
    })
    const { json, value } = STRUCTURED.smithDarwin
    expect(
      readStreetCheck(json, { ...value, addressLine: '1 Ross Smith Ave' }),
    ).toMatchObject({
      status: 'not-found',
      issue: {
        message:
          'Could not find Ross Smith Ave in Darwin itself on the map, only in Fannie Bay.',
      },
    })
    expect(
      readStreetCheck(json, {
        ...value,
        addressLine: '1 Ross Smith Ave',
        suburb: 'Fannie Bay',
        postcode: '0820',
      }),
    ).toEqual({ status: 'found' })
  })

  test('"Darwin" is the district Darwin City', () => {
    expect(check(STRUCTURED.smithDarwin)).toEqual({ status: 'found' })
  })

  test('a slip in the name: Photon brings the right street, and it is offered', () => {
    expect(check(STRUCTURED.walcotTypo)).toEqual({
      status: 'not-found',
      issue: {
        field: 'addressLine',
        level: 'warning',
        message:
          'Could not find Walcot Street in Mount Lawley on the map. Did you mean Walcott Street?',
        fix: {
          label: 'Use Walcott Street',
          patch: { addressLine: '12 Walcott Street' },
        },
      },
    })
  })

  test('the wrong kind of street is offered the right one', () => {
    expect(check(STRUCTURED.walcottRoad).issue?.fix).toEqual({
      label: 'Use Walcott Street',
      patch: { addressLine: '12 Walcott Street' },
    })
  })

  test('a street the suburb does not have, with nothing close', () => {
    expect(check(STRUCTURED.noSuchStreet)).toEqual({
      status: 'not-found',
      issue: {
        field: 'addressLine',
        level: 'warning',
        message: 'Could not find Zyxwv Street in Mount Lawley on the map.',
      },
    })
    // Other states' Beaufort streets come first; they do not count.
    expect(check(STRUCTURED.beaufortFannieBay)).toMatchObject({
      status: 'not-found',
      issue: {
        message: 'Could not find Beaufort Street in Fannie Bay on the map.',
      },
    })
  })

  test('says nothing when the map does not know the suburb in that state', () => {
    // Every Inglewood back is Queensland's.
    expect(check(STRUCTURED.walcottInglewood)).toEqual({ status: 'unchecked' })
    // Only Bathurst's racetrack streets.
    expect(check(STRUCTURED.thirdAve)).toEqual({ status: 'unchecked' })
  })

  test('says nothing for a street found only in a neighbouring suburb', () => {
    const json = STRUCTURED.walcottStreet.json
    expect(
      readStreetCheck(json, {
        ...STRUCTURED.walcottStreet.value,
        suburb: 'Inglewood',
      }),
    ).toEqual({ status: 'unchecked' })
  })

  test('a garbled reply is unchecked', () => {
    const value = STRUCTURED.walcottStreet.value
    for (const json of [
      null,
      'nope',
      {},
      { features: 'x' },
      { features: [] },
    ]) {
      expect(readStreetCheck(json, value)).toEqual({ status: 'unchecked' })
    }
  })
})

describe('checkStreetOnline', () => {
  const value = STRUCTURED.walcotTypo.value

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function answer(json: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(json)))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  test('asks Photon and reads the reply', async () => {
    const fetchMock = answer(STRUCTURED.walcotTypo.json)
    const result = await checkStreetOnline(value, { workState: 'WA' })
    expect(result.status).toBe('not-found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('photon.komoot.io/structured')
    expect(url).not.toMatch(/street=12/)
  })

  test('offline, refused or garbled is unchecked, never thrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError())),
    )
    expect(await checkStreetOnline(value, {})).toEqual({ status: 'unchecked' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    )
    expect(await checkStreetOnline(value, {})).toEqual({ status: 'unchecked' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>')),
    )
    expect(await checkStreetOnline(value, {})).toEqual({ status: 'unchecked' })

    const fetchMock = answer(STRUCTURED.walcotTypo.json)
    vi.stubGlobal('navigator', { onLine: false })
    expect(await checkStreetOnline(value, {})).toEqual({ status: 'unchecked' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('gives up after 3 seconds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )
    const pending = checkStreetOnline(value, {})
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual({ status: 'unchecked' })
  })

  test('asks nothing while a test runner drives the browser, unless let', async () => {
    const fetchMock = answer(STRUCTURED.walcotTypo.json)
    const store = new Map<string, string>()
    vi.stubGlobal('navigator', { webdriver: true, onLine: true })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
    })
    expect(await checkStreetOnline(value, {})).toEqual({ status: 'unchecked' })
    expect(fetchMock).not.toHaveBeenCalled()

    store.set(LOOKUP_UNDER_AUTOMATION_KEY, 'on')
    expect((await checkStreetOnline(value, {})).status).toBe('not-found')
  })
})

describe('checkAddressAtSave', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('checks the street when the address was typed by hand', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(STRUCTURED.walcotTypo.json)),
    )
    vi.stubGlobal('fetch', fetchMock)
    const issues = await checkAddressAtSave(STRUCTURED.walcotTypo.value, {
      workState: 'WA',
      picked: null,
    })
    expect(issues.map((i) => i.field)).toEqual(['addressLine'])
  })

  test('skips the street for a picked suggestion, but not the offline checks', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const picked = address('12 Walcott Street', 'Mount Lawley', 'WA', '6050')
    expect(
      await checkAddressAtSave(
        { ...picked, addressLine: '14 Walcott Street' },
        { workState: 'NT', picked },
      ),
    ).toEqual([
      expect.objectContaining({
        field: 'state',
        message: 'This address is in WA — outside NT, where you work.',
      }),
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('autofill after the pick: the street is checked again', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(STRUCTURED.walcottStreet.json)),
    )
    vi.stubGlobal('fetch', fetchMock)
    const picked = address('12 Walcott Street', 'Mount Lawley', 'WA', '6050')
    const issues = await checkAddressAtSave(
      { ...picked, postcode: '6000' },
      { workState: 'WA', picked },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(issues).toEqual([
      expect.objectContaining({
        field: 'postcode',
        message: "Mount Lawley's postcode is usually 6050.",
      }),
    ])
  })
})
