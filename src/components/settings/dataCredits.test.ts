// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The credit at the foot of Settings is the only place the app names the
 * licence of the suburb tables it ships. It must say what the tables
 * themselves say (scripts/build-localities.mjs writes it into each header),
 * not a licence the data is not under.
 */
const words = (text: string) =>
  text
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const root = resolve(import.meta.dirname, '../../..')
const settings = words(
  readFileSync(resolve(root, 'src/routes/$businessSlug/settings.tsx'), 'utf8'),
)
const localities = resolve(root, 'src/lib/localities')

describe('the suburb data credit in Settings', () => {
  const headers = readdirSync(localities)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(resolve(localities, file), 'utf8'))

  it('names the licence every table says it is under', () => {
    for (const header of headers) {
      const said = /G-NAF data (© Geoscape Australia, licensed by[^.]*)\./.exec(
        words(header),
      )?.[1]
      expect(said).toBe(
        '© Geoscape Australia, licensed by the Commonwealth of Australia under the Open G-NAF End User Licence Agreement',
      )
      expect(settings).toContain(`G-NAF ${said}`)
    }
  })

  it('does not name a licence the data is not under', () => {
    expect(settings).not.toMatch(/CC BY 4\.0/)
  })

  it('keeps the map and weather credits', () => {
    expect(settings).toContain('© OpenStreetMap contributors')
    expect(settings).toContain('Weather: Open-Meteo, MET Norway')
  })
})
