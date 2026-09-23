/**
 * Technician colours (Phase 4.2): one per member, stored on
 * `memberships.colour`, and drawn wherever the app marks whose work something
 * is — the job card's rail, the table row's border, the week strip's dots, the
 * Week View's blocks (a rail over a light tint of the colour, or a dashed
 * outline for a projected visit), the team legend, the discs in the view menu.
 *
 * A person is always a SOLID mark with no text, and a job's status always a
 * tinted pill that says its word (src/lib/statusColours.ts), so the two can
 * share a hue on one card without meaning the same thing — the owner's
 * choice, 2026-09-23, was a red for the second person on the team, beside
 * Pending's red pill. It is a deeper red than the brand's #FF3B30, which
 * stays off the palette so a rail never reads as the app's own accent or a
 * destructive action. Yellow is never offered: it is Booked, and cannot hold
 * 3:1 on a white card.
 *
 * Each colour holds at least 3:1 against both card surfaces (#FFFFFF light,
 * #1C1C1E dark) — on the Schedule the rail is now the only sign of whose job
 * it is, so it has to be visible outdoors. The order is the assignment order:
 * the owner is dealt the first, the next person the second, and so on, which
 * is how a business started by Terence with Kevin joining comes out Terence
 * blue and Kevin red without anyone's name in the code. Blue and red — the
 * two a small team uses most — are the pair that stays furthest apart under
 * the common colour-vision deficiencies.
 */
export const MEMBER_COLOURS = [
  '#0A84FF', // blue
  '#DC2626', // red
  '#0F766E', // teal
  '#DB2777', // pink
  '#16A34A', // green
  '#8B6B45', // brown
  '#9333EA', // purple
  '#0E7490', // cyan
] as const

export type MemberColour = (typeof MEMBER_COLOURS)[number]

export const COLOUR_NAME: Record<MemberColour, string> = {
  '#0A84FF': 'Blue',
  '#DC2626': 'Red',
  '#0F766E': 'Teal',
  '#DB2777': 'Pink',
  '#16A34A': 'Green',
  '#8B6B45': 'Brown',
  '#9333EA': 'Purple',
  '#0E7490': 'Cyan',
}

/** Drawn for a job whose assignee cannot be found — never a person's colour. */
export const UNASSIGNED_COLOUR = '#8E8E93'

/** `#rrggbb`, upper-cased, or null. Colours were once compared as typed, so a
 * lower-case copy of a taken colour counted as free and was dealt twice. */
export function normaliseColour(value: string): string | null {
  const trimmed = value.trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(trimmed) ? trimmed : null
}

export function isMemberColour(value: string): value is MemberColour {
  return (MEMBER_COLOURS as ReadonlyArray<string>).includes(value)
}

/**
 * The colour for the next person to join: the first one nobody holds, and
 * once all are taken, the least used — so a ninth person doubles up with
 * somebody rather than everyone past eight sharing the first colour. Colours
 * outside the palette (a business's members from before Phase 4.2) are not
 * counted against anything, since they are not on offer.
 */
export function nextColour(taken: Array<string>): MemberColour {
  const uses = new Map<string, number>()
  for (const colour of taken) {
    const normal = normaliseColour(colour)
    if (normal && isMemberColour(normal)) {
      uses.set(normal, (uses.get(normal) ?? 0) + 1)
    }
  }
  let best: MemberColour = MEMBER_COLOURS[0]
  let fewest = Infinity
  for (const colour of MEMBER_COLOURS) {
    const count = uses.get(colour) ?? 0
    if (count < fewest) {
      best = colour
      fewest = count
    }
  }
  return best
}
