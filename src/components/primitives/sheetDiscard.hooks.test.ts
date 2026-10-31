import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { SheetShell } from './Sheet'
import type * as React from 'react'
import type * as Router from '@tanstack/react-router'
import type { ReactElement } from 'react'

/**
 * "Discard your changes?" confirmed, as the forms in a sheet hear it
 * (`useSheetLock`'s `onDiscard`): before the sheet closes, and over a Back
 * before the move goes on, not once it has landed. New Job's Book discards
 * the press under way then (lib/outbox/book.ts `discard`), whatever the
 * screen shows by the time the sheet goes. And a Back the dialog is still
 * asking about when nothing is left to lose goes on.
 *
 * SheetShell and its guard run here by the hook harness, each called as
 * React would call it: there is no document to render into.
 */

vi.mock('react', async (importOriginal) => {
  const { hookHarness: harness } = await import('#/lib/offline/hooks.fixtures')
  return {
    ...(await importOriginal<typeof React>()),
    ...harness.hooks,
    // The one context SheetShell reads: not inside another sheet.
    useContext: () => false,
    useId: () => 'sheet',
  }
})

/** What the guard's `useBlocker` answers. */
type Blocker = {
  status: 'idle' | 'blocked'
  proceed?: () => void
  reset?: () => void
}

/** Back, as the router has it: the guard's blocker, and each move's
 * landing kept. */
const route = vi.hoisted(
  (): { blocker: Blocker; landed: Array<() => void> } => ({
    blocker: { status: 'idle' },
    landed: [],
  }),
)
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useRouter: () => ({
    subscribe: (_event: string, landed: () => void) => {
      route.landed.push(landed)
      return () => {}
    },
  }),
  useBlocker: () => route.blocker,
}))

/**
 * A Back the guard blocks, answered as TanStack's resolver is: the first of
 * `proceed` (the move goes on) and `reset` (it stays stopped) settles it,
 * and what comes after changes nothing.
 */
function blockedBack(heard: Array<string>) {
  let settled = false
  const settle = (what: string) => () => {
    if (settled) return
    settled = true
    heard.push(what)
  }
  route.blocker = {
    status: 'blocked',
    proceed: settle('move goes on'),
    reset: settle('move stopped'),
  }
}

type Props = Record<string, unknown>
type Element = ReactElement<Props>

/** The first element under `node` whose props pass `matches`. */
function find(node: unknown, matches: (props: Props) => boolean): Element {
  const found = search(node, matches)
  if (!found) throw new Error('not drawn')
  return found
}

function search(
  node: unknown,
  matches: (props: Props) => boolean,
): Element | null {
  if (Array.isArray(node)) {
    for (const each of node) {
      const found = search(each, matches)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return null
  }
  const element = node as Element
  if (matches(element.props)) return element
  return search(element.props.children, matches)
}

/** A component of the tree, mounted and called as React would call it. */
function mounted(element: Element) {
  const component = element.type as (props: Props) => Element
  return hookHarness.mount(() => component(element.props))
}

/** …and what it draws. */
function draw(element: Element): Element {
  return mounted(element).current()
}

/** A sheet open with one form in it that has changed, and what it heard. */
function sheetWithChanges() {
  const heard: Array<string> = []
  const shell = hookHarness.mount(() =>
    SheetShell({
      open: true,
      onClose: () => heard.push('closed'),
      children: null,
    }),
  )
  const register = find(
    shell.current(),
    (props) => typeof props.value === 'function',
  ).props.value as (id: string, lock: unknown) => void
  register('form', { changed: true, discarded: () => heard.push('discarded') })
  return {
    heard,
    guard: () => find(shell.current(), (props) => 'onLeaving' in props),
  }
}

afterEach(() => {
  hookHarness.mount(() => null)
  route.blocker = { status: 'idle' }
  route.landed = []
})

describe('a confirmed Discard, as the forms in the sheet hear it', () => {
  test('✕ or Escape: heard before the sheet closes', () => {
    const sheet = sheetWithChanges()
    const guard = sheet.guard()
    ;(guard.props.onDiscard as () => void)()
    expect(sheet.heard).toEqual(['discarded', 'closed'])
  })

  test('Back: heard as it is confirmed, before the move goes on; the sheet closes once it has landed', () => {
    const sheet = sheetWithChanges()
    blockedBack(sheet.heard)
    // DiscardGuard, then the Back it guards, then its dialog.
    const dialog = draw(draw(sheet.guard()))
    expect(dialog.props.asking).toBe(true)
    ;(dialog.props.onDiscard as () => void)()
    expect(sheet.heard).toEqual(['discarded', 'move goes on'])
    for (const landed of route.landed) landed()
    expect(sheet.heard).toEqual(['discarded', 'move goes on', 'closed'])
  })

  test('Back still asked about when the lock lifts under the dialog (New Job’s booking kept on the phone meanwhile): the move goes on, nothing discarded', () => {
    const sheet = sheetWithChanges()
    blockedBack(sheet.heard)
    const dialog = draw(draw(sheet.guard()))
    expect(dialog.props.asking).toBe(true)
    // Nothing in the sheet changed any more: drawn again, it has no guard,
    // so the one asking goes.
    const shell = hookHarness.mount(() =>
      SheetShell({
        open: true,
        onClose: () => sheet.heard.push('closed'),
        children: null,
      }),
    )
    expect(search(shell.current(), (props) => 'onLeaving' in props)).toBeNull()
    expect(sheet.heard).toEqual(['move goes on'])
  })

  test('…and one already answered stays as it was: Keep editing, then the lock lifts, and the move stays stopped', () => {
    const sheet = sheetWithChanges()
    blockedBack(sheet.heard)
    const dialog = draw(draw(sheet.guard()))
    ;(dialog.props.onKeep as () => void)()
    hookHarness.mount(() => null)
    expect(sheet.heard).toEqual(['move stopped'])
  })

  test('…and a Back still asked about is let go only as the guard goes, never as a second Back comes over it', () => {
    const sheet = sheetWithChanges()
    const first: Array<string> = []
    blockedBack(first)
    const back = mounted(draw(sheet.guard()))
    // A second Back while the dialog asks: the router blocks it in turn.
    blockedBack(sheet.heard)
    back.rerender()
    expect(first).toEqual([])
    hookHarness.mount(() => null)
    expect(first).toEqual([])
    expect(sheet.heard).toEqual(['move goes on'])
  })
})
