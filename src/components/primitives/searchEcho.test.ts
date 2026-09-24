import { describe, expect, test } from 'vitest'
import { recordSend, settleEcho, settlesAt } from './searchEcho'

/**
 * A search box sends a term, and it comes back through `value` only once its
 * navigation commits. These play the box's side of that exchange: what it has
 * sent, and whether an incoming value replaces what the person has typed.
 */

describe('an echo arriving late', () => {
  test('does not overwrite what was typed after it was sent', () => {
    // "wat", a pause long enough to send it, then "tle" typed while that
    // navigation is still in flight. The box that preceded this took the
    // late "wat" for an outside change and put it back: "wattle" became "wat".
    let unechoed = recordSend([], 'wat', '')
    unechoed = recordSend(unechoed, 'wattle', '')

    const late = settleEcho(unechoed, 'wat')
    expect(late.adopt).toBe(false)
    expect(late.unechoed).toEqual(['wattle'])

    const last = settleEcho(late.unechoed, 'wattle')
    expect(last).toEqual({ unechoed: [], adopt: false })
  })

  test('an echo of a later term settles the superseded ones before it', () => {
    // "wat" never commits: the "wattle" navigation replaced it.
    const unechoed = recordSend(recordSend([], 'wat', ''), 'wattle', '')
    expect(settleEcho(unechoed, 'wattle')).toEqual({
      unechoed: [],
      adopt: false,
    })
  })
})

describe('a change from outside', () => {
  test('is adopted, and forgets anything still in flight', () => {
    // Notes clears the search when a note is created; the back button lands
    // on an older term.
    const unechoed = recordSend([], 'pests', 'pest')
    expect(settleEcho(unechoed, '')).toEqual({ unechoed: [], adopt: true })
  })

  test('on first render, with nothing sent, is simply the value', () => {
    expect(settleEcho([], 'termite')).toEqual({ unechoed: [], adopt: true })
  })
})

describe('sending what is already committed', () => {
  test('clears the queue instead of joining it', () => {
    // "pest" committed; "pests" sent; backspaced to "pest" before it landed.
    // The "pest" navigation changes nothing, so it never echoes, and it
    // superseded "pests", which never will either.
    let unechoed = recordSend([], 'pests', 'pest')
    unechoed = recordSend(unechoed, 'pest', 'pest')
    expect(unechoed).toEqual([])

    // So a later back button to an entry with q=pests is adopted, rather than
    // taken for the echo of a term that was superseded long ago.
    expect(settleEcho(unechoed, 'pests').adopt).toBe(true)
  })

  test('the clear button, with a term in flight', () => {
    const unechoed = recordSend(recordSend([], 'ants', ''), '', '')
    expect(unechoed).toEqual([])
    expect(settlesAt(unechoed, '')).toBe('')
  })
})

describe('what the box waits for', () => {
  test('is the last term sent, or the value when nothing is out', () => {
    expect(settlesAt([], 'roaches')).toBe('roaches')
    expect(settlesAt(['r', 'roa'], '')).toBe('roa')
  })
})
