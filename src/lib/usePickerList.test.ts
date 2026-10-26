import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from './offline/hooks.fixtures'
import { usePickerList } from './usePickerList'
import { withSearchKeys } from './searchMatch'
import type * as React from 'react'
import type {
  ComboboxLookup,
  ComboboxOption,
} from '#/components/primitives/Combobox'

// React's hooks run here by the harness: there is no document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('./offline/hooks.fixtures')).hookHarness.hooks,
}))

/**
 * A picker's list over its opening and closing (`usePickerList`): worked out
 * only while open, and kept as it was while the sheet slides away, so a
 * picker closed by a pick leaves with its rows, not as an empty search, and
 * one taking typed values never shows an "Add …" row it didn't have.
 */

const SITES: ReadonlyArray<ComboboxOption> = [
  withSearchKeys({
    value: 'p-jane',
    label: 'J. Nguyen — 12 Wattle Street, Bayswater',
  }),
  withSearchKeys({ value: 'p-bob', label: 'Bob Lee — 4 Hay St, Perth' }),
]
const JOB_TYPES: ReadonlyArray<ComboboxOption> = [
  { value: 'Rodents', label: 'Rodents' },
  { value: 'Bed Bugs', label: 'Bed Bugs' },
]

type Props = Parameters<typeof usePickerList>[0]

function mount(props: Props) {
  const now = { ...props }
  const hook = hookHarness.mount(() => usePickerList(now))
  return {
    current: hook.current,
    set: (patch: Partial<Props>) => {
      Object.assign(now, patch)
      hook.rerender()
    },
  }
}

afterEach(() => {
  hookHarness.mount(() => null)
})

describe('a picker’s list, open and closed', () => {
  test('closed by a pick, it keeps the rows it showed while it slides away', () => {
    const list = mount({
      open: true,
      rows: SITES,
      query: 'nguyen',
      allowCustom: false,
    })
    const shown = list.current().ordered
    expect(shown.map((o) => o.value)).toEqual(['p-jane'])

    list.set({ open: false })
    expect(list.current().ordered).toBe(shown)
    expect(list.current().query).toBe('nguyen')
  })

  test('a list taking typed values keeps no “Add …” row it never had', () => {
    const list = mount({
      open: true,
      rows: JOB_TYPES,
      query: 'rodents',
      allowCustom: true,
    })
    expect(list.current().hasExactMatch).toBe(true)
    list.set({ open: false })
    expect(list.current().hasExactMatch).toBe(true)
    expect(list.current().ordered.map((o) => o.value)).toEqual(['Rodents'])
  })

  test('a lookup’s rows and end row stay as they were too', () => {
    const end = { label: 'New site for Bob Lee', onSelect: () => {} }
    const lookup = vi.fn((): ComboboxLookup => ({ first: ['p-bob'], end }))
    const list = mount({
      open: true,
      rows: SITES,
      query: '0491 570 156',
      lookup,
      allowCustom: false,
    })
    expect(list.current().found?.end).toBe(end)
    expect(list.current().ordered.map((o) => o.value)).toEqual(['p-bob'])
    list.set({ open: false })
    expect(list.current().found?.end).toBe(end)
    expect(list.current().ordered.map((o) => o.value)).toEqual(['p-bob'])
  })

  test('closed, nothing is worked out: not before it opens, nor for a push after', () => {
    const lookup = vi.fn((): ComboboxLookup | null => null)
    const list = mount({
      open: false,
      rows: SITES,
      query: 'lee',
      lookup,
      allowCustom: false,
    })
    expect(list.current().ordered).toEqual([])
    expect(lookup).not.toHaveBeenCalled()

    list.set({ open: true })
    expect(lookup).toHaveBeenCalledTimes(1)
    const shown = list.current().ordered
    list.set({ open: false })
    // A push while closed: the kept list stands, and nothing is filtered.
    list.set({ rows: [...SITES] })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(list.current().ordered).toBe(shown)
  })

  test('opened again, it is worked out afresh', () => {
    const list = mount({
      open: true,
      rows: SITES,
      query: 'nguyen',
      allowCustom: false,
    })
    list.set({ open: false })
    list.set({ open: true, query: '' })
    expect(list.current().query).toBe('')
    expect(list.current().ordered.map((o) => o.value)).toEqual([
      'p-jane',
      'p-bob',
    ])
  })
})
