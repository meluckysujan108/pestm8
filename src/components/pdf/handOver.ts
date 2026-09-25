import type { HandOverResult } from './types'

/**
 * Runs the viewer's Share or Save, and says so if it fails, or runs `done`
 * once it has worked. A share sheet closed without choosing anything is
 * neither: nothing went, so nothing is said — whether the sheet came back
 * with `'cancelled'` or with the browser's own AbortError.
 *
 * Kept out of `DocumentViewer` (which loads pdf.js) so it can be tested.
 */
export function handOver(
  action: () => Promise<HandOverResult> | HandOverResult,
  failure: string,
  showToast: (message: string) => void,
  done?: () => void,
) {
  const report = (error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') return
    showToast(failure)
  }
  const finished = (result: HandOverResult) => {
    if (result !== 'cancelled') done?.()
  }
  try {
    Promise.resolve(action()).then(finished, report)
  } catch (error) {
    report(error)
  }
}
