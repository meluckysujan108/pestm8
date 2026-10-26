import { useState } from 'react'
import { Check, WifiOff } from 'lucide-react'
import { formatUpdated } from '#/lib/format'
import {
  useNoteHolds,
  useOnScreen,
  useShowsKept,
} from '#/lib/offline/keptOnScreen'
import type { KeptNote, KeptNoteTone } from '#/lib/offline/useKept'

/**
 * What the note says first, by what the line is doing. "Could not reach
 * PestM8 — …" is kept about as short as "No signal — …", so the note, as
 * tall as the wordiest of them, has no line to spare on the main case.
 */
const FIRST_LINE: Record<KeptNoteTone, string> = {
  'no-signal': 'No signal — showing the copy kept on this phone.',
  unreachable: 'Could not reach PestM8 — showing the kept copy.',
  kept: 'Showing the copy kept on this phone.',
  live: 'Up to date.',
}

const TONES = Object.keys(FIRST_LINE) as Array<KeptNoteTone>

/**
 * Says a page is showing the copy kept on this phone, and when that copy was
 * last known to be right: "No signal — showing the copy kept on this phone."
 * over "Updated 9:42am". The Products page's line, in the same place under
 * what sits above the list.
 *
 * Drawn from `useKeptNote` (lib/offline/useKept.ts), which decides once
 * whether it shows and never puts it in later. The server always draws it,
 * hidden unless the head script has marked the page as a copy the service
 * worker kept (`kept:flex`), so it is there from the first paint on exactly
 * those pages, in the words for no signal when the phone has none
 * (`kept-offline:`). Once everything under it is live it says "Up to date."
 * over when it came live, and goes with the next change of day or view.
 *
 * It is never taller or shorter than it first painted, so nothing under it
 * moves as its words follow the line: every first line it can say is laid
 * in the same place, all but one unseen, which makes it as tall as the
 * wordiest of them at this width, and the "Updated" line is always there.
 *
 * While it says the line is down ("No signal — …", "Could not reach
 * PestM8 — …"), and is on screen, the can't-reach banner gives way to it,
 * but for a change waiting to save (`useNoteHolds`, `useOnScreen`,
 * lib/offline/keptOnScreen.ts): the two said the same, one over the other.
 * So too for a while once the line is back and it says "Showing the copy
 * kept on this phone.", until PestM8 has answered on the new line.
 *
 * `todayKey` is the loader's today, so the server and the hydration render
 * word the time alike.
 */
export function KeptCopyNote({
  phase,
  tone,
  asOf,
  timezone,
  todayKey,
  className = 'mx-4 mt-3',
}: Pick<KeptNote, 'phase' | 'tone' | 'asOf'> & {
  timezone: string
  todayKey: string
  /** Where it sits: under the week strip on a phone, by default. */
  className?: string
}) {
  // Where it is drawn, for whether it is on screen.
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const holds = useNoteHolds({ phase, tone })
  const onScreen = useOnScreen(node)
  useShowsKept(holds && onScreen)
  if (phase === 'hidden') return null
  const hydrating = phase === 'hydrating'
  const live = !hydrating && tone === 'live'
  return (
    <div
      ref={setNode}
      role="status"
      data-kept-note={tone}
      className={`${hydrating ? 'hidden kept:flex' : 'flex'} items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2 ${className}`}
    >
      {live ? (
        <Check
          aria-hidden
          size={14}
          strokeWidth={2.2}
          className="mt-0.5 shrink-0"
        />
      ) : (
        <WifiOff
          aria-hidden
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0"
        />
      )}
      <p className="min-w-0">
        <span className="grid">
          <span data-kept-words className="col-start-1 row-start-1">
            {hydrating ? (
              // The server can't know whether the phone has signal; the head
              // script says, and the CSS picks the words to match.
              <>
                <span className="kept-offline:hidden">{FIRST_LINE.kept}</span>
                <span className="hidden kept-offline:inline">
                  {FIRST_LINE['no-signal']}
                </span>
              </>
            ) : (
              FIRST_LINE[tone]
            )}
          </span>
          {TONES.map((each) => (
            <span
              key={each}
              aria-hidden
              data-kept-sizer
              className="invisible col-start-1 row-start-1"
            >
              {FIRST_LINE[each]}
            </span>
          ))}
        </span>
        {/* Always there, so the note keeps its height: a space when no
            time is known yet. */}
        <span className="block">
          {asOf === null
            ? '\u00a0'
            : `Updated ${formatUpdated(asOf, timezone, todayKey)}`}
        </span>
      </p>
    </div>
  )
}
