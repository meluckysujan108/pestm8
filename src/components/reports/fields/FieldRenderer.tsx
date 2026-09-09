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
}: {
  field: FieldDef
  value: unknown
  error?: string
  onChange: (value: unknown) => void
  photoContext: EditorCtx
}) {
  const editor = FIELD_EDITORS[field.kind] as FieldEditor
  const Control = editor.Control as React.ComponentType<EditorProps>

  const caption = (
    <>
      {field.label}
      {'required' in field && field.required && (
        <span aria-hidden className="ml-1 text-red">
          *
        </span>
      )}
    </>
  )

  const control = (
    <Control
      field={field}
      value={value}
      onChange={onChange}
      ctx={photoContext}
    />
  )

  return (
    <div className="mt-4">
      {editor.group ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="section-label mb-1.5">{caption}</legend>
          {control}
        </fieldset>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="section-label">{caption}</span>
          {control}
        </label>
      )}

      {'hint' in field && field.hint && (
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
