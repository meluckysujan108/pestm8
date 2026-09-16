import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { ArrowLeft, ArrowRight, Lock, Save } from 'lucide-react'
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
import { reportProgress, sectionByKey, sectionKey } from '#/lib/reportTemplates/progress'
import { ReportOverview } from './ReportOverview'
import type { PrefillMap } from '#/lib/reportTemplates/seed'
import type { SectionProgress } from '#/lib/reportTemplates/progress'
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
  prefill,
  section: sectionId,
  onSection,
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
  /** Answers the app worked out, and which have been confirmed. */
  prefill?: PrefillMap | null
  /** The section being filled, from the URL. Absent means the overview. */
  section?: string
  /** Moves between the overview and a section, keeping the browser's Back honest. */
  onSection: (section: string | undefined) => void
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

  /**
   * Suggestions confirmed in this session, before the server has acknowledged.
   * Held here so the chip clears the moment the technician acts rather than a
   * round trip later.
   */
  const [confirmed, setConfirmed] = useState<Array<string>>([])

  const hydrated = useHydrated()

  // Photos live outside `data`, so progress can only count them by asking.
  const { data: galleryPhotos } = useQuery({
    ...convexQuery(api.reports.galleryPhotos, { businessId, reportId }),
    enabled: hydrated,
  })

  const photoCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const photo of galleryPhotos ?? []) {
      counts[photo.fieldKey] = (counts[photo.fieldKey] ?? 0) + 1
    }
    return counts
  }, [galleryPhotos])

  const pending = useMemo(() => {
    const out: PrefillMap = {}
    for (const [key, entry] of Object.entries(prefill ?? {})) {
      if (entry.confirmedAt === undefined && !confirmed.includes(key)) out[key] = entry
    }
    return out
  }, [prefill, confirmed])

  const progress = useMemo(
    () => reportProgress(template, data, { prefill: pending, photoCounts }),
    [template, data, pending, photoCounts],
  )

  const current = sectionByKey(progress, sectionId)

  const [showBlocked, setShowBlocked] = useState(false)
  const blockedRef = useRef<HTMLDivElement>(null)

  // The list of what is missing answers a tap, so it must be where the eye
  // already is rather than below the terms at the foot of the page.
  useEffect(() => {
    if (showBlocked) blockedRef.current?.scrollIntoView({ block: 'center' })
  }, [showBlocked])

  // A section can disappear while it is open — answering one question hides
  // another's whole section. Land the technician back on the overview rather
  // than on a blank screen.
  useEffect(() => {
    if (sectionId && !current) onSection(undefined)
  }, [sectionId, current, onSection])

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

  const convexConfirm = useConvexMutation(api.reports.confirmPrefill)
  const confirmSuggestions = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; reportId: Id<'reports'>; keys: Array<string> }) =>
      convexConfirm(args),
  })

  /**
   * Confirms the suggestions on one section and moves on.
   *
   * Pressing Next IS the confirmation: the technician has just read the
   * section, so asking them to tick each guess separately would be a tax on
   * being helpful. Nothing is confirmed for a section they never opened.
   */
  function confirmKeys(keys: Array<string>) {
    if (keys.length === 0) return
    setConfirmed((prev) => [...new Set([...prev, ...keys])])
    confirmSuggestions.mutate({ businessId, reportId, keys })
  }

  const previousSection = current ? (progress.sections[current.index - 1] ?? null) : null
  const nextSection = current ? (progress.sections[current.index + 1] ?? null) : null

  function goToSection(next: SectionProgress | null | undefined) {
    if (current) confirmKeys(current.toConfirm)
    void autosave.flush()
    onSection(next ? next.id : undefined)
    // A new screen starts at its own top, not halfway down the last one.
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }


  /**
   * What is standing between this report and being locked, named rather than
   * counted: each entry says which question, in which section, and jumps there.
   */
  const blocked = useMemo(() => {
    if (!showBlocked || progress.complete) return null
    const labelOf = (key: string) =>
      fieldsOf(template).find((field) => field.key === key)?.label ?? key
    return progress.sections.flatMap((section) => [
      ...section.missing.map((key) => ({ section, key, label: labelOf(key) })),
      ...section.toConfirm.map((key) => ({
        section,
        key,
        label: `Confirm ${labelOf(key).replace(/:$/, '')}`,
      })),
    ])
  }, [showBlocked, progress, template])

  async function onFinaliseClick() {
    // Finalise sends its own payload, but flushing first means a failed
    // finalise still leaves the latest draft on the server.
    await autosave.flush()

    // Everything outstanding, in one place, before the schema's message for
    // whichever field it happens to reach first.
    if (!progress.complete) {
      setShowBlocked(true)
      return
    }
    setShowBlocked(false)

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

      {!current && (
        <ReportOverview
          progress={progress}
          onOpen={(section) => goToSection(section)}
          onFinalise={() => void onFinaliseClick()}
          disabled={finalise.isPending || !hydrated}
        />
      )}

      {/* The overview lists the sections; a section screen shows exactly one.
          Rendering every field on both would make the overview the long scroll
          this flow exists to replace. */}
      {visibleSections(sectionsOf(template), data)
        .filter((section, index) => current && sectionKey(section, index) === current.id)
        .map((section) => (
        <section key={section.title}>
          {/* An implicit section is this file's own wrapper around a legacy
              flat field list, not something the template asked for — printing
              a heading for it would invent UI the builder never had. */}
          {current && (
            <p className="mt-6 section-label">
              Section {current.index + 1} of {progress.sections.length}
            </p>
          )}
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
              suggestion={(pending as Partial<PrefillMap>)[field.key]?.source}
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

      {blocked && (
        <div
          ref={blockedRef}
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-3 text-caption text-amber-ink"
        >
          <p className="font-semibold">
            {blocked.length === 1 ? '1 thing to finish' : `${blocked.length} things to finish`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {blocked.map((item) => (
              <li key={`${item.section.id}:${item.key}`}>
                <button
                  type="button"
                  onClick={() => goToSection(item.section)}
                  className="text-left underline underline-offset-2"
                >
                  {item.label}
                  <span className="text-muted"> — {item.section.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!current && noticeText && <DurableNoticePreview text={noticeText} />}

      {!current && (
        <BoilerplateBlock
          text={template.boilerplate}
          terms={template.terms}
          heading={template.print?.termsHeading}
        />
      )}

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
      {Object.keys(errors).length > 0 && !blocked && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Some required details are missing. Check the fields marked above.
        </p>
      )}

      {/* `data-ready` is the readiness signal the e2e suite waits on: the
          footer's buttons change label per screen, so waiting on any one of
          them by name was a wait on the layout rather than on hydration. */}
      <div
        data-report-footer
        data-ready={hydrated ? 'true' : 'false'}
        className="chrome-blur fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-[460px] gap-2 border-t border-hairline p-3 lg:bottom-0"
      >
        {current ? (
          <>
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => goToSection(previousSection)}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-2 px-4 text-[17px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
            >
              <ArrowLeft size={17} strokeWidth={1.8} />
              {previousSection ? 'Back' : 'Overview'}
            </button>
            {nextSection ? (
              <button
                type="button"
                disabled={!hydrated}
                onClick={() => goToSection(nextSection)}
                className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[17px] font-semibold text-surface transition active:scale-[.975] disabled:opacity-50"
              >
                <span className="truncate">
                  Next: {nextSection.number ? `${nextSection.number}. ` : ''}
                  {nextSection.title}
                </span>
                <ArrowRight size={17} strokeWidth={1.8} className="shrink-0" />
              </button>
            ) : (
              <FinaliseButton
                disabled={finalise.isPending || !hydrated}
                pending={finalise.isPending}
                onClick={() => void onFinaliseClick()}
              />
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!hydrated || autosave.status === 'saving'}
              onClick={() => void autosave.flush()}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[17px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
            >
              <Save size={17} strokeWidth={1.7} />
              {SAVE_LABELS[autosave.status]}
            </button>
            {/* Never greyed out: a technician who believes they are finished
                must be able to press it and be told what is missing, rather
                than left guessing at a dead button. */}
            {progress.complete || !progress.firstIncomplete ? (
              <FinaliseButton
                disabled={finalise.isPending || !hydrated}
                pending={finalise.isPending}
                onClick={() => void onFinaliseClick()}
              />
            ) : (
              <button
                type="button"
                disabled={!hydrated}
                onClick={() => goToSection(progress.firstIncomplete)}
                className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[17px] font-semibold text-surface transition active:scale-[.975] disabled:opacity-50"
              >
                Continue
                <ArrowRight size={17} strokeWidth={1.8} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** The same words, whatever the case: a section title may be set in capitals. */
function sameWords(a: string, b: string) {
  const words = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  return words(a) === words(b)
}

function FinaliseButton({
  disabled,
  pending,
  onClick,
}: {
  disabled: boolean
  pending: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
    >
      <Lock size={17} strokeWidth={2} />
      {pending ? 'Locking…' : 'Finalise & lock'}
    </button>
  )
}
