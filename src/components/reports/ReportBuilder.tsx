import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Lock, Save } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FieldRenderer } from './fields/FieldRenderer'
import { BoilerplateBlock } from './BoilerplateBlock'
import { DurableNoticePreview } from './DurableNoticePreview'
import { durableNoticeText, emptyAreas, getTemplate } from '#/lib/reportTemplates'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

export function ReportBuilder({
  businessId,
  reportId,
  template: templateId,
  initialData,
  property,
  businessName,
  authorLicence,
  onFinalised,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  template: TemplateId
  initialData: Record<string, unknown>
  property: { addressLine: string; suburb: string; clientName: string } | null
  businessName: string
  authorLicence?: string
  onFinalised: () => void
}) {
  const template = getTemplate(templateId)

  const [data, setData] = useState<Record<string, unknown>>(() => {
    const seeded = { ...initialData }
    // Seed area checklists so every row starts explicitly "inspected" rather
    // than undefined, which would read as an unanswered question.
    for (const field of template.fields) {
      if (seeded[field.key] !== undefined) continue

      if (field.kind === 'areas') seeded[field.key] = emptyAreas(field.rows)
      else if (field.kind === 'chips') seeded[field.key] = []
      // Seed text-ish fields to '' so an untouched required field fails its
      // own .min(1) rule and reports the message written for it, rather than
      // Zod's "expected string, received undefined".
      else if (
        field.kind === 'text' ||
        field.kind === 'area' ||
        field.kind === 'select'
      ) {
        seeded[field.key] = ''
      }
    }
    return seeded
  })

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

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
      tasks?: Array<{ kind: 'durableNotice' | 'other'; label: string; detail?: string }>
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

  function onFinaliseClick() {
    const parsed = template.schema.safeParse(data)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
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
      data,
      tasks: template.onFinalise?.(),
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

      {template.fields.map((field) => (
        <FieldRenderer
          key={field.key}
          field={field}
          value={data[field.key]}
          error={errors[field.key]}
          onChange={(value) =>
            setData((prev) => ({ ...prev, [field.key]: value }))
          }
          photoContext={{ businessId, reportId }}
        />
      ))}

      {noticeText && <DurableNoticePreview text={noticeText} />}

      <BoilerplateBlock text={template.boilerplate} />

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
          disabled={save.isPending || !hydrated}
          onClick={() => save.mutate({ businessId, reportId, data })}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-2 text-[17px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          <Save size={17} strokeWidth={1.7} />
          {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save draft'}
        </button>
        <button
          type="button"
          disabled={finalise.isPending || !hydrated}
          onClick={onFinaliseClick}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          <Lock size={17} strokeWidth={2} />
          {finalise.isPending ? 'Locking…' : 'Finalise & lock'}
        </button>
      </div>
    </div>
  )
}
