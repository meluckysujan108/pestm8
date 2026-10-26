import { afterEach, describe, expect, test } from 'vitest'
import { FakeLockManager } from './outbox/fakeLocks.fixtures'
import { SEND_LOCK } from './outbox/outboxLocks'
import { resetSwitchGateForTests, switchStarting } from './outbox/switchGate'
import { chooseView } from './useSetView'
import type { Id } from '../../convex/_generated/dataModel'
import type { ViewChoice } from './useSetView'

/**
 * The View menu's choice. What matters: picking someone's account opens a
 * switch, as Settings' switch does, so no booking kept on the phone goes
 * while it starts, from this tab or another (lib/outbox/switchGate.ts).
 */

const B = 'b1' as Id<'businesses'>
const KEVIN = 'm-kevin' as Id<'memberships'>

afterEach(() => {
  resetSwitchGateForTests()
})

/** `views.set`, answered by hand. */
function server() {
  const asked: Array<{ view: ViewChoice; starting: boolean }> = []
  let answer: () => void = () => {}
  const set = (args: { businessId: Id<'businesses'>; view: ViewChoice }) =>
    new Promise<null>((resolve) => {
      asked.push({ view: args.view, starting: switchStarting() })
      answer = () => resolve(null)
    })
  return { set, asked, answer: () => answer() }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('choosing a view', () => {
  test('someone’s account: no booking goes while the switch starts, here or in any tab', async () => {
    const phone = new FakeLockManager()
    const s = server()
    const done = chooseView(
      s.set,
      B,
      { kind: 'account', membershipId: KEVIN },
      phone.forTab('a'),
    )
    expect(switchStarting()).toBe(true)
    await settled()
    // Asked once the send lock was had, which every send holds shared.
    expect(s.asked).toEqual([
      { view: { kind: 'account', membershipId: KEVIN }, starting: true },
    ])
    expect(phone.isHeld(SEND_LOCK, 'a')).toBe(true)
    s.answer()
    expect(await done).toBeNull()
    expect(switchStarting()).toBe(false)
    expect(phone.isHeld(SEND_LOCK)).toBe(false)
  })

  test.each([[{ kind: 'everyone' }], [{ kind: 'mine' }]] as const)(
    '%o only closes one, back to their own account: nothing waits on it',
    async (view) => {
      const phone = new FakeLockManager()
      const s = server()
      const done = chooseView(s.set, B, view, phone.forTab('a'))
      expect(switchStarting()).toBe(false)
      expect(s.asked).toEqual([{ view, starting: false }])
      expect(phone.held).toEqual([])
      s.answer()
      expect(await done).toBeNull()
    },
  )
})
