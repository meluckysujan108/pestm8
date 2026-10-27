// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { KEPT_FNS } from './keptShape'

/**
 * ARCHITECTURE.md's account of the kept copy, held to `KEPT_FNS`: someone
 * checking what a phone keeps against the design reads that bullet first, so
 * a function kept, or named to be kept, without a word there fails here.
 */
test('ARCHITECTURE names every function KEPT_FNS names', () => {
  const doc = readFileSync(
    new URL('../../../ARCHITECTURE.md', import.meta.url),
    'utf8',
  )
  const bullet = doc
    .split('\n')
    .find((line) =>
      line.includes('(`KEPT_FNS`, `src/lib/offline/keptShape.ts`)'),
    )
  expect(bullet).toBeDefined()
  for (const fn of KEPT_FNS) {
    expect(bullet, fn).toContain(`\`${fn.replace(':', '.')}\``)
  }
})
