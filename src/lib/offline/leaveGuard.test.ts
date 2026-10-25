import { afterEach, describe, expect, test } from 'vitest'
import { confirmLeave, registerLeaveGuard } from './leaveGuard'
import type { LeaveReason } from './leaveGuard'

/**
 * Signing out and switching business ask whatever would be lost first. With
 * nothing registered, which is how it ships, both just go ahead.
 */

const unregister: Array<() => void> = []
const register = (...args: Parameters<typeof registerLeaveGuard>) => {
  const off = registerLeaveGuard(...args)
  unregister.push(off)
  return off
}
afterEach(() => {
  for (const off of unregister.splice(0)) off()
})

describe('confirmLeave', () => {
  test('goes ahead when nothing is registered', async () => {
    expect(await confirmLeave('signOut')).toBe(true)
    expect(await confirmLeave('switchBusiness')).toBe(true)
  })

  test('asks each guard why, and goes ahead when all say so', async () => {
    const asked: Array<LeaveReason> = []
    register((reason) => {
      asked.push(reason)
      return true
    })
    register(async (reason) => {
      asked.push(reason)
      return true
    })
    expect(await confirmLeave('switchBusiness')).toBe(true)
    expect(asked).toEqual(['switchBusiness', 'switchBusiness'])
  })

  test('stays when one guard says stay, and asks none after it', async () => {
    const asked: Array<string> = []
    register(() => {
      asked.push('first')
      return false
    })
    register(() => {
      asked.push('second')
      return true
    })
    expect(await confirmLeave('signOut')).toBe(false)
    expect(asked).toEqual(['first'])
  })

  test('a guard that throws counts as stay', async () => {
    register(() => {
      throw new Error('broken')
    })
    expect(await confirmLeave('signOut')).toBe(false)
    unregister.splice(0).forEach((off) => off())
    register(() => Promise.reject(new Error('broken')))
    expect(await confirmLeave('signOut')).toBe(false)
  })

  test('a guard taken away is no longer asked', async () => {
    const off = register(() => false)
    expect(await confirmLeave('signOut')).toBe(false)
    off()
    expect(await confirmLeave('signOut')).toBe(true)
  })
})
