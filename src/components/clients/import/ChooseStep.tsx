import { useRef, useState } from 'react'
import { FileSpreadsheet, FileUp, ListOrdered, Rows3 } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { NEUTRAL_BUTTON } from '#/components/primitives/buttons'
import { useHydrated } from '#/lib/useHydrated'
import { RecentImports } from './RecentImports'
import { StepHeading } from './ui'
import { UndoHold } from './undo'
import type { DragEvent } from 'react'
import type { RecentImport } from './queries'
import type { UndoClock } from './undo'
import type { Id } from '../../../../convex/_generated/dataModel'

/** What the picker offers. The types as well as the endings: an iPhone's
 * Files picker goes by type, and greys out a .csv it isn't told about. */
const ACCEPT = [
  '.csv',
  '.xlsx',
  '.txt',
  '.tsv',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',')

const TIPS = [
  { Icon: FileUp, text: 'Export your clients from your old app as a CSV.' },
  { Icon: Rows3, text: 'One row per client, or one per site — both work.' },
  { Icon: ListOrdered, text: 'Up to 2,000 rows at a time.' },
]

/**
 * Step one: the file. A button for a phone, and a place to drop it for a
 * laptop, where the export has just landed in Downloads. Nothing is read
 * until one is chosen, and nothing leaves the browser until Import.
 *
 * The drop itself is the page's (import.tsx): a file let go of anywhere on
 * it is taken as chosen, not just one on the box. This only lights the box.
 */
export function ChooseStep({
  businessId,
  timezone,
  reading,
  holding,
  clock,
  error,
  onChoose,
}: {
  businessId: Id<'businesses'>
  timezone: string
  /** A file is being read (an Excel workbook can take a moment). */
  reading: boolean
  /** An import being undone — moving, or stopped part-way — which a new
   * file waits for (`undoHolding`); null when there is none. */
  holding: { row: RecentImport; stopped: boolean } | null
  /** The page's clock for its undos (`useUndoClock`), for Recent imports. */
  clock: UndoClock
  /** Why the last file couldn't be read, in words for the page. */
  error: string | null
  onChoose: (file: File) => void
}) {
  const hydrated = useHydrated()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const ready = hydrated && !reading && holding === null

  const dragging = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (ready) setOver(true)
  }

  return (
    <>
      <StepHeading
        title="Bring your clients across"
        lede="From ServiceM8, Jobber, Tradify, Xero, MYOB or your own spreadsheet — CSV or Excel. Nothing is saved until you press Import."
      />

      <div
        onDragEnter={dragging}
        onDragOver={dragging}
        onDragLeave={(event) => {
          // Leaving for one of its own children is not leaving.
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setOver(false)
          }
        }}
        // Taken by the page's own drop, which this reaches first.
        onDrop={() => setOver(false)}
        className={`mt-5 flex flex-col items-center rounded-2xl border-2 border-dashed px-5 py-9 text-center transition-colors ${
          over ? 'border-blue bg-blue/8' : 'border-hairline bg-surface'
        }`}
      >
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full bg-blue-bg text-blue-ink"
        >
          <FileSpreadsheet size={24} strokeWidth={1.8} />
        </span>
        <p className="mt-3 text-row-title text-ink">
          {over ? 'Drop it here' : 'Your client list'}
        </p>
        <p className="mt-0.5 text-caption text-muted">
          CSV or Excel (.xlsx), up to 5 MB
          <span className="hidden lg:inline"> — or drag it here</span>
        </p>
        {/* Ink, not red: choosing a file saves nothing — Import does. */}
        <button
          type="button"
          disabled={!ready}
          onClick={() => input.current?.click()}
          className={`${NEUTRAL_BUTTON} mt-5 min-w-44 px-5`}
        >
          {reading ? 'Reading…' : 'Choose a file'}
        </button>
        {holding && (
          <UndoHold
            businessId={businessId}
            row={holding.row}
            stopped={holding.stopped}
            then="choose a file"
            className="mt-3 flex max-w-sm flex-col items-center"
          />
        )}
        {/* The button above is what a person uses; this is what the browser
            needs to show its picker. Out of the accessibility tree, so the
            page has one "Choose a file", not two. */}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          aria-hidden
          tabIndex={-1}
          disabled={!ready}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Cleared, so choosing the same file again — fixed and saved
            // over — is still a change.
            event.target.value = ''
            if (file) onChoose(file)
          }}
        />
      </div>

      <FormAlert className="mt-3">{error}</FormAlert>

      <ul className="mt-5 space-y-2.5 px-1">
        {TIPS.map(({ Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-body">
            <Icon
              aria-hidden
              size={17}
              strokeWidth={1.8}
              className="mt-0.5 shrink-0 text-muted"
            />
            <span className="text-ink-2">{text}</span>
          </li>
        ))}
      </ul>

      <RecentImports
        businessId={businessId}
        timezone={timezone}
        clock={clock}
      />
    </>
  )
}
