import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { ConfirmDialog } from './ConfirmDialog'
import type * as React from 'react'
import type { ReactElement } from 'react'

/**
 * ConfirmDialog's two buttons are 44px, side by side, each half a dialog of
 * at most 380px: 152.5px at 375px wide, 127px at 320px. Asked
 * (`labelInset`, the leave guard's), the words sit 12px in from each end,
 * which keeps them clear of the button's 18px rounded corners, and a way
 * out that names something, such as the switch question's "Stay in
 * {business name}" (lib/outbox/leaveAsk.ts), which has no length limit, is
 * held to the two lines that fit (43.5px of 15px type), ending in "…",
 * rather than spilling out of the button. The words are all still there,
 * for a screen reader, and the dialog's body says them in full. Not asked,
 * every other dialog's words are drawn as they were before the leave guard,
 * with the flag off too.
 *
 * ConfirmDialog runs here by the hook harness, called as React would call
 * it: there is no document to render into, so what it draws is read from
 * the element it returns.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))

type Props = Record<string, unknown>
type Element = ReactElement<Props>

/** Every element under `node` whose props pass `matches`. */
function findAll(node: unknown, matches: (props: Props) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap((each) => findAll(each, matches))
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return []
  }
  const element = node as Element
  return [
    ...(matches(element.props) ? [element] : []),
    ...findAll(element.props.children, matches),
  ]
}

afterEach(() => {
  hookHarness.mount(() => null)
})

const LONG_NAME = 'Stay in Allpest Pest Control & Termite Management'

describe('ConfirmDialog’s buttons', () => {
  test('asked (`labelInset`), hold their words to two lines, so a long name never spills out of the 44px button', () => {
    const view = hookHarness.mount(() =>
      ConfirmDialog({
        open: true,
        onOpenChange: () => {},
        title: 'Switch with 2 jobs not sent yet?',
        body: 'They stay on this phone and go when you’re back in Allpest Pest Control & Termite Management with signal.',
        confirm: 'Switch',
        cancel: LONG_NAME,
        onConfirm: () => {},
        labelInset: true,
      }),
    )
    const buttons = findAll(view.current(), (props) => props.type === 'button')
    expect(buttons).toHaveLength(2)
    const labels = buttons.map((button) => {
      // A fixed 44px, whatever the words.
      expect(String(button.props.className)).toMatch(/(^| )h-11( |$)/)
      const label = button.props.children as Element
      expect(label.type).toBe('span')
      expect(String(label.props.className)).toMatch(/(^| )line-clamp-2( |$)/)
      return label.props.children
    })
    expect(labels).toEqual([LONG_NAME, 'Switch'])
  })

  test('…and so does the red one’s word while it runs', () => {
    const view = hookHarness.mount(() =>
      ConfirmDialog({
        open: true,
        onOpenChange: () => {},
        title: 'Cancel this job?',
        body: 'It stays in the job’s history.',
        confirm: 'Cancel job',
        cancel: 'Keep job',
        onConfirm: () => {},
        pending: true,
        pendingLabel: 'Cancelling…',
        labelInset: true,
      }),
    )
    const [, red] = findAll(view.current(), (props) => props.type === 'button')
    const label = red.props.children as Element
    expect(String(label.props.className)).toMatch(/(^| )line-clamp-2( |$)/)
    expect(label.props.children).toBe('Cancelling…')
  })

  test('asked (`labelInset`), keep their words 12px in from each end, clear of the rounded corners', () => {
    // Each button is `rounded-xl`, 18px round, and has no padding of its
    // own. A two-line label fills the 44px top to bottom, so its first line
    // sits where the corners curve in: written edge to edge, Terence's "Stay
    // in Pest M8 Pest Control" wrapped to "Stay in Pest M8 Pest" 3px from
    // each end at 375px, and a long name's "…" crossed the bottom corner.
    // 12px clears both, as a row-card's `px-3` does.
    /** The horizontal padding a class list gives, in px. */
    const inset = (className: unknown) => {
      const match = /(?:^| )px-(\d+(?:\.\d+)?)(?: |$)/.exec(String(className))
      return match ? Number(match[1]) * 4 : 0
    }
    const view = hookHarness.mount(() =>
      ConfirmDialog({
        open: true,
        onOpenChange: () => {},
        title: 'Switch with 2 jobs not sent yet?',
        body: 'They stay on this phone and go when you’re back in Pest M8 Pest Control with signal.',
        confirm: 'Switch',
        cancel: 'Stay in Pest M8 Pest Control',
        onConfirm: () => {},
        labelInset: true,
      }),
    )
    const buttons = findAll(view.current(), (props) => props.type === 'button')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      const label = button.props.children as Element
      expect(
        inset(button.props.className) + inset(label.props.className),
      ).toBeGreaterThanOrEqual(12)
    }
  })

  test('not asked, keep the button’s full width for their words, as every dialog before the leave guard had', () => {
    // At 375px each button is 152.5px. Client → Stop services' way out,
    // "Keep them running", is about 135px of 15px semibold: on one line in
    // the full width, two lines in 128.5px. And "Keep this version" (about
    // 122px) at 360px, where a button is 145.6px.
    const view = hookHarness.mount(() =>
      ConfirmDialog({
        open: true,
        onOpenChange: () => {},
        title: 'Stop Jane Smith’s recurring services?',
        body: 'No more visits are booked, and the ones still to come are cancelled. They stay on the schedule marked cancelled; past and completed visits are not touched.',
        confirm: 'Stop services',
        cancel: 'Keep them running',
        onConfirm: () => {},
      }),
    )
    const buttons = findAll(view.current(), (props) => props.type === 'button')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(String(button.props.className)).not.toMatch(/(^| )p[xlrs]-/)
    }
  })

  test('not asked, draw their words bare, as before the leave guard: with the flag off, no other dialog changes, a long job type’s “Keep {name}” included', () => {
    // Job types' Delete asks "Keep {name}", up to 60 characters
    // (convex/lib/jobTypes.ts). Clamped, a name of three lines or more
    // would read "Keep Termite Inspection and…": a change the flag-off app
    // doesn't ship (plan part 2c lists what ships whatever the flag).
    const keep = 'Keep Termite Inspection and Treatment (Commercial)'
    const view = hookHarness.mount(() =>
      ConfirmDialog({
        open: true,
        onOpenChange: () => {},
        title: 'Delete Termite Inspection and Treatment (Commercial)?',
        body: 'It comes off the list for new jobs.',
        confirm: 'Delete',
        cancel: keep,
        onConfirm: () => {},
      }),
    )
    const buttons = findAll(view.current(), (props) => props.type === 'button')
    expect(buttons.map((button) => button.props.children)).toEqual([
      keep,
      'Delete',
    ])
  })
})
