import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Sheet } from './Sheet'
import type { ReactNode, RefObject } from 'react'

/**
 * Where focus goes when a sheet shuts. Radix gives it back to the dialog's
 * trigger, and these sheets are opened from state with none, so a sheet
 * given `returnFocusRef` puts it there instead; one without is left to
 * Radix, as every sheet was before.
 */

type ContentProps = {
  onCloseAutoFocus?: (event: { preventDefault: () => void }) => void
  children?: ReactNode
}

const seen: { content?: ContentProps } = {}

// vaul's pieces as plain elements, with the content's props kept to look at:
// there's no document here to open a real one in.
vi.mock('vaul', () => {
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    Drawer: {
      Root: pass,
      Portal: pass,
      Overlay: () => null,
      Title: pass,
      Description: pass,
      Content: (props: ContentProps) => {
        seen.content = props
        return <div>{props.children}</div>
      },
    },
  }
})

/** Stands in for the button focus goes back to. */
const element = (focus: () => void) => ({ focus }) as unknown as HTMLElement

function render(returnFocusRef?: RefObject<HTMLElement | null>) {
  seen.content = undefined
  renderToStaticMarkup(
    <Sheet
      open
      onClose={() => {}}
      title="Edit client"
      returnFocusRef={returnFocusRef}
    >
      <p>Body</p>
    </Sheet>,
  )
  return seen.content!
}

describe('Sheet', () => {
  it('gives focus back to the element it is told, in place of Radix’s', () => {
    const focus = vi.fn()
    const preventDefault = vi.fn()
    const content = render({ current: element(focus) })
    content.onCloseAutoFocus!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('reads the element when it shuts, not when it opened', () => {
    const first = vi.fn()
    const later = vi.fn()
    const ref: RefObject<HTMLElement | null> = { current: element(first) }
    const content = render(ref)
    ref.current = element(later)
    content.onCloseAutoFocus!({ preventDefault: () => {} })
    expect(first).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledOnce()
  })

  it('with nowhere given, leaves it to Radix as before', () => {
    expect(render().onCloseAutoFocus).toBeUndefined()
  })
})
