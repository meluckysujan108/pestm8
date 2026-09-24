import { describe, expect, it, vi } from 'vitest'
import { MarkupSaves } from './markupSaves'

/**
 * Undo and Clear tapped while strokes are still saving. The case that loses
 * work: a stroke the server refuses, and an Undo tapped to take it back before
 * the refusal arrives — which must not then take back an older mark instead.
 */

/** A save the test settles by hand. */
function saving() {
  let settle: (saved: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  return { done, settle }
}

/** Lets every queued promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('MarkupSaves', () => {
  it('spends an Undo aimed at a stroke whose save then fails, rather than taking an older mark', async () => {
    const saves = new MarkupSaves()
    const b = saving()
    saves.add(b.done)
    const undo = vi.fn(async () => {})

    const tapped = saves.undo(undo)
    b.settle(false) // "This report is full of marks."
    expect(await tapped).toBe('spent')
    expect(undo).not.toHaveBeenCalled()
  })

  it('takes back the stroke just drawn once it has saved', async () => {
    const saves = new MarkupSaves()
    const b = saving()
    saves.add(b.done)
    const undo = vi.fn(async () => {})

    const tapped = saves.undo(undo)
    await flush()
    // Not before the stroke is stored: there would be nothing to take back.
    expect(undo).not.toHaveBeenCalled()
    b.settle(true)
    expect(await tapped).toBe('undone')
    expect(undo).toHaveBeenCalledOnce()
  })

  it('goes straight to the newest stored mark with nothing saving', async () => {
    const saves = new MarkupSaves()
    const undo = vi.fn(async () => {})
    expect(await saves.undo(undo)).toBe('undone')
    expect(undo).toHaveBeenCalledOnce()
  })

  it('aims two quick Undos at two strokes: the second is not spent by the first’s failure', async () => {
    const saves = new MarkupSaves()
    const b = saving()
    saves.add(b.done)
    const undo = vi.fn(async () => {})

    const first = saves.undo(undo) // at B
    const second = saves.undo(undo) // at the mark before B, already stored
    b.settle(false)
    expect(await first).toBe('spent')
    expect(await second).toBe('undone')
    expect(undo).toHaveBeenCalledOnce()
  })

  it('claims the newest save still out, not one an earlier Undo already has', async () => {
    const saves = new MarkupSaves()
    const a = saving()
    const b = saving()
    saves.add(a.done)
    saves.add(b.done)
    const undo = vi.fn(async () => {})

    const first = saves.undo(undo) // at B
    const second = saves.undo(undo) // at A
    a.settle(false)
    b.settle(true)
    expect(await first).toBe('undone')
    expect(await second).toBe('spent')
    expect(undo).toHaveBeenCalledOnce()
  })

  it('forgets a save that has come back: a later Undo is for the marks on screen', async () => {
    const saves = new MarkupSaves()
    const b = saving()
    saves.add(b.done)
    b.settle(false)
    await flush()
    expect(saves.size).toBe(0)
    // The failed stroke has gone from the page, and said so; Undo now means
    // the newest mark that is actually there.
    const undo = vi.fn(async () => {})
    expect(await saves.undo(undo)).toBe('undone')
    expect(undo).toHaveBeenCalledOnce()
  })

  it('clears once the strokes before it have saved, whether or not they did', async () => {
    const saves = new MarkupSaves()
    const b = saving()
    saves.add(b.done)
    const clear = vi.fn(async () => {})

    const tapped = saves.clear(clear)
    await flush()
    expect(clear).not.toHaveBeenCalled()
    b.settle(false)
    await tapped
    expect(clear).toHaveBeenCalledOnce()
  })

  it('runs taps one after another, each after the one before has finished', async () => {
    const saves = new MarkupSaves()
    const order: Array<string> = []
    let finishFirst: () => void = () => {}
    const first = saves.undo(
      () =>
        new Promise<void>((resolve) => {
          order.push('first starts')
          finishFirst = () => {
            order.push('first ends')
            resolve()
          }
        }),
    )
    const second = saves.undo(async () => {
      order.push('second starts')
    })
    await flush()
    expect(order).toEqual(['first starts'])
    finishFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first starts', 'first ends', 'second starts'])
  })

  it('carries on after a tap that failed, and still reports the failure', async () => {
    const saves = new MarkupSaves()
    const failed = saves.undo(() => Promise.reject(new Error('offline')))
    const next = vi.fn(async () => {})
    const after = saves.clear(next)
    await expect(failed).rejects.toThrow('offline')
    await after
    expect(next).toHaveBeenCalledOnce()
  })

  it('takes a save that rejects outright as not saved', async () => {
    const saves = new MarkupSaves()
    saves.add(Promise.reject(new Error('boom')))
    const undo = vi.fn(async () => {})
    expect(await saves.undo(undo)).toBe('spent')
    expect(undo).not.toHaveBeenCalled()
  })
})
