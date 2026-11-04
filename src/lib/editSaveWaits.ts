import type { LineDown } from '#/lib/offline/useLineDown'

/**
 * Above an edit form's Save while the line is down (lib/offline/useLineDown.ts):
 * a job's, a client's or a property's. The save isn't refused, it waits in
 * the Convex client until the line is back, for as long as the app stays
 * open, and a "Saving…" that sits there must not be taken for a hang.
 */
export function editSaveWaits(
  thing: 'job' | 'client' | 'property',
): Record<LineDown, string> {
  return {
    'no-signal': `No signal — the ${thing}’s changes are saved when you have signal. Keep PestM8 open until then.`,
    unreachable:
      'Could not reach PestM8 — they’re saved once it can. Keep PestM8 open until then.',
  }
}
