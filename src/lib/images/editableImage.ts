/**
 * A photo loaded so that a canvas can draw it and still be saved
 * (`canvas.toBlob`): the photo annotator's (AnnotationEditor.tsx).
 *
 * Photos live on Convex storage, another origin. A canvas that draws a
 * photo loaded the ordinary way is "tainted" and refuses to be read back,
 * so the photo is asked for with CORS first, which is all it ever needs
 * when nothing is in the way.
 *
 * Something was. The gallery's `<img>` of the same photo had left an opaque
 * copy in the service worker's image cache, and the worker answered the
 * CORS request with it, which the browser refuses (`net::ERR_FAILED`).
 * The worker no longer does (lib/offline/imagesCache.ts), but a phone can
 * run an older worker until the new one takes over, and a cached copy or a
 * dropped request can fail the same way. So a failed load is tried once
 * more: fetched straight from storage, past every cache (`cache: 'reload'`),
 * and shown from a blob: URL. A `fetch` is not an image request, so no
 * worker's image rule answers it, and a blob: URL is this page's own, so it
 * never taints the canvas.
 */

export type EditableImage = {
  image: HTMLImageElement
  /** Lets go of the blob: URL the second try made, if it made one. */
  release: () => void
}

export type EditableImageDeps = {
  loadImage: (
    src: string,
    crossOrigin?: 'anonymous',
  ) => Promise<HTMLImageElement>
  fetch: (url: string, init: RequestInit) => Promise<Response>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

/** How the second try asks: CORS, no cookies, never from a cache. */
export const RELOAD_INIT: RequestInit = {
  mode: 'cors',
  credentials: 'omit',
  cache: 'reload',
}

export async function loadEditableImage(
  url: string,
  {
    signal,
    deps = browserDeps(),
  }: { signal?: AbortSignal; deps?: EditableImageDeps } = {},
): Promise<EditableImage> {
  let image: HTMLImageElement | null = null
  try {
    image = await deps.loadImage(url, 'anonymous')
  } catch {
    // Tried once more below.
  }
  signal?.throwIfAborted()
  if (image) return { image, release: () => {} }

  const res = await deps.fetch(url, { ...RELOAD_INIT, signal })
  if (!res.ok) throw new Error(`photo answered ${res.status}`)
  const objectUrl = deps.createObjectURL(await res.blob())
  try {
    const fromBlob = await deps.loadImage(objectUrl)
    signal?.throwIfAborted()
    return { image: fromBlob, release: () => deps.revokeObjectURL(objectUrl) }
  } catch (err) {
    deps.revokeObjectURL(objectUrl)
    throw err
  }
}

function browserDeps(): EditableImageDeps {
  return {
    loadImage: (src, crossOrigin) =>
      new Promise((resolve, reject) => {
        const img = new Image()
        if (crossOrigin) img.crossOrigin = crossOrigin
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('photo did not load'))
        img.src = src
      }),
    fetch: (url, init) => fetch(url, init),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (objectUrl) => URL.revokeObjectURL(objectUrl),
  }
}
