/**
 * How a team member is named on a document: "K. Edgar (Licence 4132)", the
 * form the Pest M8 Service Report prints under Technician's Name. Without a
 * licence on file, just the name.
 */
export function printedMemberName(name: string, licence?: string): string {
  const trimmed = name.trim()
  if (!licence) return trimmed
  return trimmed ? `${trimmed} (Licence ${licence})` : `Licence ${licence}`
}
