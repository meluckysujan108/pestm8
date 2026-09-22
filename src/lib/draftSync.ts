/**
 * What an autosave sends when it asks the server to merge its answers into a
 * draft (`reports.saveDraft` with `base`), rather than replace them.
 *
 * The form pads every unanswered field with a placeholder so it validates
 * against its own rules: '' for text, [] for chips, every area row
 * "inspected", a checklist's locked items ticked, sometimes today's date. The
 * server never stores those — a new report is created with `data: {}` — so
 * they are not answers, and they must not reach the merge looking like them.
 * Sent against a `base` that has them, the server sees a key the technician
 * filled in as changed on its side too (`undefined` is not `''`) and refuses
 * the save as a clash with nobody; sent against a `base` without them, every
 * untouched field would count as this person's edit and clash with anyone who
 * genuinely filled it in meanwhile.
 *
 * So: send every answer the server already holds (`base`), and otherwise only
 * what differs from what the form was padded with when it opened (`seeded`).
 * An untouched placeholder is then on neither side, and the merge never looks
 * at it.
 */
export function draftToSend(
  payload: Record<string, unknown>,
  seeded: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const sent: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    const onServer = Object.prototype.hasOwnProperty.call(base, key)
    if (onServer || !sameAnswer(value, seeded[key])) sent[key] = value
  }
  return sent
}

/** The same equality `mergeDraft` uses on the server: answers are JSON-shaped. */
function sameAnswer(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
