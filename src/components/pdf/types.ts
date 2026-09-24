/**
 * The contract between the in-app PDF viewer and whatever opens it.
 *
 * The viewer is loaded lazily and only in the browser (pdf.js touches
 * `DOMMatrix` and starts a worker at module load, which crashes a server
 * render), so this file holds nothing but types: a route can import it
 * without pulling pdf.js into its own chunk.
 *
 * The viewer never learns where its bytes come from. The caller hands it a
 * `load` function that reads a copy kept on this phone when there is one and
 * the network otherwise, which is what lets the same viewer open a safety data
 * sheet in a roof void with no signal.
 */

export type LoadProgress = {
  loaded: number
  /** Null when the server sent no length, so the viewer shows a spinner. */
  total: number | null
}

export type DocumentSource = {
  /**
   * Stable identity of these exact bytes — the PDF's URL. It keys the
   * remembered reading position, and the viewer starts over when it changes,
   * which is what happens when someone replaces the file while it is open.
   */
  key: string
  load: (
    onProgress: (progress: LoadProgress) => void,
    signal: AbortSignal,
  ) => Promise<Blob>
}

export type ViewerActions = {
  /**
   * Hands the PDF itself to the system share sheet. It receives a finished
   * `File` rather than a promise of one because Safari only lets `share()` run
   * inside the tap that asked for it: an `await` for a download in between
   * and the share sheet never opens. Absent where the browser cannot share
   * files at all.
   */
  share?: (file: File) => Promise<void>
  /**
   * Saves a copy outside the app — an `<a download>` where that works, the
   * share sheet's "Save to Files" on an iPhone or iPad, where a download from
   * an installed app has nowhere sensible to land.
   */
  save?: (file: File) => Promise<void> | void
  /**
   * "Save to Files" on Apple phones and tablets, "Download" elsewhere. Given
   * with `save`; both are absent for a document that must not leave the app
   * (a report's draft preview), and the More menu then offers only what is
   * left, or is not drawn at all.
   */
  saveLabel?: string
  /**
   * Offered only to the product's creator and the owner. Opens the file
   * picker; once the new file is saved, `source.key` changes and the viewer
   * reloads on its own.
   */
  replace?: () => void
  /** A copy kept on this phone, for sites with no signal. */
  keep?: {
    kept: boolean
    busy: boolean
    toggle: () => void
  }
}

/** A point on a page, as fractions of the page as displayed (0–1, top-left). */
export type MarkupPoint = { x: number; y: number }

/** One mark on a page. */
export type MarkupStroke = {
  id: string
  points: ReadonlyArray<MarkupPoint>
  /** Drawn by the person looking at it: theirs to undo or clear. */
  mine: boolean
  /**
   * When it was made, as a number that never goes down: a later mark's is at
   * least as large (a report's is its `createdAt`). Undo takes the one of
   * yours with the largest — of two alike, the later in `strokes` — when
   * nothing of yours is still saving.
   */
  order: number
  /**
   * The colour of someone else's mark (a CSS colour, e.g. a member colour
   * token). Absent for one's own marks, which use the markup pen colour, and
   * for others when no colour is known (the viewer then uses one neutral
   * colour for everyone else).
   */
  color?: string
}

/**
 * A markup layer over the pages — a report's marks, for the team.
 *
 * The viewer draws the marks, runs markup mode (one finger draws, two pan and
 * zoom), keeps a just-drawn stroke on screen until the caller's `strokes`
 * include it, and knows nothing of who may do what beyond these fields: the
 * caller decides and the server enforces.
 *
 * Undo is the viewer's to aim: it picks the mark when the thumb lands —
 * this person's newest, a stroke still saving included — and hides it at
 * once, then names it to `removeStroke` by id, so a stroke drawn while the
 * Undo is on its way can never be the one it takes. Clear is handed over the
 * moment it is tapped, and the order it lands in among the saves is the
 * caller's to keep (see `clearPage`).
 */
export type ViewerMarkup = {
  /**
   * Every mark, by 0-based page index. A new Map only when the marks change:
   * the page slots are memoised on it.
   */
  strokes: ReadonlyMap<number, ReadonlyArray<MarkupStroke>>
  /** False shows the marks with no pen (someone who may only look). */
  canDraw: boolean
  /**
   * Saves a finished stroke and resolves with the saved mark's id — the one
   * it will have in `strokes` — which is how an Undo aimed at a stroke still
   * saving names it once it has saved. Rejects on failure; the viewer then
   * drops the stroke it was showing and says it did not save.
   */
  addStroke: (pageIndex: number, points: Array<MarkupPoint>) => Promise<string>
  /**
   * Removes one of this person's marks, by id — the one the viewer's Undo
   * chose. Resolves too when the mark is already gone (a Clear got there
   * first); rejects when it could not be removed, and the viewer shows the
   * mark again and says so.
   */
  removeStroke: (strokeId: string) => Promise<void>
  /**
   * Removes this person's marks on one page. Called the moment Clear is
   * tapped, without waiting for strokes still saving, so the ordering is the
   * caller's to keep: every stroke `addStroke` was called for before this is
   * cleared by it (its save lands first), and every stroke after it is not
   * (its save waits until the clear has landed). The viewer hides the page's
   * marks meanwhile, and shows them again if this rejects.
   */
  clearPage: (pageIndex: number) => Promise<void>
  /** Shown in the markup palette, e.g. that marks are not shared. */
  note?: string
  /**
   * Said once when the PDF is shared or saved while it has marks, e.g. "Sent
   * without the marks — they stay in the app for your team."
   */
  shareNote?: string
}

export type DocumentViewerProps = {
  /** Shown in the top bar — the product's name. */
  title: string
  /** What the file is called when it is shared or saved. Ends in `.pdf`. */
  fileName: string
  source: DocumentSource
  actions: ViewerActions
  onClose: () => void
  /** A markup layer over the pages; absent means no pen and no marks. */
  markup?: ViewerMarkup
  /**
   * A short, non-interactive label kept on screen under the top bar, e.g.
   * "Draft — not the finished document" or "Replaced by version 2".
   */
  badge?: string
  /**
   * Remember and restore where the reader was, per `source.key` (default
   * true). Off for a one-off document such as a draft preview, whose key
   * would only push real documents out of the remembered list.
   */
  rememberPosition?: boolean
}
