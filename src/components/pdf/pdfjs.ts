import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * pdf.js, set up once for the in-app viewer.
 *
 * The LEGACY build, and on purpose. The modern build calls `URL.parse` (Safari
 * 18 and later) and `Promise.withResolvers` (Safari 17.4 and later) without
 * polyfilling either, so on an iPhone a couple of iOS versions behind — which
 * is a lot of technicians' phones — the viewer just says it could not load.
 * The legacy build polyfills both and is otherwise the same library, and it
 * is the only pdf.js in the app: every PDF shown here — a product's safety
 * data sheet, a finalised report, a draft's preview — opens through it.
 *
 * Imported only by the viewer, which is only ever reached through
 * `React.lazy`. pdf.js touches `DOMMatrix` and starts a Worker when it is
 * evaluated, so this module in a route's static import graph would crash the
 * server render rather than merely slow it.
 *
 * The worker is self-hosted, from the same pinned `pdfjs-dist`, because a
 * worker from another version throws at runtime rather than degrading. The
 * character maps, standard fonts, image decoders and colour profile are
 * copied into `public/pdfjs` at build time: a safety data sheet printed in a
 * CJK font, or one that leans on Helvetica without embedding it, renders as
 * boxes without them.
 */
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
}

export type PasswordPrompt = {
  /** True when the last password was tried and refused. */
  wrong: boolean
  submit: (password: string) => void
}

/**
 * Starts parsing `data`. pdf.js takes ownership of — and detaches — the buffer
 * it is handed, so the caller passes a copy and keeps its Blob for Share.
 *
 * `onPassword` is how an encrypted PDF asks for its password in the viewer
 * itself, never with `window.prompt`, which an installed app on iOS shows as
 * a bare system alert with the site's address in it.
 */
export function openPdf(
  data: Uint8Array,
  onPassword: (prompt: PasswordPrompt) => void,
): PDFDocumentLoadingTask {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    // The CMYK profile pdf.js converts print colours with — a label's
    // hazard pictograms are usually CMYK — which scripts/copy-pdfjs-assets.mjs
    // copies alongside the rest. Without it pdf.js falls back to a rougher
    // built-in conversion rather than failing.
    iccUrl: '/pdfjs/iccs/',
    // Nothing a PDF contains should ever become code: pdf.js can compile
    // font programs with `new Function`, and the app has no need for it.
    isEvalSupported: false,
  })
  task.onPassword = (
    updatePassword: (password: string) => void,
    reason: number,
  ) => {
    onPassword({
      wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
      submit: updatePassword,
    })
  }
  return task
}

/**
 * A render that was cancelled because it went stale (a scroll, a zoom, the
 * viewer closing) — expected, and never worth reporting.
 */
export function isRenderCancelled(error: unknown): boolean {
  return (
    error instanceof pdfjs.RenderingCancelledException ||
    (error instanceof Error && error.name === 'RenderingCancelledException')
  )
}

/** The file is not a PDF, or is too damaged to read. */
export function isInvalidPdf(error: unknown): boolean {
  return (
    error instanceof pdfjs.InvalidPDFException ||
    (error instanceof Error && error.name === 'InvalidPDFException')
  )
}
