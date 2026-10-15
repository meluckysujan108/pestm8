import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoadMore } from './LoadMore'
import type { ComponentProps } from 'react'

/**
 * The end of a list as the server renders it — which is also the first
 * render in the browser, so whatever is here is what hydration must match.
 * Loading by itself happens in effects, after hydration, and is not here.
 */

function render(props: Partial<ComponentProps<typeof LoadMore>> = {}) {
  return renderToStaticMarkup(
    <LoadMore
      canLoadMore
      loading={false}
      onLoadMore={() => {}}
      noun="jobs"
      shown={24}
      {...props}
    />,
  )
}

describe('LoadMore, server-rendered', () => {
  it('draws the sentinel and the button, waiting for hydration', () => {
    const html = render()
    expect(html).toContain('<div aria-hidden="true" class="h-px"></div>')
    expect(html).toMatch(
      /<button type="button" disabled=""[^>]*>Show more jobs<\/button>/,
    )
  })

  it('is a full-width 44px grey button', () => {
    const html = render()
    expect(html).toMatch(/class="[^"]*\bh-11\b[^"]*\bw-full\b/)
    expect(html).toContain('bg-fill-secondary')
  })

  it('says nothing to a screen reader until a load lands', () => {
    const html = render()
    expect(html).not.toContain('role="status"')
    expect(html).toContain(
      '<div tabindex="-1" aria-live="polite" class="sr-only"></div>',
    )
  })

  it('says it is loading, and stays focusable, while a page is coming', () => {
    const html = render({ canLoadMore: false, loading: true })
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('Loading…')
    expect(html).not.toContain('Show more')
    expect(html).toContain(
      '<div role="status" class="sr-only">Loading more jobs</div>',
    )
  })

  it('keeps quiet inside a sheet, whose status region means something else', () => {
    const html = render({ loading: true, announce: false })
    expect(html).not.toContain('role="status"')
    expect(html).toContain('Loading…')
  })

  it('never makes its count a status region', () => {
    for (const html of [render(), render({ loading: true })]) {
      expect(html).not.toMatch(
        /role="status"[^>]*aria-live|aria-live[^>]*role="status"/,
      )
    }
  })

  it('keeps only its empty count when there is nothing more', () => {
    // The count stays in the page, so the last load's "N showing" is said by
    // the same node rather than one added with its words already in it.
    expect(render({ canLoadMore: false, loading: false })).toBe(
      '<div tabindex="-1" aria-live="polite" class="sr-only"></div>',
    )
  })

  it('sits where it is told', () => {
    expect(render()).toContain('<div class="mt-3">')
    expect(render({ className: 'mx-4 mt-4' })).toContain(
      '<div class="mx-4 mt-4">',
    )
  })

  it('names what is listed', () => {
    expect(render({ noun: 'clients' })).toContain('Show more clients')
  })
})
