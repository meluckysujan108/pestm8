import { describe, expect, test } from 'vitest'
import { cachesAsImage } from './imagesCache'

// A Request's `destination` can't be set from a constructor, so these are
// the two fields the worker's rule reads, as the browser fills them in.
describe('cachesAsImage', () => {
  test('an <img> or a stylesheet’s image (no CORS) is answered from the cache', () => {
    expect(cachesAsImage({ destination: 'image', mode: 'no-cors' })).toBe(true)
  })

  test('a CORS image request — the photo annotator’s — is left to the network', () => {
    // Answered with the opaque copy an <img> of the same photo kept, it was
    // refused, and the photo could not be marked up.
    expect(cachesAsImage({ destination: 'image', mode: 'cors' })).toBe(false)
  })

  test('a fetch, a script or a page is not an image', () => {
    expect(cachesAsImage({ destination: '', mode: 'cors' })).toBe(false)
    expect(cachesAsImage({ destination: '', mode: 'no-cors' })).toBe(false)
    expect(cachesAsImage({ destination: 'script', mode: 'no-cors' })).toBe(
      false,
    )
    expect(cachesAsImage({ destination: 'document', mode: 'navigate' })).toBe(
      false,
    )
  })
})
