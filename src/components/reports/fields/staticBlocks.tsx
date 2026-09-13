import { useState } from 'react'
import { Lock } from 'lucide-react'
import { RichTextView } from '../RichText'
import { present } from '#/lib/reportTemplates/present'
import type { EditorProps } from './leafEditors'
import type { FieldDef } from '#/lib/reportTemplates'

/**
 * Controls for the kinds that print without asking — and the two that ask for
 * something the rest of the app already knows.
 *
 * `note`, `heading` and `derived` are read-only by construction: they hold
 * nothing in `data`, so their `onChange` is never called and their `value` is
 * always undefined. They live in the registry anyway because `FIELD_EDITORS`
 * is what stops a kind from rendering as nothing at all, and "renders as
 * nothing" is precisely the failure a printed warranty clause cannot afford.
 */

type Of<TKind extends FieldDef['kind']> = EditorProps<
  Extract<FieldDef, { kind: TKind }>
>

const TONE_CLASS = {
  note: 'border-hairline bg-surface-2',
  important: 'border-red/30 bg-red/5',
  warning: 'border-amber/30 bg-amber/5',
  statement: 'border-hairline bg-surface-2 italic',
} as const

export function NoteBlock({ field }: Of<'note'>) {
  const tone = field.tone ?? 'note'
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${TONE_CLASS[tone]}`}>
      {field.heading && (
        <p className="text-subhead font-semibold text-ink">
          {tone === 'important' ? `IMPORTANT: ${field.heading}` : field.heading}
        </p>
      )}
      <RichTextView doc={field.body} className="text-body text-ink-2" />
    </div>
  )
}

export function HeadingBlock({ field }: Of<'heading'>) {
  return (
    <div className="mt-2">
      <h3 className="text-body font-semibold text-ink">{field.text}</h3>
      {field.note && (
        <p className="mt-0.5 text-caption text-muted">{field.note}</p>
      )}
    </div>
  )
}

/**
 * A fact the document prints from a record. Shown the way iOS shows a setting
 * it will not let you change: the value, and a lock saying why there is no
 * control — not a disabled input, which reads as a control that is broken.
 *
 * The resolved value arrives with the section context in a later phase; until
 * then the row names its source so the row is never silently empty.
 */
export function DerivedRow({ field, ctx }: Of<'derived'>) {
  const shown = present(field, undefined, ctx.context)
  const text =
    shown.kind === 'text'
      ? shown.text
      : shown.kind === 'lines'
        ? shown.lines.join(', ')
        : null
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface-3 px-3.5 py-3">
      <Lock aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className={`text-body ${text ? 'text-ink' : 'text-muted'}`}>
        {/* Nothing on file yet: say where it will come from, so the row is never
            silently empty and the fix (update the record) is obvious. */}
        {text ?? `Not on the ${sourceWord(field.source)} record yet`}
      </span>
    </div>
  )
}

function sourceWord(source: string): string {
  const group = source.split('.')[0]
  return group === 'job' ? 'job' : group
}

export function MemberControl({ field, value, onChange, ctx }: Of<'member'>) {
  const roster = ctx.roster ?? []
  if (roster.length === 0) {
    return (
      <span className="text-body text-muted">
        No team members to choose from yet.
      </span>
    )
  }
  return (
    <span className="flex flex-col gap-1.5">
      {roster.map((member) => (
        <label
          key={member.id}
          className="flex items-center gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2.5"
        >
          <input
            type="radio"
            name={field.key}
            value={member.id}
            checked={value === member.id}
            onChange={() => onChange(member.id)}
            className="size-4 accent-red"
          />
          <span className="text-body text-ink">{member.name}</span>
        </label>
      ))}
    </span>
  )
}

/**
 * Extra recipients, stored as a list so the printed line and the addresses the
 * document is actually sent to cannot disagree. Split on commas and newlines
 * because both are what people type.
 */
export function EmailsControl({ field, value, onChange }: Of<'emails'>) {
  const list = Array.isArray(value) ? (value as Array<string>) : []
  // What the technician has typed, kept as typed. Re-rendering from the parsed
  // list on every keystroke would swallow a trailing comma — the one character
  // needed to start a second address.
  const [draft, setDraft] = useState(list.join(', '))
  const parsed = (text: string) =>
    text
      .split(/[,;\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  return (
    <input
      type="text"
      inputMode="email"
      autoComplete="email"
      value={draft}
      placeholder={field.placeholder ?? 'name@example.com'}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange(parsed(e.target.value))
      }}
      onBlur={() => setDraft(parsed(draft).join(', '))}
      className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
    />
  )
}
