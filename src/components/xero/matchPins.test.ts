import { describe, expect, test } from 'vitest'
import { pinCard, steady } from './matchPins'
import type { Pin } from './matchPins'

/** A card as the list has it: a client, and what kind of card it is. */
type Card = { clientId: string; heldBy: string | null }

const card = (clientId: string, heldBy: string | null = null): Card => ({
  clientId,
  heldBy,
})

const none: ReadonlyMap<string, Pin<Card>> = new Map()

describe('an answered card stays where it was', () => {
  test('pinned at the place it was shown, and put back there once the list drops it', () => {
    const shown = [card('a'), card('b'), card('c')]
    const pins = pinCard(none, shown[1], shown)
    expect(pins.get('b')).toEqual({ item: shown[1], index: 1 })
    // Answered: the server's list no longer has it.
    expect(steady([card('a'), card('c')], pins).map((r) => r.clientId)).toEqual(
      ['a', 'b', 'c'],
    )
  })

  test('pinned again with the same card, nothing changes', () => {
    const shown = [card('a'), card('b')]
    const pins = pinCard(none, shown[0], shown)
    expect(pinCard(pins, shown[0], shown)).toBe(pins)
  })

  test('pinned again after a failed save, it takes the card as it is now — another client has the contact since — and keeps its first place', () => {
    // Same client was refused on an open card (CONTACT_TAKEN): it was pinned
    // as that card, then the list made it a held card, answered there.
    const open = card('b', null)
    const held = card('b', 'a-holder')
    let pins = pinCard(none, open, [card('a'), open, card('c')])
    pins = pinCard(pins, held, [held, card('a'), card('c')])
    expect(pins.get('b')).toEqual({ item: held, index: 1 })
    // Once the server drops it, the held card it was answered on comes
    // back, not the open card nothing was answered on.
    const rows = steady([card('a'), card('c')], pins)
    expect(rows[1]).toBe(held)
  })
})
