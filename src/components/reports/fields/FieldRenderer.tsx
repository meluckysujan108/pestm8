import { FIELD_EDITORS } from './registry'
import type { EditorCtx, EditorProps, FieldEditor } from './registry'
import type { FieldDef } from '#/lib/reportTemplates'

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
