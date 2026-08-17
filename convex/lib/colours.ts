/** Calendar layer colours — one per member, used by the week strip dots (§2.3). */
export const MEMBER_COLOURS = [
  '#FF3B30',
  '#0A84FF',
  '#34C759',
  '#FF9F0A',
  '#AF52DE',
  '#FF2D55',
  '#5AC8FA',
  '#A2845E',
] as const

export function nextColour(taken: Array<string>): string {
  return MEMBER_COLOURS.find((c) => !taken.includes(c)) ?? MEMBER_COLOURS[0]
}
