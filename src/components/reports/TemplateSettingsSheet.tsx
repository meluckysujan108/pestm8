import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Check } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import { fieldsOf, getTemplate } from '#/lib/reportTemplates'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'
import { NEUTRAL_BUTTON } from '#/components/primitives/buttons'
import { FIELD_COMPACT } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * What a business may change about a form it did not write.
 *
 * Deliberately three things. The Pest M8 forms are reproduced word for word
 * and stay that way — their wording is the contract, and a correction to it
 * should reach every business that issues them. Changing what the cover says
 * or who has to sign used to mean cloning the whole template, which forks
 * the wording too and cuts the business off from every later fix.
 *
 * Anything structural is still a clone, and the sheet says so rather than
 * letting an owner hunt for a setting that is not here.
 */
export function TemplateSettingsSheet({
  open,
  onClose,
  businessId,
  templateId,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  templateId: TemplateId
}) {
  const template = getTemplate(templateId)
  const { data: saved } = useQuery(
    convexQuery(api.templateSettings.get, {
      businessId,
      templateRef: templateId,
    }),
  )

  const signers = fieldsOf(template).filter(
    (field): field is Extract<typeof field, { kind: 'signature' }> =>
      field.kind === 'signature',
  )

  // Held once the query lands, so typing is not fighting a re-render from the
  // server's copy of what was just typed.
  const [draft, setDraft] = useState<{
    coverTitle: string
    coverSubtitle: string
    formName: string
    requiredSigners: Array<string>
  } | null>(null)

  const current = draft ?? {
    coverTitle: saved?.print?.cover?.title ?? '',
    coverSubtitle: saved?.print?.cover?.subtitle ?? '',
    formName: saved?.print?.formName ?? '',
    requiredSigners:
      saved?.requiredSigners ??
      signers.filter((field) => field.required).map((field) => field.slot),
  }

  const convexSet = useConvexMutation(api.templateSettings.set)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      templateRef: string
      coverTitle?: string
      coverSubtitle?: string
      formName?: string
      requiredSigners?: Array<string>
    }) => convexSet(args),
    onSuccess: () => {
      setDraft(null)
      onClose()
    },
  })

  function update(patch: Partial<typeof current>) {
    setDraft({ ...current, ...patch })
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        setDraft(null)
        save.reset()
        onClose()
      }}
      title={`${template.name} settings`}
      description="The form's questions and wording stay as they are. These are the parts that are yours."
      footer={
        <div className="flex flex-col gap-2">
          <FormAlert
            error={save.isError ? save.error : null}
            copy={{
              default:
                'Could not save these settings. Check your signal and try again.',
            }}
          />
          <button
            type="button"
            disabled={save.isPending || saved === undefined}
            onClick={() =>
              save.mutate({
                businessId,
                templateRef: templateId,
                coverTitle: current.coverTitle,
                coverSubtitle: current.coverSubtitle,
                formName: current.formName,
                requiredSigners: current.requiredSigners,
              })
            }
            className={`${NEUTRAL_BUTTON} w-full`}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      {template.print?.cover && (
        <>
          <p className="section-label">On the cover</p>
          <div className="mt-1.5 flex flex-col gap-2">
            <Field
              label="Title"
              placeholder={template.print.cover.title}
              value={current.coverTitle}
              onChange={(value) => update({ coverTitle: value })}
            />
            <Field
              label="Subtitle"
              placeholder={template.print.cover.subtitle ?? ''}
              value={current.coverSubtitle}
              onChange={(value) => update({ coverSubtitle: value })}
            />
          </div>
        </>
      )}

      {template.print && (
        <>
          <p className="section-label mt-4">In the footer and the title band</p>
          <div className="mt-1.5">
            <Field
              label="What this form is called"
              placeholder={template.print.formName}
              value={current.formName}
              onChange={(value) => update({ formName: value })}
            />
          </div>
        </>
      )}

      {signers.length > 0 && (
        <>
          <p className="section-label mt-4">
            Must sign before it can be locked
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {signers.map((field) => {
              const on = current.requiredSigners.includes(field.slot)
              return (
                <li key={field.slot}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      update({
                        requiredSigners: on
                          ? current.requiredSigners.filter(
                              (slot) => slot !== field.slot,
                            )
                          : [...current.requiredSigners, field.slot],
                      })
                    }
                    className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left ${
                      on
                        ? 'border-ink/15 bg-surface'
                        : 'border-hairline bg-surface-2'
                    }`}
                  >
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md ${
                        on ? 'bg-ink text-surface' : 'bg-surface-3'
                      }`}
                    >
                      {on && <Check size={13} strokeWidth={2.2} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {field.label.replace(/:$/, '')}
                    </span>
                    {/* The forms label both pads "Signature" and
                        "Technician's Signature", so on their own the two rows
                        read almost the same. The role is the difference. */}
                    <span className="shrink-0 text-caption text-muted">
                      {field.role === 'client' ? 'client' : 'technician'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {/* The honest version of "owner-relaxable": turning one off is a
              real decision about evidence, not a preference. */}
          <p className="mt-1.5 text-caption text-muted">
            A report cannot be locked until every pad ticked here holds a
            signature. Turning one off does not remove the pad — it stops the
            app insisting on it.
          </p>
        </>
      )}

      <p className="mt-4 text-caption text-muted">
        Changing a question, an answer list or the printed wording is a
        different thing: clone this form first, and your copy stops receiving
        corrections to the original.
      </p>
    </Sheet>
  )
}

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string
  /** The form's own words, shown greyed — clearing the box goes back to them. */
  placeholder: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-muted">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${FIELD_COMPACT} w-full`}
      />
    </label>
  )
}
