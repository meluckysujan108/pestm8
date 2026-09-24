import { describe, expect, it } from 'vitest'
import { describeError } from '#/components/forms/describeError'
import { saveUserName } from './saveUserName'

describe('saving the name', () => {
  it('fails when Better Auth resolves with a refusal instead of throwing', async () => {
    // better-fetch resolves { data: null, error } for a 4xx. Taken as it
    // came, the form said "Saved" over a name that had not changed.
    const update = async () => ({
      data: null,
      error: { status: 400, message: 'Name is invalid' },
    })
    await expect(saveUserName('Kevin', 'Kev', update)).rejects.toThrow(
      'Name is invalid',
    )
  })

  it('says "signed out" for an expired session', async () => {
    const update = async () => ({ data: null, error: { status: 401 } })
    const failed = await saveUserName('Kevin', 'Kev', update).catch(
      (e: unknown) => e,
    )
    expect(describeError(failed)).toMatch(/signed out/)
  })

  it('resolves when the name saved', async () => {
    const sent: Array<unknown> = []
    const update = async (args: { name: string }) => {
      sent.push(args)
      return { data: { status: true }, error: null }
    }
    await expect(saveUserName('Kevin', 'Kev', update)).resolves.toBeUndefined()
    expect(sent).toEqual([{ name: 'Kevin' }])
  })

  it('sends nothing for a name left as it was', async () => {
    let calls = 0
    const update = async () => {
      calls++
      return { error: { status: 401 } }
    }
    await expect(saveUserName('Kev', 'Kev', update)).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })
})
