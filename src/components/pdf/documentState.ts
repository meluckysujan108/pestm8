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
  | { phase: 'error'; reason: 'download' | 'damaged' }
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
