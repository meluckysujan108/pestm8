import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from 'lucide-react'
import type { RefObject } from 'react'

/**
 * Find in the PDF, as iOS draws it: the search field takes the bottom
 * toolbar's place, with the count, up and down, and Done.
 *
 * It sits at the bottom rather than the top so it stays under the thumb and
 * right above the keyboard, and so the match it jumps to is shown in the page
 * above it rather than behind it. The input is 16px: anything smaller and iOS
 * zooms the whole app when it takes focus.
 */
export function SearchBar({
  inputRef,
  query,
  onQuery,
  status,
  busy,
  canStep,
  onStep,
  onDone,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (query: string) => void
  /** "3 of 12", "No matches" — or nothing. */
  status: string | null
  /** Still reading pages, with nothing found yet. */
  busy: boolean
  canStep: boolean
  onStep: (direction: 1 | -1) => void
  onDone: () => void
}) {
  return (
    <form
      role="search"
      aria-label="Search in PDF"
      className="flex h-[52px] items-center gap-0.5 pl-3 pr-1"
      onSubmit={(event) => {
        event.preventDefault()
        onStep(1)
      }}
    >
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden
          size={16}
          strokeWidth={2}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search in PDF"
          placeholder="Search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey) {
              event.preventDefault()
              onStep(-1)
            }
          }}
          className={[
            'h-11 w-full rounded-xl bg-fill-track pl-9 text-[16px] text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-blue',
            query ? 'pr-28' : 'pr-3',
          ].join(' ')}
        />
        {query && (
          <>
            <span
              aria-live="polite"
              aria-atomic="true"
              className="pointer-events-none absolute right-11 top-1/2 max-w-24 -translate-y-1/2 truncate text-caption text-muted"
            >
              {busy ? (
                <LoaderCircle
                  size={16}
                  className="animate-spin"
                  aria-label="Searching"
                />
              ) : (
                status
              )}
            </span>
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                onQuery('')
                inputRef.current?.focus()
              }}
              className="absolute right-0 top-0 flex size-11 items-center justify-center text-muted"
            >
              <X size={17} strokeWidth={2.2} />
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="Previous match"
        disabled={!canStep}
        onClick={() => onStep(-1)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-blue transition active:opacity-50 disabled:text-muted-2"
      >
        <ChevronUp size={22} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label="Next match"
        disabled={!canStep}
        onClick={() => onStep(1)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-blue transition active:opacity-50 disabled:text-muted-2"
      >
        <ChevronDown size={22} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={onDone}
        // Named apart from the top bar's Done, which closes the whole viewer.
        aria-label="Done searching"
        className="h-11 shrink-0 rounded-lg px-2.5 text-[17px] font-semibold text-blue transition active:opacity-50"
      >
        Done
      </button>
    </form>
  )
}
