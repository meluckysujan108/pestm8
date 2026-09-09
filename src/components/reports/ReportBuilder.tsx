import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Lock, Save } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FieldRenderer } from './fields/FieldRenderer'
import { seedData } from './fields/registry'
import { applyUpdate } from './fields/leafEditors'
import { BoilerplateBlock } from './BoilerplateBlock'
import { DurableNoticePreview } from './DurableNoticePreview'
import { durableNoticeText, fieldsOf, sectionsOf } from '#/lib/reportTemplates'
import { pruneHidden, visibleSections } from '#/lib/reportTemplates/visibility'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import type { TemplateId } from '#/lib/reportTemplates'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { SaveStatus } from '#/lib/useAutosave'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'
import { useAutosave } from '#/lib/useAutosave'

/**
 * Honest about §5.5: there is no offline mutation queue, so a failed save is a
 * real risk of loss rather than something queued for later.
 */
const SAVE_LABELS: Record<SaveStatus, string> = {
  // Nothing has been written this session yet — claiming 'Saved' on open
  // would assert something untrue.
  draft: 'Save draft',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Retry save',
  submitted: 'Saved',
}

export function ReportBuilder({
  businessId,
  reportId,
  template: templateId,
  customTemplate,
  initialData,
  property,
  businessName,
  authorLicence,
  onFinalised,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  template: TemplateId | 'custom'
  customTemplate?: CustomTemplateShape | null
  initialData: Record<string, unknown>
  property: { addressLine: string; suburb: string } | null
  businessName: string
  authorLicence?: string
  onFinalised: () => void
}) {
  const template = resolveReportTemplate({ template: templateId, customTemplate })

  const [data, setData] = useState<Record<string, unknown>>(() =>
    seedData(fieldsOf(template), initialData),
  )

  const [errors, setErrors] = useState<Record<string, string>>({})

  const hydrated = useHydrated()

  const convexSave = useConvexMutation(api.reports.saveDraft)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      data: unknown
    }) => convexSave(args),
  })

  const convexFinalise = useConvexMutation(api.reports.finalise)
  const finalise = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      data: unknown
    }) => convexFinalise(args),
    onSuccess: onFinalised,
  })

  const noticeText = useMemo(() => {
    if (templateId !== 'termiteManagementCert' || !property) return null
    return durableNoticeText({
      businessName,
      licenceNumber: authorLicence,
      systemType: String(data.systemType ?? 'chemical'),
      product: String(data.product ?? '—'),
      apvmaNumber: String(data.apvmaNumber ?? '—'),
      installDate: String(data.installDate ?? '—'),
      lifeExpectancy: String(data.lifeExpectancy ?? '—'),
      reinspectionInterval: String(data.reinspectionInterval ?? '—'),
      addressLine: property.addressLine,
      suburb: property.suburb,
    })
  }, [templateId, property, businessName, authorLicence, data])

  /**
   * What actually gets validated and stored. A field the technician can no
   * longer see is a question no longer being asked, so its stale answer must
   * not reach the report — nor block finalising while being invisible.
   */
  function submittable() {
    return pruneHidden(sectionsOf(template), data)
  }

  const autosave = useAutosave({
    value: submittable(),
    // A locked report has nothing to save, and neither does one still hydrating.
    enabled: hydrated && !finalise.isSuccess,
    save: (payload) => save.mutateAsync({ businessId, reportId, data: payload }),
  })

  async function onFinaliseClick() {
    // Finalise sends its own payload, but flushing first means a failed
    // finalise still leaves the latest draft on the server.
    await autosave.flush()
    const payload = submittable()
    const parsed = template.schema.safeParse(payload)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        // Deliberately `path[0]`, not the joined path: the areas checklist
        // reports its refine failures at ['areas', '<row>'], and the message
        // belongs on the one control that owns every row.
        const key = String(issue.path[0] ?? '')
        if (key && !next[key]) next[key] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    finalise.mutate({
      businessId,
      reportId,
      data: payload,
    })
  }

  return (
    <div className="px-4 pb-[calc(120px+env(safe-area-inset-bottom))] pt-2">
      <p className="section-label">{template.legalBasis}</p>
      <h1 className="mt-1 text-page-title text-ink">{template.name}</h1>
      {property && (
        <p className="mt-1 text-body text-muted">
          {property.addressLine}, {property.suburb}
        </p>
      )}

      {visibleSections(sectionsOf(template), data).map((section) => (
        <section key={section.title}>
          {/* An implicit section is this file's own wrapper around a legacy
              flat field list, not something the template asked for — printing
              a heading for it would invent UI the builder never had. */}
          {!section.implicit && (
            <>
              <h2 className="mt-7 text-row-title text-ink">
                {section.number ? `${section.number}. ` : ''}
                {section.title}
              </h2>
              {section.preamble && (
                <p className="mt-1 text-caption text-muted">
                  {section.preamble}
                </p>
              )}
            </>
          )}

          {section.fields.map((field) => (
            <FieldRenderer
              key={field.key}
              field={field}
              value={data[field.key]}
              error={errors[field.key]}
              onChange={(next) =>
                setData((prev) => ({
                  ...prev,
                  [field.key]: applyUpdate(next, prev[field.key]),
                }))
              }
              photoContext={{ businessId, reportId }}
            />
          ))}
        </section>
      ))}

      {noticeText && <DurableNoticePreview text={noticeText} />}

      <BoilerplateBlock text={template.boilerplate} />

      {autosave.status === 'error' && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Not saved — check your connection, then tap Retry. Your answers are
          still on this device until you leave the page.
        </p>
      )}

      {finalise.isError && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Could not finalise this report. It may already be locked.
        </p>
      )}
      {Object.keys(errors).length > 0 && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Some required details are missing. Check the fields marked above.
        </p>
      )}

      <div className="chrome-blur fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-[460px] gap-2 border-t border-hairline p-3 lg:bottom-0">
        <button
          type="button"
          disabled={!hydrated || autosave.status === 'saving'}
          onClick={() => void autosave.flush()}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[17px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          <Save size={17} strokeWidth={1.7} />
          {SAVE_LABELS[autosave.status]}
        </button>
        <button
          type="button"
          disabled={finalise.isPending || !hydrated}
          onClick={() => void onFinaliseClick()}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          <Lock size={17} strokeWidth={2} />
          {finalise.isPending ? 'Locking…' : 'Finalise & lock'}
        </button>
      </div>
    </div>
  )
}
