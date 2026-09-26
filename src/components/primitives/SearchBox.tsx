import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { recordSend, settleEcho, settlesAt } from './searchEcho'

/**
 * A search field whose typing is instant and whose QUERY is not.
 *
 * The URL — and the server query behind it — follows after a pause. Without
 * that, every keystroke is a round trip: the reports list navigated on each
 * character, which was survivable only because its search was a substring
 * test over a payload it had already fetched in full.
 *
 * Lifted out of `NotesLibrary` when the reports library needed the same
 * thing. The only difference between the two was the word in the placeholder.
 *
 * `value` is usually the URL, so it arrives late: a term handed to `onChange`
 * comes back only once its navigation commits, by which time more may have
 * been typed. This box used to take that echo for an outside change and put
 * the older term back — type "wat", pause, carry on while that navigation was
 * still out, and "wattle" came back as "wat". So terms it sent are remembered
 * until they come back (./searchEcho.ts), and only a value it did NOT send (a
 * filter cleared elsewhere, the back button) replaces the draft.
 */
export function SearchBox({
  value,
  onChange,
  label,
  placeholder = 'Search',
}: {
  value: string
  onChange: (term: string) => void
  /** Named for screen readers: "Search reports", not a second "Search". */
  label: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)
  // Sent, oldest first, and not yet echoed back through `value`.
  const unechoed = useRef<Array<string>>([])

  function send(term: string) {
    unechoed.current = recordSend(unechoed.current, term, value)
    onChange(term)
  }
  const sendLater = useEffectEvent(send)

  useEffect(() => {
    const settled = settleEcho(unechoed.current, value)
    unechoed.current = settled.unechoed
    if (settled.adopt) setDraft(value)
  }, [value])

  useEffect(() => {
    if (draft === settlesAt(unechoed.current, value)) return
    const timer = setTimeout(() => sendLater(draft), 250)
    return () => clearTimeout(timer)
  }, [draft, value])

  return (
    <label className="flex h-10 flex-1 items-center gap-2 rounded-xl bg-surface-3 px-3 focus-within:ring-2 focus-within:ring-blue">
      <Search size={16} strokeWidth={2} className="shrink-0 text-muted" />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {draft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setDraft('')
            send('')
          }}
          // A 20px circle in a 44px target; solid muted, as iOS draws it — the
          // 40% tint it had was 1.5:1 against the well.
          className="relative tap-target flex size-5 items-center justify-center rounded-full bg-muted text-surface"
        >
          <X size={12} strokeWidth={2.6} />
        </button>
      )}
    </label>
  )
}
