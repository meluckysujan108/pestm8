/**
 * The strokes still on their way to the server, and the Undo and Clear taps
 * waiting on them.
 *
 * Undo and Clear wait for every stroke already drawn to finish saving, so
 * that Undo takes back the stroke just drawn rather than the one before it,
 * and Clear takes that one too. Waiting is not the whole of it, though: an
 * Undo tapped while a stroke is saving is aimed at THAT stroke, and if its
 * save then fails there is nothing left to take back. Going ahead anyway
 * would remove the newest mark that did save — an older one, maybe on another
 * page and off screen — which nobody asked for and nothing can bring back.
 * (At a report's mark limit that is exactly what would happen: the new
 * stroke is refused, "This report is full of marks" shows, and a quick Undo
 * of the refused stroke deletes a real one.) So each Undo claims the newest
 * save it was tapped over that no earlier Undo has claimed, and is spent,
 * doing nothing, when that save fails; an Undo with no save to claim goes to
 * the newest stored mark, as it always does.
 *
 * The taps' own work runs one after another, in the order they were made:
 * two quick Undos are two of your marks, the second chosen once the first has
 * gone, not the same one twice.
 *
 * No React and no DOM, so every ordering can be tested with bare promises.
 */

type Save = {
  /** True when the stroke saved, false when it did not. Never rejects. */
  done: Promise<boolean>
  /** An Undo is already aimed at this stroke. */
  claimed: boolean
}

export class MarkupSaves {
  private out: Array<Save> = []
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * A stroke's save, as it starts: `done` says whether it saved. (One that
   * rejects instead is taken as not saved.)
   */
  add(done: Promise<boolean>): void {
    const save: Save = { done: done.catch(() => false), claimed: false }
    this.out.push(save)
    void save.done.then(() => {
      this.out = this.out.filter((s) => s !== save)
    })
  }

  /** How many saves are still out. */
  get size(): number {
    return this.out.length
  }

  /**
   * Runs `clear` once every save out now has come back, after any Undo or
   * Clear tapped before it; rejects if it does.
   */
  clear(clear: () => Promise<void>): Promise<void> {
    const waits = this.out.map((s) => s.done)
    return this.run(() => Promise.all(waits).then(() => clear()))
  }

  /**
   * Runs `undo` once every save out now has come back, after any Undo or
   * Clear tapped before it — unless the save this Undo was aimed at failed.
   * Resolves `'spent'` then, and `'undone'` when `undo` ran; rejects if
   * `undo` does.
   */
  undo(undo: () => Promise<void>): Promise<'undone' | 'spent'> {
    let target: Save | null = null
    for (let i = this.out.length - 1; i >= 0 && !target; i--) {
      if (!this.out[i].claimed) target = this.out[i]
    }
    if (target) target.claimed = true
    const waits = this.out.map((s) => s.done)
    return this.run(async () => {
      await Promise.all(waits)
      if (target && !(await target.done)) return 'spent' as const
      await undo()
      return 'undone' as const
    })
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    // The next tap waits for this one to finish, whether or not it worked.
    this.queue = result.catch(() => {})
    return result
  }
}
