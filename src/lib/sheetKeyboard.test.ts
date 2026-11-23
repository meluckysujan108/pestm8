import { describe, expect, it } from 'vitest'
import { revealBy, sheetPlace } from './sheetKeyboard'

/**
 * Where a sheet goes with the phone's keyboard up. The numbers are the ones
 * read off an iPhone 18 Pro Max in the iOS 27.2 simulator (23 Nov 2026), and
 * the same keyboard as earlier iOS lays it out.
 */
describe('a sheet with the keyboard up', () => {
  it('sits on the keyboard where iOS 27 shrinks the window with it', () => {
    // Safari, Price tapped: the number pad is 323 tall, and iOS 27 says so
    // in offsetTop while innerHeight shrinks to what is left.
    expect(
      sheetPlace({ innerHeight: 473, height: 473, offsetTop: 323, scale: 1 }),
    ).toEqual({ lift: 0, room: 435 })
    // The Home Screen app, the same field.
    expect(
      sheetPlace({ innerHeight: 573, height: 573, offsetTop: 321, scale: 1 }),
    ).toEqual({ lift: 0, room: 527 })
  })

  it('is lifted over the keyboard where the window keeps its height', () => {
    expect(
      sheetPlace({ innerHeight: 796, height: 473, offsetTop: 0, scale: 1 }),
    ).toEqual({ lift: 323, room: 435 })
  })

  it('follows the visible part when iOS has moved it up the page', () => {
    expect(
      sheetPlace({ innerHeight: 796, height: 473, offsetTop: 100, scale: 1 }),
    ).toMatchObject({ lift: 223 })
  })

  it('is as tall as it always was with no keyboard', () => {
    // 92% of the window: the panel's own 92vh.
    expect(
      sheetPlace({ innerHeight: 796, height: 796, offsetTop: 0, scale: 1 }),
    ).toEqual({ lift: 0, room: 732 })
  })

  it('is left as laid out while the page is pinch-zoomed', () => {
    expect(
      sheetPlace({ innerHeight: 796, height: 398, offsetTop: 120, scale: 2 }),
    ).toEqual({ lift: 0, room: null })
  })
})

describe('the field being typed in, in the sheet’s body', () => {
  const body = { top: 40, bottom: 473 }

  it('is scrolled up into view when the keyboard hid it', () => {
    // Price, below the shrunk body: brought 16px clear of its foot.
    expect(revealBy(body, { top: 700, bottom: 748 })).toBe(748 - 457)
  })

  it('is scrolled down into view, its label with it', () => {
    expect(revealBy(body, { top: 30, bottom: 78 }, 8)).toBe(8 - 56)
  })

  it('stays where it is when it is in view', () => {
    expect(revealBy(body, { top: 200, bottom: 248 }, 180)).toBe(0)
  })

  it('keeps the top of a field taller than the body in sight', () => {
    // A long note: its label 16px under the top, not its foot at the bottom.
    expect(revealBy(body, { top: 400, bottom: 1000 }, 380)).toBe(380 - 56)
  })
})
