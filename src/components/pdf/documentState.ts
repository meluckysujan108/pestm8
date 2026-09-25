import type { PDFDocumentProxy } from './pdfjs'
import type { PageSize } from './layout'
import type { LoadProgress } from './types'

/**
 * Where opening a PDF has got to: downloading, asking for a password, failed,
 * or open. Kept apart from the hook that drives it (`useDocument.ts`, which
 * loads pdf.js) so the transitions can be tested without it.
 */
export type DocumentState =
  | { phase: 'loading'; progress: LoadProgress | null }
  | {
      phase: 'password'
      /** pdf.js refused the last password tried. */
      wrong: boolean
      /** A password is with pdf.js, being tried. */
      checking: boolean
    }
  | {
      phase: 'error'
      reason: 'download' | 'damaged'
      /**
       * What the source said went wrong, in its own words ("This report has
       * just been locked…"), when it said anything a person can use. Shown
       * in place of the viewer's guess at the cause.
       */
      detail: string | null
    }
  | { phase: 'ready'; doc: PDFDocumentProxy; firstPage: PageSize }

export const LOADING: DocumentState = { phase: 'loading', progress: null }

/** pdf.js asking for the password: the first time, or again after a wrong one. */
export function askPassword(wrong: boolean): DocumentState {
  return { phase: 'password', wrong, checking: false }
}

/**
 * A password handed to pdf.js to try. The answer comes back from its worker
 * a moment later — the document, or the same question again — and until then
 * the form stays exactly where it is, only marked as checking.
 *
 * It must not become "Loading". That would unmount the form, and the password
 * field with focus in it goes with it: iOS drops the keyboard, and the field a
 * wrong password brings back is focused from a worker message rather than a
 * tap, which iOS answers with a caret and no keyboard. The technician would
 * have to tap the field again after every wrong try.
 */
export function checkPassword(state: DocumentState): DocumentState {
  return state.phase === 'password' && !state.checking
    ? { ...state, checking: true }
    : state
}

/**
 * The bytes did not arrive. The source's own words are kept when it gave
 * some, because it knows why and the viewer does not: a draft preview whose
 * answers failed to save, a report being locked on another phone, a file
 * that is no longer there. Put down to the signal instead, each of those
 * sends someone off to find a bar or two, and back to "Try again", which
 * then fails the same way every time.
 */
export function downloadFailed(error: unknown): DocumentState {
  return { phase: 'error', reason: 'download', detail: plainWords(error) }
}

/** pdf.js could not read what arrived. Its errors are for developers. */
export const DAMAGED: DocumentState = {
  phase: 'error',
  reason: 'damaged',
  detail: null,
}

/**
 * A rejection's message, when it is words for a person — which is what a
 * `DocumentSource` rejects with when something it understands goes wrong.
 *
 * Not the platform's own failures, which a source lets through untouched
 * when it has nothing better to say: a `TypeError` from `fetch` ("Load
 * failed", "Failed to fetch"), a `DOMException` from storage or an abort,
 * and a Convex call that failed on the way ("[CONVEX A(…)] Server Error").
 * Those get the viewer's own sentence.
 */
export function plainWords(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError ||
    error instanceof ReferenceError ||
    (typeof DOMException !== 'undefined' && error instanceof DOMException) ||
    error.name === 'AbortError'
  ) {
    return null
  }
  const message = error.message.trim()
  return message === '' || message.startsWith('[CONVEX') ? null : message
}
