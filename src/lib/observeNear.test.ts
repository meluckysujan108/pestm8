import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEAR_MARGIN, observeNear, scrollRootOf } from './observeNear'

/**
 * The end of a list coming near, with a stand-in IntersectionObserver: there
 * is no layout here, so what is checked is what the list is told and what it
 * asks the browser to watch.
 */

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void

function fakeObserver() {
  const made: Array<{
    callback: Callback
    options: { root: Element | null; rootMargin: string }
    watched: Array<Element>
    disconnected: boolean
  }> = []
  class FakeIntersectionObserver {
    record: (typeof made)[number]
    constructor(
      callback: Callback,
      options: { root: Element | null; rootMargin: string },
    ) {
      this.record = { callback, options, watched: [], disconnected: false }
      made.push(this.record)
    }
    observe(el: Element) {
      this.record.watched.push(el)
    }
    disconnect() {
      this.record.disconnected = true
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  return made
}

const element = {} as Element

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('observeNear', () => {
  it('watches the element against the viewport, a screen and a half ahead', () => {
    const made = fakeObserver()
    observeNear(element, () => {})
    expect(made).toHaveLength(1)
    expect(made[0].watched).toEqual([element])
    expect(made[0].options).toEqual({ root: null, rootMargin: NEAR_MARGIN })
    expect(NEAR_MARGIN).toBe('0px 0px 150% 0px')
  })

  it('measures against the scroll container it is given', () => {
    const made = fakeObserver()
    const column = {} as Element
    observeNear(element, () => {}, { root: column })
    expect(made[0].options.root).toBe(column)
  })

  it('reports the latest of a batch of entries', () => {
    const made = fakeObserver()
    const seen: Array<boolean> = []
    observeNear(element, (near) => seen.push(near))
    made[0].callback([{ isIntersecting: false }, { isIntersecting: true }])
    made[0].callback([{ isIntersecting: false }])
    made[0].callback([])
    expect(seen).toEqual([true, false])
  })

  it('stops watching when told to', () => {
    const made = fakeObserver()
    const stop = observeNear(element, () => {})
    expect(made[0].disconnected).toBe(false)
    stop()
    expect(made[0].disconnected).toBe(true)
  })

  it('says "not near", once, where there is no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const seen: Array<boolean> = []
    const stop = observeNear(element, (near) => seen.push(near))
    expect(seen).toEqual([false])
    expect(() => stop()).not.toThrow()
  })
})

describe('scrollRootOf', () => {
  type Node = {
    tagName: string
    parentElement: Node | null
    scrollHeight: number
    clientHeight: number
    overflowY: string
  }

  /** A chain of ancestors, innermost first, ending at <body> and <html>. */
  function chain(...ancestors: Array<Partial<Node> & { name: string }>) {
    const html: Node = {
      tagName: 'HTML',
      parentElement: null,
      scrollHeight: 5000,
      clientHeight: 800,
      overflowY: 'auto',
    }
    const body: Node = {
      tagName: 'BODY',
      parentElement: html,
      scrollHeight: 5000,
      clientHeight: 800,
      overflowY: 'auto',
    }
    let parent = body
    const nodes: Record<string, Node> = {}
    for (const { name, ...rest } of [...ancestors].reverse()) {
      const node: Node = {
        tagName: 'DIV',
        parentElement: parent,
        scrollHeight: 100,
        clientHeight: 100,
        overflowY: 'visible',
        ...rest,
      }
      nodes[name] = node
      parent = node
    }
    vi.stubGlobal('getComputedStyle', (node: Node) => ({
      overflowY: node.overflowY,
    }))
    const sentinel = { parentElement: parent } as unknown as Element
    return { sentinel, nodes }
  }

  it('is the viewport when nothing between the list and the page scrolls', () => {
    const { sentinel } = chain({ name: 'list' }, { name: 'main' })
    expect(scrollRootOf(sentinel)).toBeNull()
  })

  it('is a column that scrolls its own content (Notes on a computer)', () => {
    const { sentinel, nodes } = chain(
      { name: 'list' },
      {
        name: 'column',
        overflowY: 'auto',
        scrollHeight: 3000,
        clientHeight: 700,
      },
      { name: 'main' },
    )
    expect(scrollRootOf(sentinel)).toBe(nodes.column)
  })

  it('is not a column set to scroll that fits its content (Notes on a phone)', () => {
    const { sentinel } = chain(
      { name: 'list' },
      {
        name: 'column',
        overflowY: 'auto',
        scrollHeight: 3000,
        clientHeight: 3000,
      },
    )
    expect(scrollRootOf(sentinel)).toBeNull()
  })

  it('takes the nearest of two that scroll (a sheet over a page)', () => {
    const { sentinel, nodes } = chain(
      { name: 'list' },
      {
        name: 'sheet',
        overflowY: 'scroll',
        scrollHeight: 900,
        clientHeight: 500,
      },
      {
        name: 'page',
        overflowY: 'auto',
        scrollHeight: 4000,
        clientHeight: 800,
      },
    )
    expect(scrollRootOf(sentinel)).toBe(nodes.sheet)
  })

  it('never answers the body or the page itself', () => {
    const { sentinel } = chain()
    expect(scrollRootOf(sentinel)).toBeNull()
  })
})
