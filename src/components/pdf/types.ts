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
  save: (file: File) => Promise<void> | void
  /** "Save to Files" on Apple phones and tablets, "Download" elsewhere. */
  saveLabel: string
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

export type DocumentViewerProps = {
  /** Shown in the top bar — the product's name. */
  title: string
  /** What the file is called when it is shared or saved. Ends in `.pdf`. */
  fileName: string
  source: DocumentSource
  actions: ViewerActions
  onClose: () => void
}
