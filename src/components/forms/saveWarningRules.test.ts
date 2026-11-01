import { describe, expect, test, vi } from 'vitest'
import {
  FIX_ARM_MS,
  IDLE_SAVE_GUARD,
  SUBMIT_ARM_MS,
  afterEdit,
  createSaveGuard,
  panelFooter,
  panelOrder,
  pressedForm,
  runSaveChecks,
  saveDecision,
  startsHold,
  stillArmed,
  warningsSignature,
} from './saveWarningRules'
import type {
  SaveGuardState,
  SaveWarning,
  SourcedWarning,
} from './saveWarningRules'

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

// A WA business's NT address: two things wrong with one field, and a fix for
// only one of them.
const outsideWa: SourcedWarning = {
  id: 'state:1',
  label: 'State',
  message: 'This address is in NT — outside WA.',
  source: 'address',
}
const postcode: SourcedWarning = {
  id: 'postcode:1',
  label: 'Postcode',
  message: "Fannie Bay's postcode is usually 0820.",
  source: 'address',
}
const email: SourcedWarning = { ...typo, source: 'email' }

describe('afterEdit', () => {
  test("typing in a field takes all of that field's warnings, only", () => {
    expect(afterEdit([outsideWa, postcode, email], 'address', null)).toEqual([
      email,
    ])
  })

  test("a tapped fix's own edit takes only the warning it fixed", () => {
    expect(
      afterEdit([outsideWa, postcode, email], 'address', {
        source: 'address',
        id: postcode.id,
      }),
    ).toEqual([outsideWa, email])
  })

  test("a fix's edit to another field takes all of that one's", () => {
    expect(
      afterEdit([outsideWa, email], 'email', {
        source: 'address',
        id: postcode.id,
      }),
    ).toEqual([outsideWa])
  })

  test('the same list when nothing leaves it', () => {
    const list = [outsideWa]
    expect(afterEdit(list, 'email', null)).toBe(list)
  })
})

describe('pressedForm', () => {
  test("is the submit event's form", () => {
    const form = fakeForm()
    expect(pressedForm({ currentTarget: form })).toBe(form)
  })

  test('is nothing without an event, or when React has let it go', () => {
    expect(pressedForm(null)).toBeNull()
    expect(pressedForm({ currentTarget: null })).toBeNull()
  })
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Enough of a <form>: whether the browser would pass it, and a way to type
 * into it. */
function fakeForm() {
  const listeners = new Set<string>()
  const handlers = new Map<string, () => void>()
  const form = {
    valid: true,
    reportValidity: vi.fn(() => form.valid),
    addEventListener: (type: string, listener: () => void) => {
      listeners.add(type)
      handlers.set(type, listener)
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (handlers.get(type) === listener) listeners.delete(type)
    },
    fire: (type: string) => {
      if (listeners.has(type)) handlers.get(type)?.()
    },
    listening: () => listeners.size,
  }
  return form
}

function setup() {
  let state: SaveGuardState = IDLE_SAVE_GUARD
  const guard = createSaveGuard((next) => (state = next))
  const form = fakeForm()
  const save = vi.fn()
  const press = () =>
    guard.guard({ preventDefault: () => {}, currentTarget: form }, save)
  // Lets the checks' answer, and what the guard does with it, land.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { guard, form, save, press, settle, state: () => state }
}

describe('createSaveGuard', () => {
  test('checks that answer at once save in the same tick, the browser having just passed the form', () => {
    const { guard, form, save, press } = setup()
    guard.register('email', () => [])
    press()
    expect(save).toHaveBeenCalledTimes(1)
    expect(form.reportValidity).not.toHaveBeenCalled()
  })

  test('a press whose checks answer after a reset neither saves nor shows', async () => {
    const { guard, save, press, settle, state } = setup()
    const answers = [deferred<Array<SaveWarning>>()]
    guard.register('email', () => answers[answers.length - 1].promise)

    press()
    expect(state().checking).toBe(true)
    // "Existing client" tapped, or the sheet closed, while it checks.
    guard.reset()
    expect(state().checking).toBe(false)
    answers[0].resolve([typo])
    await settle()
    expect(save).not.toHaveBeenCalled()
    expect(state()).toMatchObject({ shown: [], open: false })

    // And the next press is not held up by the one dropped.
    answers.push(deferred())
    press()
    answers[1].resolve([])
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('an edit while checking saves nothing: it looks again and shows what it finds', async () => {
    const { guard, form, save, press, settle, state } = setup()
    const answers = [deferred<Array<SaveWarning>>()]
    guard.register('email', () => answers[answers.length - 1].promise)

    press()
    answers.push(deferred())
    guard.edited('email')
    answers[0].resolve([typo])
    await settle()
    // The second look, on what is there now, finds nothing: still no save.
    answers[1].resolve([])
    await settle()
    expect(save).not.toHaveBeenCalled()
    expect(state()).toMatchObject({ shown: [], checking: false })
    expect(form.listening()).toBe(0)

    // It found something: shown, and the next press with it the same saves.
    answers.push(deferred())
    press()
    answers.push(deferred())
    guard.edited('email')
    answers[2].resolve([])
    await settle()
    answers[3].resolve([area])
    await settle()
    expect(save).not.toHaveBeenCalled()
    expect(state()).toMatchObject({ open: true, shown: [{ id: area.id }] })
    answers.push(deferred())
    press()
    answers[4].resolve([area])
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('typing in a field with no check of its own counts as an edit', async () => {
    const { guard, form, save, press, settle } = setup()
    const answer = deferred<Array<SaveWarning>>()
    guard.register('email', () => answer.promise)
    press()
    // The client name cleared while the email's domain is looked up.
    form.fire('input')
    answer.resolve([])
    await settle()
    expect(save).not.toHaveBeenCalled()
  })

  test("a text box's change on blur, after the press, is not an edit", async () => {
    const { guard, form, save, press, settle } = setup()
    const answer = deferred<Array<SaveWarning>>()
    guard.register('email', () => answer.promise)
    press()
    form.fire('change')
    answer.resolve([])
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('an edit during the second look looks a third time, not showing the second', async () => {
    const { guard, save, press, settle, state } = setup()
    const answers = [deferred<Array<SaveWarning>>()]
    guard.register('email', () => answers[answers.length - 1].promise)
    press()
    answers.push(deferred())
    guard.edited('email')
    answers[0].resolve([])
    await settle()
    answers.push(deferred())
    guard.edited('email')
    answers[1].resolve([typo])
    await settle()
    answers[2].resolve([])
    await settle()
    expect(state()).toMatchObject({ shown: [], checking: false })
    expect(save).not.toHaveBeenCalled()
  })

  test('a press that waited on its checks saves only if the browser still passes the form', async () => {
    const { guard, form, save, press, settle } = setup()
    const answer = deferred<Array<SaveWarning>>()
    guard.register('email', () => answer.promise)
    press()
    // Changed where no typing reaches, e.g. a postcode left as '605'.
    form.valid = false
    answer.resolve([])
    await settle()
    expect(form.reportValidity).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()

    form.valid = true
    press()
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
  })

  test("a field that leaves the form takes its warnings, and the next press doesn't ask about them", () => {
    const { guard, save, press, state } = setup()
    const unregister = guard.register('phone', () => [area])
    guard.register('email', () => [typo])
    press()
    expect(state().shown).toHaveLength(2)

    // Business client turned Person: the site contact number unmounts.
    unregister()
    guard.removed('phone')
    expect(state().shown.map((w) => w.id)).toEqual([typo.id])
    press()
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('a tapped fix takes its own row, and the rest stay confirmed', () => {
    const { guard, save, press, state } = setup()
    let fixed = false
    guard.register('address', () =>
      fixed ? [outsideWa] : [outsideWa, { ...postcode, fix: undefined }],
    )
    press()
    const row = state().shown.find((w) => w.id === postcode.id)
    if (!row) throw new Error('postcode row missing')

    guard.fix(
      { ...row, fix: { label: 'Use 0820', apply: () => (fixed = true) } },
      (change) => {
        change()
        // The field's own notice, from the render the fix causes.
        guard.edited('address')
      },
    )
    expect(state().shown.map((w) => w.id)).toEqual([outsideWa.id])
    press()
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('a save that fails keeps the warnings confirmed', async () => {
    const { guard, press, settle, state } = setup()
    guard.register('email', () => [typo])
    const failing = vi.fn(() => Promise.reject(new Error('offline')))
    press()
    guard.guard({ preventDefault: () => {} }, failing)
    await settle()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ open: false, shown: [{ id: typo.id }] })
    guard.guard({ preventDefault: () => {} }, failing)
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

describe('match rows (`kind: match`)', () => {
  const jane: SaveWarning = {
    id: 'match:c_jane',
    kind: 'match',
    label: 'Already a client',
    message: 'Jane Nguyen, of Bayswater, has the same name and mobile.',
  }
  const shared: SaveWarning = {
    id: 'match:shared:phone:0892721234',
    kind: 'match',
    label: 'Shared number',
    message: '08 9272 1234 is on 2 clients — Ray White Bayswater and 1 other.',
  }

  test('come after the fields’ own warnings, whatever order the checks answered in', () => {
    expect(panelOrder([jane, typo, shared, area])).toEqual([
      typo,
      area,
      jane,
      shared,
    ])
    // Nothing to move: the same array back, so nothing is drawn again.
    const fields = [typo, area]
    expect(panelOrder(fields)).toBe(fields)
    const matches = [jane, shared]
    expect(panelOrder(matches)).toBe(matches)
  })

  test('alone, the form’s own foot; mixed with the fields’, today’s', () => {
    // Given the rows themselves, so the form's foot can name their fix.
    const foot = (rows: ReadonlyArray<{ kind?: string }>) =>
      rows.length === 1
        ? 'Use it, or press Book anyway to add a new client.'
        : 'Use one…'
    expect(panelFooter([jane], 'Book anyway', foot)).toBe(
      'Use it, or press Book anyway to add a new client.',
    )
    expect(panelFooter([jane, shared], 'Book anyway', foot)).toBe('Use one…')
    expect(panelFooter([typo, jane], 'Book anyway', foot)).toBe(
      'Fix them, or press Book anyway to keep them as they are.',
    )
    expect(panelFooter([typo], 'Save anyway')).toBe(
      'Fix it, or press Save anyway to keep it as it is.',
    )
    // A form with no foot of its own says today's line for match rows too.
    expect(panelFooter([jane], 'Save anyway')).toBe(
      'Fix it, or press Save anyway to keep it as it is.',
    )
  })

  test('a second fix is applied as the first is, taking every row its check gave', () => {
    let state: SaveGuardState = IDLE_SAVE_GUARD
    const guard = createSaveGuard((next) => (state = next))
    const first = vi.fn()
    const second = vi.fn()
    guard.register('match', () => [
      {
        ...jane,
        fix: { label: 'Book at 12 Wattle St', apply: first },
        fix2: { label: 'Add 12 Watle St', apply: second },
      },
      shared,
    ])
    guard.guard({ preventDefault: () => {} }, vi.fn())
    const row = state.shown.find((w) => w.id === jane.id)
    if (!row) throw new Error('Jane’s row missing')
    guard.fix(row, (change) => change(), 'fix2')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    // The shared number was about the caller as typed too, and the booking
    // is now on Jane: it goes with her row.
    expect(state.shown).toEqual([])
  })

  test('a fix that draws the same address block again, in another client mode, keeps what was confirmed there', () => {
    let state: SaveGuardState = IDLE_SAVE_GUARD
    const guard = createSaveGuard((next) => (state = next))
    const save = vi.fn()
    const press = () => guard.guard({ preventDefault: () => {} }, save)
    const usualSuburb: SaveWarning = {
      id: 'addr-postcode:1',
      label: 'Postcode',
      message: '6053 is usually Bayswater’s.',
    }
    const phoneTypo: SaveWarning = {
      id: 'phone:digits',
      label: 'Phone',
      message: 'That has 9 digits.',
    }
    const useJane = vi.fn()
    const addressCheck = () => [usualSuburb]
    let unregisterAddress = guard.register('addr-address', addressCheck)
    const unregisterPhone = guard.register('phone', () => [phoneTypo])
    let unregisterMatch = guard.register('match', () => [
      { ...jane, fix: { label: 'Use Jane Nguyen', apply: useJane } },
    ])
    press()
    expect(state.shown.map((w) => w.id).sort()).toEqual(
      [jane.id, phoneTypo.id, usualSuburb.id].sort(),
    )
    const row = state.shown.find((w) => w.id === jane.id)!
    // Use Jane Nguyen: New client's fields leave, New site for's address
    // block comes in under the same name, as React would draw it.
    guard.fix(row, (change) => {
      change()
      unregisterAddress()
      guard.removed('addr-address')
      unregisterPhone()
      guard.removed('phone')
      unregisterMatch()
      unregisterAddress = guard.register('addr-address', addressCheck)
      unregisterMatch = guard.register('match', () => [])
    })
    expect(useJane).toHaveBeenCalledTimes(1)
    // The phone's field is gone, and its warning with it; the address is the
    // same address, and its warning stays as it was shown.
    expect(state.shown.map((w) => w.id)).toEqual([usualSuburb.id])
    // So Book anyway books: nothing is asked again.
    press()
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('arming (`stillArmed`)', () => {
  test('a fix for 400 ms, Book for 500 ms, from the moment the list appeared or changed', () => {
    expect(FIX_ARM_MS).toBe(400)
    expect(SUBMIT_ARM_MS).toBe(500)
    expect(stillArmed(null, 1_000, SUBMIT_ARM_MS)).toBe(false)
    expect(stillArmed(1_000, 1_000, SUBMIT_ARM_MS)).toBe(true)
    expect(stillArmed(1_000, 1_499, SUBMIT_ARM_MS)).toBe(true)
    expect(stillArmed(1_000, 1_500, SUBMIT_ARM_MS)).toBe(false)
    expect(stillArmed(1_000, 1_399, FIX_ARM_MS)).toBe(true)
    expect(stillArmed(1_000, 1_400, FIX_ARM_MS)).toBe(false)
    // A clock set back is not "still armed" for ever.
    expect(stillArmed(1_000, 900, SUBMIT_ARM_MS)).toBe(false)
  })
})

describe('what starts the hold (`startsHold`)', () => {
  const a = { id: 'a', message: 'A' }
  const b = { id: 'b', message: 'B' }
  test('rows that came in or changed under a press, or anything a fix did', () => {
    expect(startsHold([], [a], false)).toBe(true)
    expect(startsHold([a], [a, b], false)).toBe(true)
    expect(
      startsHold([a], [{ id: 'a', message: 'A, said otherwise' }], false),
    ).toBe(true)
    expect(startsHold([a, b], [b], true)).toBe(true)
    expect(startsHold([a], [], true)).toBe(true)
  })
  test('not a list that only shrank, as a field was edited or the form reset', () => {
    expect(startsHold([a, b], [b], false)).toBe(false)
    expect(startsHold([a], [], false)).toBe(false)
    expect(startsHold([], [], false)).toBe(false)
  })
})
