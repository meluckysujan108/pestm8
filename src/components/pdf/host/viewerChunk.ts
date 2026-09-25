/**
 * The PDF viewer's chunk, loaded on demand and never statically: pdf.js
 * reaches for `DOMMatrix` and starts a worker when its module loads, which
 * crashes a server render, and it is the heaviest thing on the page. The one
 * place the app names the import, so the lazy component and every prefetch
 * ask for the same chunk — a product's PDF, a report's, a draft's preview.
 */
export const loadViewer = () => import('#/components/pdf/DocumentViewer')

/**
 * Starts fetching the viewer while the person is still a tap away from it —
 * the product sheet open, a report's PDF tab, the sheet that offers a draft's
 * preview — so the viewer opens without a wait. Safe to call repeatedly (the
 * module is fetched once), and a failure here is not reported: the real load
 * reports it, with a Reload.
 */
export function prefetchViewer(): void {
  void loadViewer().catch(() => {})
}
