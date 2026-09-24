/**
 * Builds the offline suburb tables the address checks read
 * (src/lib/addressVerify.ts): src/lib/localities/{ACT,NSW,…,WA}.ts, one per
 * state, each every suburb and locality in that state with the postcodes its
 * street addresses use.
 *
 *   node scripts/build-localities.mjs
 *
 * The source is joelkoen/postcodes-au, which counts every address in G-NAF
 * (the national address file) by locality and postcode. So a suburb is listed
 * with exactly the postcodes real street addresses in it carry: a PO-box or
 * GPO postcode (Perth 6001, Midland 6936) is in no row, and the check treats
 * a postcode it has never seen as one of those rather than as a mistake.
 *
 * The tables are generated once and committed, not fetched by the app: the
 * checks run at a door with no signal, from the chunk the service worker
 * already holds. Run this again to refresh them; G-NAF changes by a few new
 * estates a quarter.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const REPO = 'joelkoen/postcodes-au'
const FILE = 'data/localities-au.csv'
const OUT_DIR = resolve('src/lib/localities')
const STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']
const USER_AGENT = 'PestM8-build/1.0 (scripts/build-localities.mjs)'

const ATTRIBUTION = [
  'Contains G-NAF data © Geoscape Australia, licensed by the Commonwealth of',
  'Australia under the Open G-NAF End User Licence Agreement.',
]

const STATE_NAMES = {
  ACT: 'the Australian Capital Territory',
  NSW: 'New South Wales',
  NT: 'the Northern Territory',
  QLD: 'Queensland',
  SA: 'South Australia',
  TAS: 'Tasmania',
  VIC: 'Victoria',
  WA: 'Western Australia',
}

/**
 * The state a postcode's number belongs to. The same ranges as
 * `stateOfPostcode` in convex/lib/postcodes.ts, repeated because this runs
 * under plain Node, which cannot import TypeScript; the table test in
 * src/lib/addressVerify.test.ts fails if the two ever disagree.
 */
function stateOfPostcode(postcode) {
  if (!/^\d{4}$/.test(postcode)) return undefined
  const n = Number(postcode)
  if (n >= 200 && n <= 299) return 'ACT'
  if (n >= 800 && n <= 999) return 'NT'
  if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'ACT'
  if (n >= 1000 && n <= 2999) return 'NSW'
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return 'VIC'
  if ((n >= 4000 && n <= 4999) || n >= 9000) return 'QLD'
  if (n >= 5000 && n <= 5999) return 'SA'
  if (n >= 6000 && n <= 6999) return 'WA'
  if (n >= 7000 && n <= 7999) return 'TAS'
  return undefined
}

/**
 * Every state a locality is filed under. The source gives each postcode ONE
 * state (the state of the first address it met with that postcode), so a
 * postcode that crosses a border files the neighbour's towns under the wrong
 * state: all of 2620 is "ACT", Queanbeyan included. A locality is therefore
 * also filed under the state its postcode's number belongs to (Queanbeyan
 * NSW, Hume ACT, Christmas Island WA), and the NT's 0872 communities over
 * the straight borders at 129°E and 26°S under WA and SA, where they are.
 *
 * What this cannot mend: a border town whose postcode is the neighbour's by
 * number too (Barooga NSW is 3644) stays filed under the neighbour. The check
 * only ever warns, so it costs that town one "Save anyway".
 */
function statesOf(row) {
  const states = new Set()
  if (STATES.includes(row.state)) states.add(row.state)
  const byNumber = stateOfPostcode(row.postcode)
  if (byNumber) states.add(byNumber)
  if (byNumber === 'NT') {
    if (row.longitude < 129) states.add('WA')
    else if (row.latitude < -26) states.add('SA')
  }
  return [...states]
}

/**
 * The source title-cases G-NAF's capitals word by word ("O'connor",
 * "Mckinnon", "Brighton-le-sands"); these put back the capitals the official
 * names have (O'Connor, McKinnon, Brighton-Le-Sands). K'gari and Stun'sail
 * Boom keep their small letters.
 */
function tidyName(raw) {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(
      /(^|[ -])([a-z])/g,
      (_m, before, letter) => before + letter.toUpperCase(),
    )
    .replace(
      /\b([OD])'([a-z])/g,
      (_m, prefix, letter) => `${prefix}'${letter.toUpperCase()}`,
    )
    .replace(/\bMc([a-z])/g, (_m, letter) => `Mc${letter.toUpperCase()}`)
}

/** RFC 4180, as the source's writer (Rust's csv crate) quotes. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function get(url, as) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return as === 'json' ? res.json() : res.text()
}

/** The newest commit that changed the file, so the header can say exactly
 * which data this is. Falls back to main when GitHub's API is rate-limited. */
async function sourceCommit() {
  try {
    const commits = await get(
      `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(FILE)}&per_page=1`,
      'json',
    )
    const [latest] = commits
    return {
      ref: latest.sha,
      label: `commit ${latest.sha.slice(0, 7)}, ${latest.commit.committer.date.slice(0, 10)}`,
    }
  } catch (error) {
    console.warn(
      `  Could not ask GitHub for the commit (${error.message}); using main.`,
    )
    return { ref: 'main', label: 'branch main' }
  }
}

const source = await sourceCommit()
const csv = await get(
  `https://raw.githubusercontent.com/${REPO}/${source.ref}/${FILE}`,
)
const [header, ...records] = parseCsv(csv)
const expected = 'locality,state,postcode,count,latitude,longitude'
if (header.join(',') !== expected) {
  throw new Error(`Unexpected columns in ${FILE}: ${header.join(',')}`)
}

/** state → name → postcode → addresses */
const tables = new Map(STATES.map((s) => [s, new Map()]))
for (const fields of records) {
  const [locality, state, postcode, count, latitude, longitude] = fields
  const row = {
    name: tidyName(locality),
    state,
    postcode,
    count: Number(count),
    latitude: Number(latitude),
    longitude: Number(longitude),
  }
  // Each line of a table is "<name> <postcode> <postcode>…", parsed back by
  // splitting four-digit words off the end, inside a template literal.
  if (!/^\d{4}$/.test(row.postcode) || !Number.isFinite(row.count)) {
    throw new Error(`Unexpected row: ${fields.join(',')}`)
  }
  if (!/^[A-Za-z][A-Za-z0-9 '-]*$/.test(row.name) || / \d{4}$/.test(row.name)) {
    throw new Error(`A name the tables cannot hold: ${row.name}`)
  }
  for (const s of statesOf(row)) {
    const names = tables.get(s)
    const postcodes = names.get(row.name) ?? new Map()
    postcodes.set(row.postcode, (postcodes.get(row.postcode) ?? 0) + row.count)
    names.set(row.name, postcodes)
  }
}

const built = new Date().toISOString().slice(0, 10)
await mkdir(OUT_DIR, { recursive: true })

for (const [state, names] of tables) {
  const lines = [...names]
    .map(([name, postcodes]) => {
      const byUse = [...postcodes].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )
      const total = byUse.reduce((sum, [, n]) => sum + n, 0)
      return { name, total, line: `${name} ${byUse.map(([p]) => p).join(' ')}` }
    })
    // Most addresses first: where two names are equally close to what was
    // typed, the check suggests the one far more people live in.
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .map((l) => l.line)

  const file = [
    '/**',
    ` * Every suburb and locality in ${STATE_NAMES[state]} (${state}) with the`,
    ' * postcodes its street addresses use, the most used first; localities with',
    ' * the most addresses first. One per line: "<name> <postcode>…". Read by the',
    ' * offline address checks in src/lib/addressVerify.ts.',
    ' *',
    ` * GENERATED by scripts/build-localities.mjs on ${built}. Do not edit: run`,
    ' * the script again.',
    ' *',
    ` * Source: https://github.com/${REPO} (MIT), ${FILE},`,
    ` * ${source.label}.`,
    ...ATTRIBUTION.map((line) => ` * ${line}`),
    ' */',
    `export default \`${lines.join('\n')}\``,
    '',
  ].join('\n')

  await writeFile(resolve(OUT_DIR, `${state}.ts`), file)
  console.log(
    `  ${state}: ${lines.length} localities, ${(file.length / 1024).toFixed(0)} KiB`,
  )
}
