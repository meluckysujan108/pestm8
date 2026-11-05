import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { FIX_ARM_MS } from '#/components/forms/saveWarningRules'
import { SheetCloseButton, SheetShell } from './Sheet'
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
  const registry = () =>
    find(shell.current(), (props) => typeof props.value === 'function')
  const register = registry().props.value as (id: string, lock: unknown) => void
  /** The form in it, changed or not. */
  const edited = (changed: boolean) =>
    register('form', { changed, discarded: () => heard.push('discarded') })
  edited(true)
  return {
    heard,
    edited,
    guard: () => find(shell.current(), (props) => 'onLeaving' in props),
    /** `useSheetClose`, as a button inside the sheet has it: the provider
     * inside the forms' registry. */
    closeFromInside: (after: () => void) =>
      (
        find(
          registry().props.children,
          (props) => typeof props.value === 'function',
        ).props.value as (after?: () => void) => void
      )(after),
    /** The sheet's ✕, tapped. */
    cross: () => {
      const cross = find(
        shell.current(),
        (props) => typeof props.onClick === 'function',
      )
      expect(cross.type).toBe(SheetCloseButton)
      ;(cross.props.onClick as () => void)()
    },
    /** Escape on the sheet itself, as Vaul hands it on while locked. */
    escape: () => {
      const content = find(
        shell.current(),
        (props) => typeof props.onEscapeKeyDown === 'function',
      )
      ;(
        content.props.onEscapeKeyDown as (event: {
          preventDefault: () => void
        }) => void
      )({ preventDefault: () => {} })
    },
  }
}

type Sheet = ReturnType<typeof sheetWithChanges>

/** The question's two buttons, as its ConfirmDialog draws them. */
function questionButtons(guard: Element) {
  // DiscardGuard, then the Back it guards, then its dialog, then the
  // ConfirmDialog it is, then what that draws.
  const confirm = draw(draw(draw(draw(guard))))
  const button = (words: string) =>
    find(
      confirm,
      (props) => props.type === 'button' && props.children === words,
    ).props as {
      onClick: (event: { preventDefault: () => void }) => void
      'aria-disabled'?: boolean
    }
  return { keep: button('Keep editing'), discard: button('Discard') }
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

describe('closed from inside the sheet (`useSheetClose`), with a change in it', () => {
  test('asks first; Discard closes the sheet, the forms hearing it before, and only then does what was asked', () => {
    const sheet = sheetWithChanges()
    sheet.closeFromInside(() => sheet.heard.push('opened #123'))
    expect(sheet.heard).toEqual([])
    expect(sheet.guard().props.asking).toBe(true)
    ;(sheet.guard().props.onDiscard as () => void)()
    expect(sheet.heard).toEqual(['discarded', 'closed', 'opened #123'])
  })

  test('Keep editing forgets what was asked: a later ✕ and Discard close the sheet and do nothing more', () => {
    const sheet = sheetWithChanges()
    sheet.closeFromInside(() => sheet.heard.push('opened #123'))
    ;(sheet.guard().props.onKeep as () => void)()
    expect(sheet.guard().props.asking).toBe(false)
    expect(sheet.heard).toEqual([])
    sheet.cross()
    expect(sheet.guard().props.asking).toBe(true)
    ;(sheet.guard().props.onDiscard as () => void)()
    expect(sheet.heard).toEqual(['discarded', 'closed'])
  })

  test('a Back over the question goes on with the person’s own move, never what was asked', () => {
    const sheet = sheetWithChanges()
    sheet.closeFromInside(() => sheet.heard.push('opened #123'))
    ;(sheet.guard().props.onLeft as () => void)()
    expect(sheet.heard).toEqual(['closed'])
    // And a ✕ after it does nothing of what was asked either.
    const again = sheetWithChanges()
    again.closeFromInside(() => again.heard.push('opened #123'))
    ;(again.guard().props.onLeft as () => void)()
    again.cross()
    ;(again.guard().props.onDiscard as () => void)()
    expect(again.heard).toEqual(['closed', 'discarded', 'closed'])
  })

  test('the question comes up under the tap that asked: for FIX_ARM_MS neither button takes a tap, so a double tap never lands on Discard', () => {
    vi.useFakeTimers()
    try {
      const sheet = sheetWithChanges()
      sheet.closeFromInside(() => sheet.heard.push('opened #123'))
      expect(sheet.guard().props.held).toBe(true)
      // Meanwhile, Discard and Keep editing are aria-disabled and do
      // nothing, Radix's own close stopped too.
      const preventDefault = vi.fn()
      const held = questionButtons(sheet.guard())
      expect(held.discard['aria-disabled']).toBe(true)
      expect(held.keep['aria-disabled']).toBe(true)
      held.discard.onClick({ preventDefault })
      held.keep.onClick({ preventDefault })
      expect(preventDefault).toHaveBeenCalledTimes(2)
      expect(sheet.heard).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('…and once FIX_ARM_MS have gone, they do; ✕ asks with nothing held', () => {
    vi.useFakeTimers()
    try {
      const sheet = sheetWithChanges()
      sheet.closeFromInside(() => sheet.heard.push('opened #123'))
      vi.advanceTimersByTime(FIX_ARM_MS - 1)
      expect(sheet.guard().props.held).toBe(true)
      vi.advanceTimersByTime(1)
      expect(sheet.guard().props.held).toBe(false)
      const preventDefault = vi.fn()
      const free = questionButtons(sheet.guard())
      expect(free.discard['aria-disabled']).toBeUndefined()
      free.discard.onClick({ preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      expect(sheet.heard).toEqual(['discarded', 'closed', 'opened #123'])

      const crossed = sheetWithChanges()
      crossed.cross()
      expect(crossed.guard().props.asking).toBe(true)
      expect(crossed.guard().props.held).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  /** How the held question went, a moment after it came up. */
  const endings: Array<[string, (sheet: Sheet) => void]> = [
    // Escape on the question, which is not held: Radix closes it.
    [
      'Keep editing (Escape on it)',
      (sheet) => (sheet.guard().props.onKeep as () => void)(),
    ],
    [
      'a Back over it that went on',
      (sheet) => (sheet.guard().props.onLeft as () => void)(),
    ],
    [
      'the change gone (the booking kept on the phone) and back',
      (sheet) => {
        sheet.edited(false)
        sheet.edited(true)
      },
    ],
  ]
  /** The person asking again, from where none of its buttons are. */
  const askers: Array<[string, (sheet: Sheet) => void]> = [
    ['✕', (sheet) => sheet.cross()],
    ['the sheet’s Escape', (sheet) => sheet.escape()],
    ['a Back', (sheet) => blockedBack(sheet.heard)],
  ]

  describe.each(endings)('the held question ended by %s', (_, ended) => {
    test.each(askers)(
      '…then %s asked within FIX_ARM_MS of the tap: nothing held',
      (_asker, ask) => {
        vi.useFakeTimers()
        try {
          const sheet = sheetWithChanges()
          sheet.closeFromInside(() => sheet.heard.push('opened #123'))
          expect(sheet.guard().props.held).toBe(true)
          vi.advanceTimersByTime(100)
          ended(sheet)
          vi.advanceTimersByTime(200)
          ask(sheet)
          // Each drawn on its own from here: the sheet as it is now.
          const guard = sheet.guard()
          // DiscardGuard, then the Back it guards, then its dialog.
          const dialog = draw(draw(guard))
          expect(dialog.props.asking).toBe(true)
          expect(dialog.props.held).toBe(false)
          const preventDefault = vi.fn()
          const free = questionButtons(guard)
          expect(free.keep['aria-disabled']).toBeUndefined()
          expect(free.discard['aria-disabled']).toBeUndefined()
          free.discard.onClick({ preventDefault })
          expect(preventDefault).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      },
    )
  })

  test('…and Open #123 asked again after Keep editing is held its own FIX_ARM_MS, not what was left of the first', () => {
    vi.useFakeTimers()
    try {
      const sheet = sheetWithChanges()
      sheet.closeFromInside(() => sheet.heard.push('opened #123'))
      vi.advanceTimersByTime(100)
      ;(sheet.guard().props.onKeep as () => void)()
      vi.advanceTimersByTime(200)
      sheet.closeFromInside(() => sheet.heard.push('opened #123'))
      expect(sheet.guard().props.held).toBe(true)
      vi.advanceTimersByTime(FIX_ARM_MS - 1)
      expect(sheet.guard().props.held).toBe(true)
      vi.advanceTimersByTime(1)
      expect(sheet.guard().props.held).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
