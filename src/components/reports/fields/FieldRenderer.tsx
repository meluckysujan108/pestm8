import { FIELD_EDITORS } from './registry'
import type { EditorCtx, EditorProps, FieldEditor } from './registry'
import type { FieldDef } from '#/lib/reportTemplates'
import type { SuggestionSource } from '#/lib/reportTemplates/seed'

/**
 * The generic renderer §5.3 depends on: the builder knows field *kinds*, never
 * specific templates. A new document type is a new definition file.
 *
 * This component owns only the framing every field shares — caption, required
 * marker, hint, error, and the fieldset-vs-label choice. The control itself
 * comes from the registry, so this file does not grow as kinds are added.
 */
export function FieldRenderer({
  field,
  value,
  error,
  onChange,
  photoContext,
  captionHidden = false,
  suggestion,
}: {
  field: FieldDef
  value: unknown
  error?: string
  onChange: (value: unknown) => void
  photoContext: EditorCtx
  /**
   * The caption repeats the heading directly above it (the treatment grid is
   * captioned with its own section's title). Kept for screen readers, hidden
   * from sight, as the printed document does.
   */
  captionHidden?: boolean
  /**
   * Set when this answer was worked out by the app rather than given by the
   * technician. Marked on screen until they confirm it, so nothing they have
   * not seen prints under their signature.
   */
  suggestion?: SuggestionSource
}) {
  const editor = FIELD_EDITORS[field.kind] as FieldEditor
  const Control = editor.Control as React.ComponentType<EditorProps>

  const control = (
    <Control
      field={field}
      value={value}
      onChange={onChange}
      ctx={photoContext}
    />
  )

  // A printed note or a sub-heading has no caption, no required marker and no
  // fieldset — it is content, not a question. Wrapping one in the framing
  // below would show the author's editor-only name as a form label and a red
  // asterisk beside a block nobody can fill in.
  if (field.kind === 'note' || field.kind === 'heading') {
    return <div className="mt-4">{control}</div>
  }

  const caption = (
    <>
      {field.label}
      {/* `required` is on every field by construction, so this only ever asks
          whether it is set — never whether the kind has the property. */}
      {field.required && (
        <span aria-hidden className="ml-1 text-red">
          *
        </span>
      )}
    </>
  )

  return (
    <div className="mt-4">
      {editor.group ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className={captionHidden ? 'sr-only' : 'section-label mb-1.5'}>
            {caption}
          </legend>
          {control}
        </fieldset>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className={captionHidden ? 'sr-only' : 'section-label'}>
            {caption}
          </span>
          {control}
        </label>
      )}

      {suggestion && <SuggestedChip source={suggestion} />}

      {field.hint && (
        <p className="mt-1 text-caption text-muted">{field.hint}</p>
      )}
      {field.kind === 'areas' && field.note && (
        <p className="mt-1 text-caption text-muted">{field.note}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-caption text-red">
          {error}
        </p>
      )}
    </div>
  )
}

/** Where a suggested answer came from, in the technician's own terms. */
const SUGGESTION_WORDING: Record<SuggestionSource, string> = {
  forecast: 'From the forecast — check it before you finalise',
  scheduled: 'From the booking — check it before you finalise',
  lastVisit: 'From the last visit — check it before you finalise',
  history: 'From previous reports — check it before you finalise',
}

function SuggestedChip({ source }: { source: SuggestionSource }) {
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-caption text-amber-ink">
      <span className="rounded-md border border-dashed border-amber-line bg-amber-bg px-1.5 py-0.5 font-semibold">
        Suggested
      </span>
      {SUGGESTION_WORDING[source]}
    </p>
  )
}
