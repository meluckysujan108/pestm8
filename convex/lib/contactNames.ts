/**
 * Names of a client's contacts, compared the way people type them (Prompt
 * 6.1). Pure, so the client form can say what saving a contact person will
 * do with the same rule `setContactPerson` applies.
 */

const folded = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU')

export const sameName = (a: string, b: string) => folded(a) === folded(b)

/** Edits between two strings, a swap of neighbours counting as one ("Jhon"
 * and "John" are one apart). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_row, i) =>
    Array.from({ length: b.length + 1 }, (_cell, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

/**
 * Whether `next` is the same person's name put right rather than someone
 * else's: a surname added or dropped ("Jan" to "Jan Morris"), or a slip of a
 * letter or two ("Jhon" to "John", "Jan Moris" to "Jan Morris"). A short name
 * gets one slip, not two: "Al" and "Ed" are different people.
 */
export function isNameCorrection(previous: string, next: string): boolean {
  const a = folded(previous)
  const b = folded(next)
  if (a === '' || b === '') return false
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true
  const allowed = Math.min(a.length, b.length) < 5 ? 1 : 2
  return editDistance(a, b) <= allowed
}
