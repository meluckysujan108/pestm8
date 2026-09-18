import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'

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
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onChange(draft), 250)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])

  return (
    <label className="flex h-10 flex-1 items-center gap-2 rounded-xl bg-surface-3 px-3">
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
            onChange('')
          }}
          className="flex size-5 items-center justify-center rounded-full bg-muted-2/40 text-white"
        >
          <X size={12} strokeWidth={2.6} />
        </button>
      )}
    </label>
  )
}
