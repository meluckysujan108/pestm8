import { useEffect, useRef, useState } from 'react'
import { searchAddresses } from '#/lib/addressLookup'
import type { KeyboardEvent } from 'react'
import type { AddressSuggestion } from '#/lib/addressLookup'

/** One lookup per pause in typing, not one per key. */
const DEBOUNCE_MS = 300
const MIN_CHARS = 3

const SIZES = {
  lg: 'h-12 px-3.5 text-[16px]',
  md: 'h-11 px-3.5 text-[15px]',
}

/**
 * The Street address input, with address suggestions under it as it is typed
 * (Prompt 6.2).
 *
 * It is the <input> itself, as a combobox, so it drops into a <form> in place
 * of a plain input: `required`, the form's own validation and Enter to submit
 * all behave as before. Do NOT put it inside a <label> — the list renders
 * beside the input, and inside a label every suggestion's text would become
 * part of the field's name. Name it with <label htmlFor={id}> or `ariaLabel`.
 *
 * Typing only ever calls `onChange` with what was typed. `onPick` fills the
 * street, suburb, state and postcode, and only when a suggestion is chosen
 * (its postcode can be ''); `onChange` is not also called then. Offline,
 * Photon down or nothing found all look the same: no list, never an error.
 *
 * The list is positioned under the input, inside the sheet, rather than
 * portalled out of it: a modal sheet turns pointer events off everywhere
 * outside itself, so a portalled list could not be tapped.
 */
export function AddressLookupInput({
  id,
  value,
  onChange,
  onPick,
  required,
  placeholder,
  ariaLabel,
  size = 'lg',
  biasState,
}: {
  id: string
  value: string
  onChange: (addressLine: string) => void
  onPick: (address: {
    addressLine: string
    suburb: string
    state: string
    postcode: string
  }) => void
  required?: boolean
  placeholder?: string
  ariaLabel?: string
  size?: 'lg' | 'md'
  /** The business's state: suggestions there come first. */
  biasState?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [suggestions, setSuggestions] = useState<Array<AddressSuggestion>>([])
  /** What the suggestions were found for, so coming back to the field can
   * bring back a list that still fits what is in it. */
  const [foundFor, setFoundFor] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const inFlight = useRef<AbortController | null>(null)
  /** Bumped by every new lookup and every cancel; a reply carrying an older
   * number is for text that has since changed, and is dropped. */
  const ticket = useRef(0)
  const focused = useRef(false)

  const listRef = useRef<HTMLUListElement>(null)
  const listId = `${id}-suggestions`
  const optionId = (i: number) => `${id}-suggestion-${i}`
  // Only while they were found for exactly what is in the field. After an
  // edit the old rows would still carry the old house number: "12 Walcott
  // Street" picked a second after the 12 was corrected to 14 would put the
  // job at the wrong house. They go the moment the text changes, and the new
  // ones come in when found.
  const showing = open && suggestions.length > 0 && foundFor === value

  function cancelLookup() {
    clearTimeout(timer.current)
    inFlight.current?.abort()
    inFlight.current = null
    ticket.current += 1
  }

  useEffect(() => cancelLookup, [])

  function lookUp(text: string) {
    cancelLookup()
    setActive(-1)
    if (text.trim().length < MIN_CHARS) {
      setOpen(false)
      return
    }
    timer.current = setTimeout(() => {
      const mine = ++ticket.current
      const controller = new AbortController()
      inFlight.current = controller
      void searchAddresses(text, {
        signal: controller.signal,
        biasState,
      }).then((found) => {
        // Gone to another field meanwhile: a list opening now would sit over
        // whatever is being typed there.
        if (mine !== ticket.current || !focused.current) return
        setSuggestions(found)
        setFoundFor(text)
        setActive(-1)
        setOpen(found.length > 0)
      })
    }, DEBOUNCE_MS)
  }

  function pick(suggestion: AddressSuggestion) {
    cancelLookup()
    setOpen(false)
    setActive(-1)
    setSuggestions([])
    onPick({
      addressLine: suggestion.addressLine,
      suburb: suggestion.suburb,
      state: suggestion.state,
      postcode: suggestion.postcode,
    })
  }

  // On a phone the sheet shrinks to the space above the keyboard, and the
  // list opens below the field, inside the sheet's scroll: brought into view
  // when it opens, or it can sit hidden under the keyboard.
  useEffect(() => {
    if (showing) listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [showing])

  // The sheet around this field closes on Escape, from a listener on the
  // document that runs before any on the input (Radix's dismissable layer, in
  // the capture phase) and stands down for a key already marked handled. So
  // the list claims Escape first, on the window, while it is showing: Escape
  // closes the list, and only a second Escape closes the sheet.
  useEffect(() => {
    if (!showing) return
    const input = inputRef.current
    const view = input?.ownerDocument.defaultView
    if (!input || !view) return
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target !== input) return
      e.preventDefault()
      cancelLookup()
      setOpen(false)
      setActive(-1)
    }
    view.addEventListener('keydown', onEscape, true)
    return () => view.removeEventListener('keydown', onEscape, true)
  }, [showing])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const count = suggestions.length
      if (count === 0 || (!showing && foundFor !== value)) return
      e.preventDefault()
      const down = e.key === 'ArrowDown'
      if (!showing) {
        setOpen(true)
        setActive(down ? 0 : count - 1)
        return
      }
      setActive((i) => {
        if (i < 0) return down ? 0 : count - 1
        return (i + (down ? 1 : count - 1)) % count
      })
      return
    }
    // Enter takes a suggestion only once one has been moved to. Otherwise,
    // list or no list, it does what it always did in this form.
    if (e.key === 'Enter' && showing && active >= 0) {
      e.preventDefault()
      pick(suggestions[active])
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={
          showing && active >= 0 ? optionId(active) : undefined
        }
        aria-label={ariaLabel}
        value={value}
        required={required}
        placeholder={placeholder}
        // The browser's own list of past addresses would open over this one.
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          lookUp(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          focused.current = true
          if (suggestions.length > 0 && foundFor === value) setOpen(true)
        }}
        onBlur={() => {
          focused.current = false
          cancelLookup()
          setOpen(false)
          setActive(-1)
        }}
        className={`${SIZES[size]} w-full rounded-xl bg-surface-3 text-ink outline-none focus:ring-2 focus:ring-blue`}
      />

      <div
        hidden={!showing}
        // A press anywhere in the panel must leave focus in the input: the
        // blur would close the list before the tap on a row could land.
        onMouseDown={(e) => e.preventDefault()}
        className="absolute inset-x-0 top-full z-30 mt-1.5 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
      >
        <ul ref={listRef} id={listId} role="listbox" aria-label="Suggestions">
          {showing &&
            suggestions.map((s, i) => (
              <li
                key={s.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onClick={() => pick(s)}
                className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-xl px-2.5 py-1 transition hover:bg-surface-2 ${i === active ? 'bg-surface-2' : ''}`}
              >
                <span className="text-body font-semibold text-ink">
                  {s.addressLine}
                </span>
                <span className="text-caption text-muted">
                  {[s.suburb, s.state, s.postcode].filter(Boolean).join(' ')}
                </span>
              </li>
            ))}
        </ul>
        {showing && (
          <p className="px-2.5 pb-0.5 pt-1 text-[11px] text-muted">
            Address suggestions ©{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              OpenStreetMap contributors
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
