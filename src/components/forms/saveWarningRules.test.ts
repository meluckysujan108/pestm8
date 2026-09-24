import { describe, expect, test, vi } from 'vitest'
import {
  runSaveChecks,
  saveDecision,
  warningsSignature,
} from './saveWarningRules'
import type { SaveWarning } from './saveWarningRules'

const typo: SaveWarning = {
  id: 'email:typo',
  label: 'Email',
  message: 'Did you mean bob@gmail.com?',
}
const area: SaveWarning = {
  id: 'phone:phone',
  label: 'Phone',
  message: 'Missing the area code.',
}

describe('warningsSignature', () => {
  test('is the same whatever order the checks answered in', () => {
    expect(warningsSignature([typo, area])).toBe(
      warningsSignature([area, typo]),
    )
  })

  test('changes when a field says something different', () => {
    expect(warningsSignature([typo])).not.toBe(
      warningsSignature([
        { ...typo, message: 'Did you mean bob@gmail.com.au?' },
      ]),
    )
  })
})

describe('saveDecision', () => {
  test('nothing found saves', () => {
    expect(saveDecision([], null)).toEqual({ save: true })
  })

  test('the first press with warnings stops and shows them', () => {
    expect(saveDecision([typo], null)).toEqual({
      save: false,
      signature: warningsSignature([typo]),
    })
  })

  test('the second press with exactly those warnings saves', () => {
    expect(saveDecision([area, typo], warningsSignature([typo, area]))).toEqual(
      {
        save: true,
      },
    )
  })

  test('a different set asks again', () => {
    const shown = warningsSignature([typo])
    expect(saveDecision([typo, area], shown)).toMatchObject({ save: false })
    expect(saveDecision([area], shown)).toMatchObject({ save: false })
  })
})

describe('runSaveChecks', () => {
  test('answers in the same tick when every check is synchronous', () => {
    const found = runSaveChecks([() => [typo], () => [], () => [area]])
    expect(found).toEqual([typo, area])
  })

  test('a check that throws finds nothing', () => {
    const found = runSaveChecks([
      () => {
        throw new Error('boom')
      },
      () => [area],
    ])
    expect(found).toEqual([area])
  })

  test('waits for asynchronous checks, and a rejected one finds nothing', async () => {
    const found = await runSaveChecks([
      () => [typo],
      async () => [area],
      () => Promise.reject(new Error('offline')),
    ])
    expect(found).toEqual([typo, area])
  })

  test('a check still going when time is up finds nothing, and is told to stop', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const found = runSaveChecks(
        [
          () => [typo],
          (signal) =>
            new Promise<Array<SaveWarning>>(() => {
              signal.addEventListener('abort', () => (aborted = true))
            }),
        ],
        3000,
      )
      await vi.advanceTimersByTimeAsync(3000)
      expect(await found).toEqual([typo])
      expect(aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
