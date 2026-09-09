import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Plus, Save } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { SectionEditor } from './SectionEditor'
import { customTemplateSectionsSchema } from '#/lib/reportTemplates/customTemplateSchema'
import { useAutosave } from '#/lib/useAutosave'
import { useHydrated } from '#/lib/useHydrated'
import type { SaveStatus } from '#/lib/useAutosave'
import type { SectionDef } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

const SAVE_LABELS: Record<SaveStatus, string> = {
  draft: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Retry save',
  submitted: 'Saved',
}

export type TemplateDraft = {
  name: string
  shortName: string
  legalBasis: string
  blurb: string
  sections: Array<SectionDef>
  boilerplate: string
}

/**
 * The field-configuration editor (Phase 5) — composes the 15 existing field
 * kinds into sections; it can never introduce a sixteenth (§5.3, and this
 * plan's own scope decision). Autosaves through `customTemplates.update`
 * exactly the way `ReportBuilder` autosaves a draft report, including the
 * same honest status labels for §5.5's "no offline queue" reality.
 */
export function TemplateEditor({
  businessId,
  templateId,
  initial,
}: {
  businessId: Id<'businesses'>
  templateId: Id<'customReportTemplates'>
  initial: TemplateDraft
}) {
  const [draft, setDraft] = useState<TemplateDraft>(initial)
  const hydrated = useHydrated()

  const convexUpdate = useConvexMutation(api.customTemplates.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      templateId: Id<'customReportTemplates'>
      name: string
      shortName: string
      legalBasis: string
      blurb: string
      sections: unknown
      boilerplate: string
    }) => convexUpdate(args),
  })

  const autosave = useAutosave({
    value: draft,
    enabled: hydrated,
    save: (value) =>
      save.mutateAsync({
        businessId,
        templateId,
        name: value.name,
        shortName: value.shortName,
        legalBasis: value.legalBasis,
        blurb: value.blurb,
        sections: value.sections,
        boilerplate: value.boilerplate,
      }),
  })

  // Every field key in the template, for cross-section uniqueness checks —
  // recomputed on every render since sections change constantly here.
  function keysOutside(sectionIndex: number): Set<string> {
    const keys = new Set<string>()
    draft.sections.forEach((section, i) => {
      if (i === sectionIndex) return
      for (const field of section.fields) keys.add(field.key)
    })
    return keys
  }

  // Fields declared in every section strictly before this one — the
  // candidate pool for that section's own `visibleWhen`.
  function earlierFieldsBefore(sectionIndex: number) {
    return draft.sections
      .slice(0, sectionIndex)
      .flatMap((section) => section.fields)
      .map((f) => ({ key: f.key, label: f.label }))
  }

  const validation = customTemplateSectionsSchema.safeParse(draft.sections)

  function addSection() {
    setDraft((d) => ({
      ...d,
      sections: [...d.sections, { title: 'New section', fields: [] }],
    }))
  }
  function updateSection(index: number, next: SectionDef) {
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i === index ? next : s)),
    }))
  }
  function removeSection(index: number) {
    setDraft((d) => ({ ...d, sections: d.sections.filter((_, i) => i !== index) }))
  }
  function moveSection(index: number, direction: 'up' | 'down') {
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= draft.sections.length) return
    setDraft((d) => {
      const next = [...d.sections]
      ;[next[index], next[target]] = [next[target], next[index]]
      return { ...d, sections: next }
    })
  }

  return (
    <div className="px-4 pb-[calc(120px+env(safe-area-inset-bottom))] pt-2">
      <label className="flex flex-col gap-1.5">
        <span className="section-label">Name</span>
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Short name</span>
          <input
            value={draft.shortName}
            onChange={(e) => setDraft((d) => ({ ...d, shortName: e.target.value }))}
            className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Legal basis / tag</span>
          <input
            value={draft.legalBasis}
            onChange={(e) => setDraft((d) => ({ ...d, legalBasis: e.target.value }))}
            className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="section-label">Blurb</span>
        <input
          value={draft.blurb}
          onChange={(e) => setDraft((d) => ({ ...d, blurb: e.target.value }))}
          className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
        />
      </label>

      <p className="section-label mt-6 mb-2">Sections</p>
      <div className="flex flex-col gap-2.5">
        {draft.sections.map((section, index) => (
          <SectionEditor
            key={index}
            section={section}
            onChange={(next) => updateSection(index, next)}
            onRemove={() => removeSection(index)}
            onMove={(direction) => moveSection(index, direction)}
            isFirst={index === 0}
            isLast={index === draft.sections.length - 1}
            earlierFieldCandidates={earlierFieldsBefore(index)}
            otherKeys={keysOutside(index)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addSection}
        className="mt-2.5 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98]"
      >
        <Plus size={16} strokeWidth={2} />
        Add section
      </button>

      <label className="mt-6 flex flex-col gap-1.5">
        <span className="section-label">Standard terms (printed, not editable by whoever fills this in)</span>
        <textarea
          value={draft.boilerplate}
          onChange={(e) => setDraft((d) => ({ ...d, boilerplate: e.target.value }))}
          rows={6}
          className="w-full rounded-xl bg-surface-3 p-3 text-[14px] text-ink outline-none focus:ring-2 focus:ring-blue"
        />
      </label>

      {!validation.success && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          {validation.error.issues[0]?.message ?? 'This template has a problem.'}
        </p>
      )}

      {autosave.status === 'error' && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
        >
          Not saved — check your connection, then tap Retry.
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
      </div>
    </div>
  )
}
