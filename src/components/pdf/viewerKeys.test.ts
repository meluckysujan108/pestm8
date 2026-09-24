import { describe, expect, it } from 'vitest'
import { keyCommand } from './viewerKeys'
import type { KeyContext, KeyPress } from './viewerKeys'

/**
 * The viewer's keys. Mostly a table, but one rule in it has already bitten:
 * the viewer opens with focus on Done, so a Space the viewer does not take is
 * a Space that presses Done and closes the PDF someone was about to read.
 */

const READING: KeyContext = {
  ready: true,
  gridOpen: false,
  inField: false,
  inSearchBar: false,
}

function press(key: string, mods: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  }
}

describe('keyCommand', () => {
  it('reads on with Space and back with Shift+Space', () => {
    expect(keyCommand(press(' '), READING)).toEqual({
      kind: 'scroll',
      key: 'pageDown',
    })
    expect(keyCommand(press(' ', { shiftKey: true }), READING)).toEqual({
      kind: 'scroll',
      key: 'pageUp',
    })
  })

  it('leaves Space to a text field and to the search bar’s buttons', () => {
    expect(keyCommand(press(' '), { ...READING, inField: true })).toBeNull()
    expect(keyCommand(press(' '), { ...READING, inSearchBar: true })).toBeNull()
  })

  it('leaves every key to the password form, the error and the grid', () => {
    // Space presses "Open", "Try again" or a thumbnail there, as it should.
    for (const key of [' ', 'ArrowDown', '+', 'End']) {
      expect(keyCommand(press(key), { ...READING, ready: false })).toBeNull()
      expect(keyCommand(press(key), { ...READING, gridOpen: true })).toBeNull()
    }
  })

  it('zooms with + and −, and back to fit width with 0', () => {
    expect(keyCommand(press('+'), READING)).toEqual({
      kind: 'zoomBy',
      factor: 1.25,
    })
    // = is + without Shift on most layouts.
    expect(keyCommand(press('='), READING)).toMatchObject({ kind: 'zoomBy' })
    expect(keyCommand(press('-'), READING)).toEqual({
      kind: 'zoomBy',
      factor: 0.8,
    })
    expect(keyCommand(press('0'), READING)).toEqual({ kind: 'zoomTo', zoom: 1 })
  })

  it('scrolls with the arrows, Page Up/Down and Home/End', () => {
    expect(keyCommand(press('ArrowUp'), READING)).toEqual({
      kind: 'scroll',
      key: 'up',
    })
    expect(keyCommand(press('PageDown'), READING)).toEqual({
      kind: 'scroll',
      key: 'pageDown',
    })
    expect(keyCommand(press('End'), READING)).toEqual({
      kind: 'scroll',
      key: 'end',
    })
  })

  it('opens search with Cmd/Ctrl+F from anywhere, the search field included', () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(
        keyCommand(press('f', mods), { ...READING, inField: true }),
      ).toEqual({ kind: 'search' })
      expect(keyCommand(press('F', mods), READING)).toEqual({ kind: 'search' })
    }
  })

  it('leaves other modified keys, and keys it has no use for, to the browser', () => {
    // Cmd+0, Cmd+Arrow and friends are the browser's and the system's.
    expect(keyCommand(press('0', { metaKey: true }), READING)).toBeNull()
    expect(keyCommand(press('ArrowDown', { altKey: true }), READING)).toBeNull()
    expect(keyCommand(press('Enter'), READING)).toBeNull()
    expect(keyCommand(press('a'), READING)).toBeNull()
    // Typing in the search field, arrows included.
    expect(
      keyCommand(press('ArrowLeft'), { ...READING, inField: true }),
    ).toBeNull()
  })
})
