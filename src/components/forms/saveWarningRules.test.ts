import { describe, expect, test, vi } from 'vitest'
import {
  IDLE_SAVE_GUARD,
  afterEdit,
  createSaveGuard,
  pressedForm,
  runSaveChecks,
  saveDecision,
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
