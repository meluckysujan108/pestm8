import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkupPalette } from './MarkupPalette'
import { PageMarkup } from './PageMarkup'
import { Toolbar, hasMoreMenu } from './ViewerChrome'
import type { ComponentProps } from 'react'
import type { PendingMark } from './pendingMarks'
import type { MarkupStroke, ViewerActions } from './types'

/**
 * The markup layer and its tools, rendered. What is checked here is what no
 * geometry test can see: whose marks are drawn in which colour, that the
 * lines keep their width at every zoom, and that the pen only takes touches
 * in markup mode — outside it, a tap on the page must still reach the page.
 */

const LINE = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.3 },
]

const STROKES: Array<MarkupStroke> = [
  { id: 'mine-1', points: LINE, mine: true },
  { id: 'kim-1', points: LINE, mine: false, color: 'var(--member-3)' },
  { id: 'gone-1', points: LINE, mine: false },
]

function layer(props: Partial<ComponentProps<typeof PageMarkup>>) {
  return renderToStaticMarkup(
    <PageMarkup
      index={2}
      strokes={undefined}
      pending={undefined}
      marking={false}
      {...props}
    />,
  )
}

describe('PageMarkup', () => {
  it('draws yours in the pen red, a teammate’s in their colour, anyone else’s in grey', () => {
    const html = layer({ strokes: STROKES })
    expect(html).toMatch(/data-markup-stroke="mine"[^>]*class="stroke-red"/)
    expect(html).toMatch(
      /data-markup-stroke="theirs"[^>]*style="stroke:var\(--member-3\)"/,
    )
    expect(html).toMatch(
      /data-markup-stroke="theirs"[^>]*class="stroke-grey-line"/,
    )
  })

  it('never draws a teammate’s red member colour as a red that passes for yours', () => {
    // The second person on every team is dealt #DC2626, a shade off the pen.
    const html = layer({
      strokes: [
        { id: 'kevin-1', points: LINE, mine: false, color: '#DC2626' },
        { id: 'kim-1', points: LINE, mine: false, color: '#0F766E' },
      ],
    })
    expect(html).not.toContain('#DC2626')
    expect(html).not.toMatch(/data-markup-stroke="theirs"[^>]*stroke-red/)
    expect(html).toMatch(
      /data-markup-stroke="theirs"[^>]*class="stroke-grey-line"/,
    )
    expect(html).toMatch(
      /data-markup-stroke="theirs"[^>]*style="stroke:#0F766E"/,
    )
  })

  it('keeps every line 3px wide at any zoom, in a box that is the page', () => {
    const html = layer({ strokes: STROKES })
    expect(html).toContain('viewBox="0 0 1 1"')
    expect(html).toContain('preserveAspectRatio="none"')
    expect(html).toContain('stroke-width="3"')
    expect(html.match(/vector-effect="non-scaling-stroke"/g)).toHaveLength(3)
    expect(html).toContain('stroke-linecap="round"')
  })

  it('lets touches through to the page outside markup mode', () => {
    const html = layer({ strokes: STROKES })
    expect(html).toMatch(/data-markup-page="2" class="pointer-events-none/)
    expect(html).not.toContain('touch-action')
    expect(html).not.toContain('data-markup-live')
  })

  it('takes one finger for the pen in markup mode, with a path for the stroke being drawn', () => {
    const html = layer({ marking: true })
    expect(html).toMatch(
      /data-markup-page="2" class="[^"]*\[touch-action:none\]/,
    )
    expect(html).toContain('data-markup-live')
  })

  it('draws a stroke still saving as yours', () => {
    const pending: Array<PendingMark> = [
      { key: 'pending-1', page: 2, points: LINE, saved: null },
    ]
    const html = layer({ pending })
    expect(html).toMatch(/data-markup-pending=""[^>]*class="stroke-red"/)
  })

  it('draws nothing at all for a page with no marks, outside markup mode', () => {
    expect(layer({ strokes: [] })).toBe('')
  })
})

function palette(props: Partial<ComponentProps<typeof MarkupPalette>>) {
  return renderToStaticMarkup(
    <MarkupPalette
      note="Marks are for your team. Share sends the report without them."
      canUndo
      onUndo={() => {}}
      page={2}
      canClear
      clearArmed={false}
      onClear={() => {}}
      onDone={() => {}}
      doneRef={null}
      {...props}
    />,
  )
}

describe('MarkupPalette', () => {
  it('names the page it clears, counted from 1, and says who sees the marks', () => {
    const html = palette({})
    expect(html).toContain('Clear my marks on page 3')
    expect(html).toContain('Marks are for your team.')
    expect(html).toContain('aria-label="Done marking up"')
  })

  it('asks for the second tap in place', () => {
    const html = palette({ clearArmed: true })
    expect(html).toContain('Tap again to clear page 3')
    expect(html).toMatch(/class="[^"]*text-red[^"]*">Tap again/)
  })

  it('offers Undo and Clear only to someone with marks of their own', () => {
    const html = palette({ canUndo: false, canClear: false, clearArmed: true })
    expect(html).toMatch(/aria-label="Undo my last mark" disabled=""/)
    expect(html).toMatch(/disabled=""[^>]*>Clear my marks on page 3/)
    // A leftover first tap does not show once there is nothing to clear.
    expect(html).not.toContain('Tap again')
  })
})

const ACTIONS: ViewerActions = {
  share: async () => {},
  save: () => {},
  saveLabel: 'Download',
}

function toolbar(props: Partial<ComponentProps<typeof Toolbar>>) {
  return renderToStaticMarkup(
    <Toolbar
      actions={ACTIONS}
      canShare
      ready
      searchOpen={false}
      gridOpen={false}
      onShare={() => {}}
      onSearch={() => {}}
      onPages={() => {}}
      searchButtonRef={null}
      {...props}
    />,
  )
}

describe('Toolbar', () => {
  it('shows the pen only to someone who may draw', () => {
    expect(toolbar({})).not.toContain('aria-label="Markup"')
    const html = toolbar({
      markup: { open: false, onToggle: () => {}, buttonRef: null },
    })
    expect(html).toMatch(/aria-label="Markup" aria-pressed="false"/)
  })
})

describe('hasMoreMenu', () => {
  it('draws no More button for a document that offers nothing in it', () => {
    // A draft's preview: no Save, no Replace, no Keep.
    expect(hasMoreMenu({ share: undefined })).toBe(false)
    expect(hasMoreMenu(ACTIONS)).toBe(true)
    expect(hasMoreMenu({ replace: () => {} })).toBe(true)
  })
})
