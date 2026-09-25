import {
  clear,
  clearFailed,
  clearLanded,
  clearTakenOver,
  drawn,
  removeFailed,
  removeLanded,
  saveFailed,
  saveLanded,
  undo,
} from './localMarks'
import type { LocalMarks } from './localMarks'
import type { Strokes } from './pendingMarks'
import type { ClearUnderway, MarkupPoint, ViewerMarkup } from './types'

/**
 * The pen's three acts — a finished stroke, Undo, Clear — and what follows
 * each when the caller answers: `localMarks.ts`'s rules, run against the
 * caller's `ViewerMarkup`. Plus the Clears a viewer closed since left still
 * out, which this one follows as if it had asked for them (`takeOver`).
 *
 * Kept out of the hook (`useMarkupSession`) so the orderings that matter can
 * be driven, with a real caller behind them, without React: every act reads
 * the latest local marks through `read`, never a render's copy — two Undos
 * inside one frame must each see the mark the other just took — and every
 * answer that arrives later does the same.
 */
export type MarkupSessionDeps = {
  /** The caller's markup layer as it is now; undefined once it has gone. */
  markup: () => ViewerMarkup | undefined
  /** The caller's marks as they are on screen now. */
  strokes: () => Strokes | undefined
  /** The local marks as they are now. */
  read: () => LocalMarks
  /**
   * Makes `next` the local marks. `urgent`: on screen before this returns —
   * the pen clears its own line the moment a finished stroke is handed over,
   * and the stroke must already be drawn in its place.
   */
  commit: (next: LocalMarks, urgent?: boolean) => void
  toast: (message: string) => void
  now: () => number
}

export type MarkupSession = {
  /** A stroke finished on the 0-based page `pageIndex`. */
  stroke: (pageIndex: number, points: Array<MarkupPoint>) => void
  /** Undo was tapped. */
  undo: () => void
  /** Clear was confirmed for the 0-based page `pageIndex`. */
  clear: (pageIndex: number) => void
  /**
   * The caller's Clears still on their way (`ViewerMarkup.clearsUnderway`):
   * any this session did not ask for — a viewer closed since did — are
   * followed from here as if it had, their pages hidden until they land.
   * Safe to call as often as the caller changes; each is taken over once.
   */
  takeOver: (clears: ReadonlyArray<ClearUnderway>) => void
}

export function createMarkupSession(deps: MarkupSessionDeps): MarkupSession {
  const { read, commit } = deps
  let strokeCount = 0
  let clearCount = 0
  // Every Clear this session follows, by the promise the caller gave for it:
  // those it asked for, and those it took over.
  const following = new WeakSet<Promise<void>>()

  /** Asks the caller to remove a mark an Undo chose, and hid already. */
  const remove = (id: string) => {
    attempt(() => deps.markup()?.removeStroke(id)).then(
      () => commit(removeLanded(read(), id, deps.strokes())),
      (error: unknown) => {
        const before = read()
        const after = removeFailed(before, id)
        commit(after)
        // Said only when the mark comes back: one a Clear took meanwhile is
        // gone either way.
        if (after !== before) {
          deps.toast(wordsFor(error, "Couldn't undo your last mark."))
        }
      },
    )
  }

  /** Follows Clear `clearId` of `pageIndex` to wherever it lands. */
  const follow = (clearId: number, pageIndex: number, done: Promise<void>) => {
    done.then(
      () => commit(clearLanded(read(), clearId, deps.strokes())),
      (error: unknown) => {
        commit(clearFailed(read(), clearId))
        deps.toast(
          wordsFor(
            error,
            `Couldn't clear your marks on page ${pageIndex + 1}.`,
          ),
        )
      },
    )
  }

  return {
    stroke(pageIndex, points) {
      const markup = deps.markup()
      if (!markup) return
      const key = `pending-${++strokeCount}`
      commit(drawn(read(), key, pageIndex, points, deps.strokes()), true)
      attempt(() => markup.addStroke(pageIndex, points.slice())).then(
        (id) => {
          const landed = saveLanded(read(), key, id, deps.strokes(), deps.now())
          commit(landed.state)
          // An Undo was aimed at this stroke while it saved: it has a name.
          if (landed.remove !== null) remove(landed.remove)
        },
        (error: unknown) => {
          commit(saveFailed(read(), key))
          deps.toast(wordsFor(error, "Your mark didn't save."))
        },
      )
    },

    undo() {
      if (!deps.markup()) return
      const tap = undo(read(), deps.strokes())
      if (!tap) return
      commit(tap.state)
      if (tap.remove !== null) remove(tap.remove)
    },

    clear(pageIndex) {
      const markup = deps.markup()
      if (!markup) return
      // Hidden, and handed over, now: the caller clears what was drawn
      // before this tap and spares what is drawn after it
      // (`ViewerMarkup.clearPage`).
      const clearId = ++clearCount
      commit(clear(read(), clearId, pageIndex))
      const asked = attempt(() => {
        const done = markup.clearPage(pageIndex)
        // Known as this session's own, so `takeOver` never follows it twice.
        if (done instanceof Promise) following.add(done)
        return done
      })
      follow(clearId, pageIndex, asked)
    },

    takeOver(clears) {
      for (const { pageIndex, done } of clears) {
        if (following.has(done)) continue
        following.add(done)
        const clearId = ++clearCount
        commit(clearTakenOver(read(), clearId, pageIndex))
        // Its failure is said here: the viewer that asked for it, and would
        // have said so, has gone.
        follow(clearId, pageIndex, done)
      }
    },
  }
}

/** The caller's promise; a throw, or no caller at all, as a rejection. */
function attempt<T>(call: () => Promise<T> | undefined): Promise<T> {
  try {
    const result = call()
    return result ? Promise.resolve(result) : Promise.reject(new Error(''))
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * What to say when a save, an undo or a clear fails: the caller's own words
 * when it rejected with some — it knows why ("This report is full of marks"),
 * and that is worth more than "didn't save" to someone about to try again —
 * and the viewer's otherwise.
 */
function wordsFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : fallback
}
