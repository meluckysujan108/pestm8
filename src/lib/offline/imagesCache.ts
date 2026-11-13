/**
 * Which images the service worker (src/sw.ts) answers from its own cache.
 *
 * Imported by the worker too, which is bundled on its own: nothing here may
 * import anything, or touch the DOM.
 */

/** The worker's cache of images, answered StaleWhileRevalidate. */
export const IMAGES_CACHE = 'images'

/**
 * Whether the worker answers `request` from IMAGES_CACHE: an image asked for
 * without CORS, as an `<img>` or a stylesheet asks for one.
 *
 * A report photo's `<img>` asks Convex storage, another origin, without
 * CORS, so the copy kept here is opaque: a page may show it but never read
 * it. The photo annotator (AnnotationEditor.tsx) asks for the same URL with
 * CORS, so that its canvas can be saved. The cache matched that request to
 * the opaque copy by its URL (the photo's `Vary: Origin` did not keep them
 * apart), and a CORS request answered with an opaque response is refused
 * (`net::ERR_FAILED`), so on a phone the worker had taken over, a photo shown
 * in the gallery could not be marked up. A CORS image request is left to
 * the network and the browser's own cache, which tell the two apart.
 */
export function cachesAsImage(
  request: Pick<Request, 'destination' | 'mode'>,
): boolean {
  return request.destination === 'image' && request.mode === 'no-cors'
}
