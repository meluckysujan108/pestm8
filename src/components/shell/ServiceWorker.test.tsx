import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewVersionBanner } from './ServiceWorker'

// ServiceWorker refreshes the kept pages (lib/offline/keptPages.ts), which
// ask lib/rootState.ts who is signed in; its server function's module wants
// the deployment's URLs, which CI's unit run doesn't have.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

describe('the new-version banner', () => {
  const html = renderToStaticMarkup(
    <NewVersionBanner onReload={() => {}} onDismiss={() => {}} />,
  )
  const classes = /class="([^"]*)"/.exec(html)?.[1].split(' ') ?? []

  it('sits under the header, clear of the notch', () => {
    expect(classes).toContain('fixed')
    expect(classes).toContain('top-[calc(84px+env(safe-area-inset-top))]')
  })

  it('is never anchored to the bottom, where pages keep their action bars', () => {
    // The report builder's Back / Next / Finalise and the template editor's
    // Save / Issue are fixed 64px up at z-30; a banner 76px up covered them.
    expect(classes.filter((c) => /(^|:)bottom-/.test(c))).toEqual([])
  })

  it('stays under sheets and dialogs, whose scrim is z-40', () => {
    expect(classes).toContain('z-30')
  })
})
