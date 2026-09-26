import { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { customTemplateSectionsSchema } from '#/lib/reportTemplates/customTemplateSchema'
import { buildReportModel } from '#/lib/reportTemplates/documentModel'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import { isDataField, sectionsOf } from '#/lib/reportTemplates'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { SectionDef } from '#/lib/reportTemplates'
import type { TemplateDraft } from './TemplateEditor'

/**
 * What the form will actually print.
 *
 * Authoring a compliance document without seeing it is how a section ends up
 * with a heading and nothing under it, or a question that never appears
 * because the condition above it can never be true. The preview builds the
 * SAME `ReportModel` the finished document is painted from, so what an owner
 * reads here is what the client will receive — including Rule 8, which omits
 * anything that was never answered.
 *
 * It renders from the DRAFT, not the published form. That is the point: it is
 * the only way to look at an edit before issuing it.
 */
export function TemplatePreview({ draft }: { draft: TemplateDraft }) {
  const parsed = useMemo(
    () => customTemplateSectionsSchema.safeParse(draft.sections),
    [draft.sections],
  )

  // Built through the real resolver, not by hand: a preview assembled its own
  // way would be a second definition of what a custom template is, and the
  // whole point is to show what the finished document does.
  const template = useMemo(
    () =>
      parsed.success
        ? resolveReportTemplate({
            template: 'custom',
            customTemplate: {
              name: draft.name,
              shortName: draft.shortName,
              legalBasis: draft.legalBasis,
              blurb: draft.blurb,
              sections: parsed.data as Array<SectionDef>,
              boilerplate: draft.boilerplate,
            },
          })
        : null,
    [
      parsed,
      draft.name,
      draft.shortName,
      draft.legalBasis,
      draft.blurb,
      draft.boilerplate,
    ],
  )

  const model = useMemo(() => {
    if (!template) return null
    try {
      return buildReportModel({
        template,
        // Deliberately no answers. A preview filled with invented ones would
        // show a document nobody will ever receive, and hide the emptiness
        // that Rule 8 exists to handle.
        data: {},
        finalised: false,
        business: { name: 'Your business' },
        property: null,
      })
    } catch {
      return null
    }
  }, [template])

  if (!parsed.success) {
    return (
      <div className="px-4 py-6">
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5 text-caption text-amber-ink"
        >
          <TriangleAlert
            size={16}
            strokeWidth={2}
            className="mt-0.5 shrink-0"
          />
          <span>
            Nothing to preview yet — this form has a problem that has to be
            fixed first. {parsed.error.issues[0]?.message ?? ''}
          </span>
        </p>
      </div>
    )
  }

  const sections = template ? visibleSections(sectionsOf(template), {}) : []

  return (
    <div className="px-4 py-4">
      <p className="text-caption text-muted">
        The questions as a technician will meet them, in order. A draft shows
        every question; the finished document omits whatever was left blank.
      </p>

      <ol className="mt-3 flex flex-col gap-3">
        {sections.map((section, index) => {
          const asked = section.fields.filter(isDataField)
          return (
            <li
              key={section.id ?? index}
              className="rounded-2xl border border-hairline bg-surface p-3.5"
            >
              <h3 className="section-label">
                {section.number ?? index + 1}. {section.title}
              </h3>
              {section.preamble && (
                <p className="mt-1 text-caption text-muted">
                  {section.preamble}
                </p>
              )}

              {asked.length === 0 ? (
                <p className="mt-2 text-caption text-muted">
                  Asks nothing — printed content only.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1">
                  {asked.map((field) => (
                    <li key={field.key} className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-body text-ink">
                        {field.label}
                        {field.required && (
                          <span className="ml-1 text-red">*</span>
                        )}
                      </span>
                      {field.visibleWhen && (
                        <span className="shrink-0 text-caption text-muted">
                          conditional
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>

      {model && (
        <p className="mt-4 text-caption text-muted">
          Prints as {model.sections.length}{' '}
          {model.sections.length === 1 ? 'section' : 'sections'} under the title
          &ldquo;{model.identity.title}&rdquo;.
        </p>
      )}
    </div>
  )
}
