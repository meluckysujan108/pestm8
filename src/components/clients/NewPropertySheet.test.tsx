import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { KeptDraftNote, answerOnceRead } from './NewPropertySheet'
import type { SaveWarning } from '#/components/forms/SaveWarnings'

// The sheet's imports reach the root state, read at import time.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

/**
 * Clients → New client opened again on what an Open {client} kept, as some
 * of it went nowhere (`openFromNewClient`'s `keepDraft`): the next caller is
 * someone else, and is never saved with the last one's email unseen.
 */
describe('New client, kept from before an Open', () => {
  test('says so above the fields, with Clear', () => {
    const html = renderToStaticMarkup(
      <KeptDraftNote from="Jane Nguyen" onClear={() => {}} />,
    )
    expect(html).toContain('role="status"')
    expect(html).toContain(
      'Still filled in from before you opened Jane Nguyen.',
    )
    expect(html).toMatch(/<button type="button"[^>]*>Clear<\/button>/)
  })
})

/**
 * A Save pressed before the client list is read waits for it, up to the
 * 3 s any check at Save is given. Given up on by then, it finds nothing as
 * the list comes: those rows were never on screen, and noting them shown
 * would cost the note of the press that does show them.
 */
describe('New client, a Save waiting for the client list', () => {
  const JANE: SaveWarning = {
    id: 'match:c_jane',
    kind: 'match',
    label: 'Already a client',
    message: 'Jane Nguyen, of Bayswater, has the same name and mobile.',
  }

  test('is answered with the rows for what is typed as the list comes', async () => {
    const waiting: Array<() => void> = []
    const answer = vi.fn(() => [JANE])
    const found = answerOnceRead(waiting, new AbortController().signal, answer)
    expect(answer).not.toHaveBeenCalled()
    for (const go of waiting) go()
    await expect(found).resolves.toEqual([JANE])
    expect(answer).toHaveBeenCalledTimes(1)
  })

  test('given up on before the list comes, finds nothing and works out nothing', async () => {
    const waiting: Array<() => void> = []
    const answer = vi.fn(() => [JANE])
    const press = new AbortController()
    const found = answerOnceRead(waiting, press.signal, answer)
    // The 3 s are up: the press went ahead without it.
    press.abort()
    for (const go of waiting) go()
    await expect(found).resolves.toEqual([])
    expect(answer).not.toHaveBeenCalled()
  })
})
