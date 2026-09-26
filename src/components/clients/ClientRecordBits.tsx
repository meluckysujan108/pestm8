import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { FIELD_COMPACT } from '#/components/forms/FormField'
import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  STATUS_LABELS,
  tagsFromText,
} from '../../../convex/lib/clientRecord'
import type { ClientStatus } from '../../../convex/lib/clientRecord'

/**
 * A client's number, status and tags as the Clients page and sheet show
 * them. Active is the usual case, so it says nothing; a lead or an inactive
 * client says so.
 */

const STATUS_STYLE: Record<ClientStatus, string> = {
  active: 'bg-surface-2 text-ink-2',
  lead: 'bg-blue/12 text-blue',
  inactive: 'bg-surface-2 text-muted',
}

export function ClientStatusPill({ status }: { status?: ClientStatus }) {
  if (!status || status === 'active') return null
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

export function clientNumberLabel(clientNumber?: number): string | null {
  return clientNumber === undefined ? null : `#${clientNumber}`
}

export function TagChips({
  tags,
  max,
}: {
  tags?: Array<string>
  /** Show this many, then "+N". */
  max?: number
}) {
  if (!tags || tags.length === 0) return null
  const shown = max === undefined ? tags : tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((tag) => (
        <span
          key={tag}
          className="inline-flex max-w-full items-center truncate rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-ink-2"
        >
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span className="inline-flex items-center px-1 text-[12px] font-medium text-muted">
          +{rest}
        </span>
      )}
    </span>
  )
}

/** Adds `text`'s tags (one, or several split by commas) to `tags`, once each
 * whatever their capitals, cut to the length and number the server keeps. */
export function addTags(tags: Array<string>, text: string): Array<string> {
  const out = [...tags]
  for (const raw of tagsFromText(text)) {
    const tag = raw.slice(0, MAX_TAG_LENGTH).trim()
    if (!tag || out.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      continue
    }
    if (out.length >= MAX_TAGS) break
    out.push(tag)
  }
  return out
}

/**
 * Tags as chips with a box to add more: Enter or a comma adds what is
 * typed, a chip's × takes it off. The business's other tags are offered as
 * the box is typed in, so "Real estate" isn't also "Real-estate".
 */
export function TagInput({
  value,
  onChange,
  suggestions,
  label,
}: {
  value: Array<string>
  onChange: (tags: Array<string>) => void
  suggestions: Array<string>
  label: string
}) {
  const [text, setText] = useState('')
  const listId = useId()
  const offered = suggestions.filter(
    (s) => !value.some((t) => t.toLowerCase() === s.toLowerCase()),
  )
  const commit = () => {
    if (!text.trim()) return
    onChange(addTags(value, text))
    setText('')
  }
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-hairline bg-surface-2 py-1 pr-1 pl-2.5 text-caption font-medium text-ink-2"
            >
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => onChange(value.filter((t) => t !== tag))}
                className="relative tap-target flex size-5 items-center justify-center rounded-full text-muted"
              >
                <X size={13} strokeWidth={2.2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < MAX_TAGS && (
        <input
          type="text"
          value={text}
          list={listId}
          aria-label={`Add a tag (${label})`}
          placeholder="Add a tag — e.g. Real estate"
          maxLength={MAX_TAG_LENGTH * 4}
          onChange={(e) => {
            const next = e.target.value
            // A comma ends a tag, as a picked suggestion does.
            if (next.includes(',')) {
              onChange(addTags(value, next))
              setText('')
            } else {
              setText(next)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Backspace' && text === '' && value.length) {
              onChange(value.slice(0, -1))
            }
          }}
          onBlur={commit}
          className={`${FIELD_COMPACT} w-full`}
        />
      )}
      <datalist id={listId}>
        {offered.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  )
}

/** Every tag a business's clients carry, the most used first. */
export function tagsInUse(
  clients: ReadonlyArray<{ tags?: Array<string> }>,
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const client of clients) {
    for (const tag of client.tags ?? []) {
      const key = tag.toLowerCase()
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { tag, count: 1 })
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
  )
}
