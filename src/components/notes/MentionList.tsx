import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import type { SuggestionKeyDownProps } from '@tiptap/suggestion'

export type MentionItem = {
  id: string
  label: string
  colour: string
  role: 'owner' | 'subcontractor'
}

export type MentionListProps = {
  items: Array<MentionItem>
  command: (item: MentionItem) => void
}

export type MentionListRef = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

/**
 * The `@` popover. Same visual idiom as BusinessSwitcher/FilterDropdown's
 * panels, but driven by Tiptap's suggestion plugin (which also positions it)
 * rather than a Radix trigger.
 */
export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  function MentionList({ items, command }, ref) {
    const [selected, setSelected] = useState(0)

    useEffect(() => setSelected(0), [items])

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          setSelected((i) => (i + items.length - 1) % Math.max(items.length, 1))
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelected((i) => (i + 1) % Math.max(items.length, 1))
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items.at(selected)
          if (item) command(item)
          return item !== undefined
        }
        return false
      },
    }))

    return (
      <div
        role="listbox"
        aria-label="Mention a teammate"
        className="z-50 w-64 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
      >
        {items.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-caption text-muted">No one by that name</p>
        ) : (
          items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(item)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                i === selected ? 'bg-surface-2' : ''
              }`}
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: item.colour }}
              />
              <span className="min-w-0 flex-1 truncate text-row-title text-ink">{item.label}</span>
              <span className="shrink-0 text-caption text-muted">
                {item.role === 'owner' ? 'Owner' : 'Tech'}
              </span>
            </button>
          ))
        )}
      </div>
    )
  },
)
