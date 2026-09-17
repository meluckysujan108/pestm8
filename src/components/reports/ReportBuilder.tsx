import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Lock, Save } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FieldRenderer } from './fields/FieldRenderer'
import { seedData } from './fields/registry'
import { applyUpdate } from './fields/leafEditors'
import { BoilerplateBlock } from './BoilerplateBlock'
import { UpgradeBanner } from './UpgradeBanner'
import { DurableNoticePreview } from './DurableNoticePreview'
import {
  durableNoticeText,
  fieldsOf,
  printsDurableNotice,
  sectionsOf,
} from '#/lib/reportTemplates'
import { pruneHidden, visibleSections } from '#/lib/reportTemplates/visibility'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import { isEmptyRow } from '#/lib/reportTemplates/present'
import type { TemplateId } from '#/lib/reportTemplates'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { OptionSetOverrides } from '#/lib/reportTemplates/optionSets'
import type { PresentContext } from '#/lib/reportTemplates/present'
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
  templateVersion,
  optionSets,
  roster,
  context,
  upgrade,
  onRestarted,
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
  templateVersion?: number
  optionSets?: OptionSetOverrides | null
  /** The team a `member` field can name. */
  roster?: Array<{ id: string; name: string }>
  /** The records the form prints from. */
  context?: PresentContext | null
  /** Set when this draft was written against wording the business no longer issues. */
  upgrade?: 'switch' | 'restart' | null
  onRestarted?: (newReportId: Id<'reports'>) => void
  customTemplate?: CustomTemplateShape | null
  initialData: Record<string, unknown>
  property: { addressLine: string; suburb: string } | null
  businessName: string
  authorLicence?: string
  onFinalised: () => void
}) {
  // Memoised: with a business's own option lists applied, resolution builds a
  // new template object, and a new object every render would re-render every
  // field. Convex query results are referentially stable, so these inputs only
  // change when the data does.
  const template = useMemo(
    () =>
      resolveReportTemplate({
        template: templateId,
        templateVersion,
        customTemplate,
        optionSets,
      }),
    [templateId, templateVersion, customTemplate, optionSets],
  )

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
      templateVersion?: number
    }) => convexSave(args),
  })

  const convexFinalise = useConvexMutation(api.reports.finalise)
  const finalise = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      data: unknown
      templateVersion?: number
    }) => convexFinalise(args),
    onSuccess: onFinalised,
  })

  const noticeText = useMemo(() => {
    if (!printsDurableNotice(template) || !property) return null
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
  }, [template, property, businessName, authorLicence, data])

  /**
   * What actually gets validated and stored. A field the technician can no
   * longer see is a question no longer being asked, so its stale answer must
   * not reach the report — nor block finalising while being invisible.
   */
  function submittable() {
    const pruned = pruneHidden(sectionsOf(template), data)
    // Rows left completely empty are discarded rather than validated, as the
    // Service Report's validation notes promise: an inspection-only visit with
    // a stray "Add Row" tap still finalises, and nothing prints for it.
    for (const field of fieldsOf(template)) {
      if (field.kind !== 'repeater') continue
      const rows = pruned[field.key]
      if (Array.isArray(rows)) {
        pruned[field.key] = rows.filter(
          (row: Record<string, unknown>) => !isEmptyRow(field.columns, row),
        )
      }
    }
    return pruned
  }

  const autosave = useAutosave({
    value: submittable(),
    // A locked report has nothing to save, and neither does one still hydrating.
    enabled: hydrated && !finalise.isSuccess,
    // The revision this builder is rendering travels with every write, so a
    // server holding a newer form refuses answers shaped for an older one.
    save: (payload) =>
      save.mutateAsync({
        businessId,
        reportId,
        data: payload,
        templateVersion: template.version,
      }),
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
      templateVersion: template.version,
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

      {upgrade && (
        <UpgradeBanner
          businessId={businessId}
          reportId={reportId}
          upgrade={upgrade}
          beforeSwitch={() => autosave.flush()}
          onRestarted={(id) => onRestarted?.(id)}
        />
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

          {section.fields.map((field, index) => (
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
              captionHidden={
                // Only where the heading really is directly above: a rendered
                // heading, nothing between it and the grid, and no required
                // marker that would vanish with the caption.
                field.kind === 'repeater' &&
                !section.implicit &&
                !section.preamble &&
                index === 0 &&
                !field.required &&
                sameWords(field.label, section.title)
              }
              photoContext={{
                businessId,
                reportId,
                roster,
                // Live answers, so a licence row follows the technician picked
                // a moment ago rather than the one last saved.
                context: context ? { ...context, answers: data } : undefined,
              }}
            />
          ))}
        </section>
      ))}

      {noticeText && <DurableNoticePreview text={noticeText} />}

      <BoilerplateBlock
        text={template.boilerplate}
        terms={template.terms}
        heading={template.print?.termsHeading}
      />

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
          {finaliseError(finalise.error)}
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

/** The same words, whatever the case: a section title may be set in capitals. */
function sameWords(a: string, b: string) {
  const words = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  return words(a) === words(b)
}

/**
 * Why a finalise was refused, in terms of what the person can do about it.
 *
 * This used to say "it may already be locked" for every failure, which was a
 * guess — and once the licence rules landed it became the wrong guess most of
 * the time. A technician standing in a roof cavity was told the report was
 * locked, went looking for a lock that does not exist, and rang the owner.
 *
 * The licence cases name the fix, because the fix is not something they can do
 * from this screen and they need to know who to ask.
 */
function finaliseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('HOLDER_LICENCE_MISSING')) {
    return 'This report needs a licence number on the account it belongs to. Ask the owner to add it in Settings → Team, then finalise again.'
  }
  if (message.includes('HOLDER_LICENCE_EXPIRED')) {
    return 'The licence on this account has expired. Ask the owner to update it in Settings → Team, then finalise again.'
  }
  if (message.includes('TECHNICIAN_LICENCE_MISSING')) {
    return 'The technician named on this report has no licence number on file. Ask the owner to add it in Settings → Team.'
  }
  if (message.includes('TECHNICIAN_LICENCE_EXPIRED')) {
    return 'The technician named on this report has an expired licence. Ask the owner to update it in Settings → Team.'
  }
  if (message.includes('SWITCHED_REGULATED')) {
    return 'This is a regulated document, so it has to be finalised by the licence holder themselves. Switch back to your own account and ask them to sign it.'
  }
  if (message.includes('REPORT_FINALISED')) {
    return 'This report has already been finalised.'
  }
  if (message.includes('TEMPLATE_VERSION_MISMATCH')) {
    return 'This form has been updated since you opened it. Reload the page and check your answers before finalising.'
  }
  if (message.includes('NO_ACCESS') || message.includes('NOT_EDITABLE')) {
    return 'This report belongs to someone else, so you cannot finalise it.'
  }
  return 'Could not finalise this report. Your answers are still saved — try again in a moment.'
}
