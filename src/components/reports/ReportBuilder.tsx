import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { ArrowLeft, ArrowRight, CheckCheck, Lock, Save } from 'lucide-react'
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
import { visibleSections } from '#/lib/reportTemplates/visibility'
import {
  submittablePayload,
  validateReport,
} from '#/lib/reportTemplates/validate'
import { resolveReportTemplate } from '#/lib/reportTemplates/resolve'
import {
  reportProgress,
  sectionByKey,
  sectionKey,
} from '#/lib/reportTemplates/progress'
import { quickAnswersFor } from '#/lib/reportTemplates/quickAnswers'
import type { LicenceFix } from './LicenceNotice'
import type { QuickMode } from '#/lib/reportTemplates/quickAnswers'
import { ReportOverview, SectionNav } from './ReportOverview'
import { FinaliseSheet } from './FinaliseSheet'
import { DraftPreviewViewer } from './DraftPreviewViewer'
import { prefetchViewer } from '#/components/pdf/host/viewerChunk'
import { documentIdentity } from '#/lib/reportTemplates/documentModel'
import type { PrefillMap } from '#/lib/reportTemplates/seed'
import type { SectionProgress } from '#/lib/reportTemplates/progress'
import type { ReportIssue } from '#/lib/reportTemplates/validate'
import type { FieldDef, OptionSetKey, TemplateId } from '#/lib/reportTemplates'
import type { CustomTemplateShape } from '#/lib/reportTemplates/resolve'
import type { OptionSetOverrides } from '#/lib/reportTemplates/optionSets'
import type { TemplateSettings } from '#/lib/reportTemplates/settings'
import type { PresentContext } from '#/lib/reportTemplates/present'
import type { SaveStatus } from '#/lib/useAutosave'
import type { Id } from '../../../convex/_generated/dataModel'
import type { Snippet } from '#/lib/reportTemplates/snippets'
import { useHydrated } from '#/lib/useHydrated'
import { useKeyboardInset } from '#/lib/useKeyboardInset'
import { useAutosave } from '#/lib/useAutosave'
import { forgetDraft, recallDraft, rememberDraft } from '#/lib/draftMirror'
import { draftToSend } from '#/lib/draftSync'
import type { MirroredDraft } from '#/lib/draftMirror'
import { Sheet } from '#/components/primitives/Sheet'
import {
  NEUTRAL_BUTTON,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { formatJobDate, formatTime, todayKey } from '#/lib/format'
import { deviceTimezone } from '#/lib/useBusinessTimezone'
import { dayKeyOf } from '../../../convex/lib/dates'
import { FormAlert } from '#/components/forms/FormAlert'
import { ABOVE_DOCK } from '#/components/shell/dock'

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
  settings,
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
  licenceFix,
  onFinalised,
  isCorrection = false,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  template: TemplateId | 'custom'
  templateVersion?: number
  optionSets?: OptionSetOverrides | null
  /** The business's own cover wording and signing rule for this form. */
  settings?: TemplateSettings | null
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
  /** Who can add the author's missing licence number, when one is missing
   * and this form needs it (LicenceNotice) — so a refusal names that fix. */
  licenceFix?: LicenceFix | null
  onFinalised: () => void
  /** A correction of a finalised report (`supersedesReportId`), which changes
   * how to get unstuck when it cannot be finalised. */
  isCorrection?: boolean
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
        settings,
      }),
    [templateId, templateVersion, customTemplate, optionSets, settings],
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
  const keyboardInset = useKeyboardInset()

  // Photos live outside `data`, so progress can only count them by asking.
  const { data: galleryPhotos } = useQuery({
    ...convexQuery(api.reports.galleryPhotos, { businessId, reportId }),
    enabled: hydrated,
  })

  /**
   * What this business and this member reach for, by list — the "Usually"
   * group at the top of every picker. Absent while the query is out, which a
   * picker reads as no preference and renders as the form's own order; it is
   * a nicety, and one that must never delay a control opening.
   */
  const { data: usual } = useQuery({
    ...convexQuery(api.optionSets.usual, { businessId }),
    enabled: hydrated,
  })
  /**
   * The wording this business reuses in the long-answer boxes. One query for
   * the whole form — a business keeps a couple of dozen across twenty-eight
   * boxes — grouped here so a control asks a map rather than the server.
   */
  const { data: snippets } = useQuery({
    ...convexQuery(api.snippets.list, { businessId }),
    enabled: hydrated,
  })
  const convexSaveSnippet = useConvexMutation(api.snippets.save)
  const convexUsedSnippet = useConvexMutation(api.snippets.used)
  const convexRemoveSnippet = useConvexMutation(api.snippets.remove)
  const phrases = useMemo(() => {
    // `undefined` while the query is out, never an empty map. This codebase
    // has been bitten three times by a loading state read as a definite
    // answer; here it would put "Save as a phrase" under a box that has
    // twelve, and open a sheet saying "No phrases yet" over them.
    if (snippets === undefined) return undefined

    const byField = new Map<string, Array<Snippet>>()
    for (const row of snippets) {
      byField.set(row.fieldKey, [...(byField.get(row.fieldKey) ?? []), row])
    }
    return {
      forField: (fieldKey: string) => byField.get(fieldKey) ?? [],
      // Not swallowed: a refusal here is something the technician did — too
      // long, or the business is full — and a tap that does nothing at all is
      // the worst way to say so.
      save: (fieldKey: string, text: string) =>
        convexSaveSnippet({ businessId, fieldKey, text }),
      // This one IS fire and forget: it orders a list, and a report is not the
      // place to surface a failed tally.
      used: (id: string) =>
        void convexUsedSnippet({
          businessId,
          snippetId: id as Id<'reportSnippets'>,
        }).catch(() => {}),
      remove: (id: string) =>
        convexRemoveSnippet({
          businessId,
          snippetId: id as Id<'reportSnippets'>,
        }),
    }
  }, [
    snippets,
    businessId,
    convexSaveSnippet,
    convexUsedSnippet,
    convexRemoveSnippet,
  ])

  const convexRemember = useConvexMutation(api.optionSets.remember)
  const remember = useCallback(
    (key: OptionSetKey, values: Array<string>) => {
      // Fire and forget, and swallow: this is the app noticing a habit, and a
      // failed note about a habit is not something to interrupt a report for.
      void convexRemember({ businessId, key, values }).catch(() => {})
    },
    [convexRemember, businessId],
  )

  // A signature is an image in storage, not a timestamp in `data`, so whether
  // one exists is a separate question — and the one the server asks too.
  const { data: signatures } = useQuery({
    ...convexQuery(api.reports.signatureUrls, { businessId, reportId }),
    enabled: hydrated,
  })
  // `undefined` while the query is out, never `[]`: an empty list is the claim
  // that nothing is signed, and making that claim early is how a technician
  // gets told their signature is missing while it is on the screen behind the
  // message.
  const signedSlots = useMemo(
    () => (signatures ? Object.keys(signatures) : undefined),
    [signatures],
  )

  const photoCounts = useMemo(() => {
    if (!galleryPhotos) return undefined
    const counts: Record<string, number> = {}
    for (const photo of galleryPhotos) {
      counts[photo.fieldKey] = (counts[photo.fieldKey] ?? 0) + 1
    }
    return counts
  }, [galleryPhotos])

  /**
   * Whether the page can answer for what this report holds.
   *
   * Hydration is not enough. Signatures and photos live outside `data` and
   * arrive a moment later, and a completeness check run before they land reads
   * "not loaded yet" as "not there" — which is the page telling a technician
   * to do again what they have already done. So the lock waits for them, the
   * same way it waits for hydration.
   */
  const ready =
    hydrated && signatures !== undefined && galleryPhotos !== undefined

  const pending = useMemo(() => {
    const out: PrefillMap = {}
    for (const [key, entry] of Object.entries(prefill ?? {})) {
      if (entry.confirmedAt === undefined && !confirmed.includes(key))
        out[key] = entry
    }
    return out
  }, [prefill, confirmed])

  const progress = useMemo(
    () => reportProgress(template, data, { prefill: pending, photoCounts }),
    [template, data, pending, photoCounts],
  )

  const current = sectionByKey(progress, sectionId)

  /**
   * Open once the report passes validation and before it is locked. Kept as
   * its own state rather than "are there no issues", so the sheet appears only
   * when the technician asked for it.
   */
  const [confirming, setConfirming] = useState(false)

  const [issues, setIssues] = useState<Array<ReportIssue>>([])
  const blockedRef = useRef<HTMLDivElement>(null)

  // The list of what is missing answers a tap, so it must be where the eye
  // already is rather than below the terms at the foot of the page.
  useEffect(() => {
    if (issues.length > 0)
      blockedRef.current?.scrollIntoView({ block: 'center' })
  }, [issues])

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
      base?: unknown
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
    // The server validates too. When it refuses, it says which questions —
    // show those rather than "something went wrong", which is what a stale tab
    // would otherwise report about a form that looked finished on screen.
    onError: (error: unknown) => {
      // Whatever went wrong is explained on the page behind the sheet, so the
      // sheet has to get out of the way to let it be read.
      setConfirming(false)
      const refused = incompleteIssues(error)
      if (refused) {
        setIssues(refused)
        setErrors(
          Object.fromEntries(
            refused.map((issue) => [issue.key, issue.message]),
          ),
        )
      }
    },
  })

  // A licence added since the refusal (LicenceNotice, above) answers it: the
  // refusal goes with it, rather than staying on screen with advice that no
  // longer fits — finalising again is all that is left.
  const resetFinalise = finalise.reset
  const licenceWhenRefused = useRef(authorLicence)
  useEffect(() => {
    if (licenceWhenRefused.current === authorLicence) return
    licenceWhenRefused.current = authorLicence
    resetFinalise()
  }, [authorLicence, resetFinalise])

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
   * What actually gets validated and stored — the same payload the server
   * validates, built by the same function, so the two can never disagree about
   * what this report says.
   */
  function submittable() {
    return submittablePayload(template, data)
  }

  /**
   * Answers this device holds that the server never acknowledged.
   *
   * Looked for once, on mount, and only while this is still a draft. What is
   * found is not applied on its own: a technician who has since filled the
   * form in on another phone should not have it silently overwritten by a tab
   * that died last Tuesday.
   */
  const [stranded, setStranded] = useState<MirroredDraft | null>(null)
  useEffect(() => {
    if (!hydrated) return
    let live = true
    void recallDraft(reportId).then((found) => {
      if (live && found) setStranded(found)
    })
    return () => {
      live = false
    }
  }, [hydrated, reportId])

  /**
   * The answers as this editor last knew the server to hold them: exactly what
   * it opened with (`initialData` is the stored draft), then whatever it last
   * sent.
   *
   * Sent with every save as `base`, which turns the server's wholesale replace
   * into a merge per answer (`mergeDraft`). A draft can have two editors — its
   * writer, and someone working in their account or the owner — and this
   * builder never re-reads the answers once open. Replacing wholesale, a phone
   * left open on the draft since the morning would put back every answer
   * someone else has changed since, the moment its holder typed one letter.
   * Merged, it writes only what was changed here.
   *
   * It must be the SERVER's copy, not the padded form. Seeded from the form,
   * every placeholder `seedData` adds ('' for text, today's date, areas marked
   * inspected) read to the server as a change on its side — `undefined` is not
   * `''` — so the first answer typed into any new report was refused as a clash
   * with nobody, and never saved. `draftToSend` keeps those placeholders out
   * of what is sent instead, using `seededRef` to know them.
   */
  const baseRef = useRef<Record<string, unknown>>(initialData)
  /** What the form padded the draft with when it opened. */
  const seededRef = useRef<Record<string, unknown> | null>(null)
  if (seededRef.current === null) seededRef.current = submittable()
  /** The same answer changed here and by someone else — the one clash a merge
   * cannot settle, and a person has to. */
  const [clashed, setClashed] = useState(false)

  const autosave = useAutosave({
    value: submittable(),
    // A locked report has nothing to save, and neither does one still hydrating.
    enabled: hydrated && !finalise.isSuccess,
    // The revision this builder is rendering travels with every write, so a
    // server holding a newer form refuses answers shaped for an older one.
    save: async (payload) => {
      const sent = draftToSend(
        payload,
        seededRef.current ?? {},
        baseRef.current,
      )
      try {
        await save.mutateAsync({
          businessId,
          reportId,
          data: sent,
          base: baseRef.current,
          templateVersion: template.version,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('DRAFT_CONFLICT')) setClashed(true)
        throw error
      }
      // What the server holds now, for every answer this editor has seen: the
      // merge wrote exactly `sent` over the keys it covers, and removed the
      // ones `base` had that `sent` no longer does.
      baseRef.current = sent
      setClashed(false)
    },
    // §5.5: there is still no offline mutation queue. This is a copy of the
    // answers on the device that typed them, so a tab iOS kills mid-save is
    // recoverable — not a sync.
    mirror: {
      remember: (payload) => void rememberDraft(reportId, payload),
      forget: () => void forgetDraft(reportId),
    },
  })

  /**
   * The last time this business finished this form at this address, when
   * there is something in it still worth offering. The query answers `null`
   * for anything but a draft, and `null` both while it is out and when there
   * is nothing — this is an offer, and an offer that is not there yet is
   * simply not made.
   */
  const { data: lastVisit } = useQuery({
    ...convexQuery(api.reports.lastAtProperty, { businessId, reportId }),
    // Only while the overview is showing, which is the only screen that can
    // display the offer. This query reads the draft, so it re-runs on every
    // autosave; left subscribed through a twenty-minute fill it would re-read
    // the site's whole report history several hundred times to answer a
    // question nobody is looking at.
    enabled: hydrated && !current,
  })
  const justCopied = useRef(false)
  useEffect(() => {
    if (!justCopied.current) return
    justCopied.current = false
    void autosave.flush()
  }, [data, autosave])

  const convexCopyLast = useConvexMutation(api.reports.copyFromLastVisit)
  const copyLast = useMutation({
    mutationFn: (fromReportId: Id<'reports'>) =>
      convexCopyLast({ businessId, reportId, fromReportId }),
    onSuccess: (result: { copied: number; data: Record<string, unknown> }) => {
      // Merged into the answers this builder holds, not just left on the
      // server: `saveDraft` replaces `data` wholesale, so the next autosave
      // would otherwise write the copy straight back out again.
      if (result.copied === 0) return
      setData((prev) => ({ ...prev, ...result.data }))
      // Saved at once rather than on the next debounce. Copying is a
      // deliberate bulk change, and the very next thing a technician does is
      // open a section to look at it — which would otherwise leave the answers
      // stranded on the device and greet them with a restore prompt. Deferred
      // to the render that carries them, because a flush in this callback
      // would still be looking at the answers as they were a moment ago.
      justCopied.current = true
    },
  })

  /**
   * The draft's watermarked preview, open in the app's own viewer
   * (`DraftPreviewViewer`), or null. A number per opening, so a second look
   * after an edit is drawn afresh rather than shown from the first.
   *
   * Local state, not the address: a preview belongs to this sitting of the
   * finalise sheet — it opens from the sheet and goes back to it — and a
   * refresh or a shared link has no sheet to go back to.
   */
  const [previewing, setPreviewing] = useState<number | null>(null)
  const previews = useRef(0)
  /** Why the last preview could not be drawn, said on the sheet it came from. */
  const [previewTrouble, setPreviewTrouble] = useState<string | null>(null)

  // The sheet and the viewer are never open together: both are modal, and
  // two focus traps stacked is one too many (the Products page does the
  // same). Closing the preview puts the sheet back as it was — the report
  // passed validation a moment ago, and asking again would only be slower.
  function openPreview() {
    setConfirming(false)
    setPreviewTrouble(null)
    previews.current += 1
    setPreviewing(previews.current)
  }
  function closePreview() {
    setPreviewing(null)
    setConfirming(true)
  }
  // A refusal comes back to the sheet rather than staying in the viewer,
  // whose error screen blames the signal for everything: "this report has
  // just been locked" read as "check your signal", with a Try again that
  // failed the same way every time.
  function previewRefused(words: string) {
    closePreview()
    setPreviewTrouble(words)
  }

  // The viewer's code, fetched while the sheet that offers the preview is up.
  useEffect(() => {
    if (confirming) prefetchViewer()
  }, [confirming])

  const identity = documentIdentity({ template, property, businessName })

  const convexConfirm = useConvexMutation(api.reports.confirmPrefill)
  const confirmSuggestions = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      keys: Array<string>
    }) => convexConfirm(args),
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

  const previousSection = current
    ? (progress.sections[current.index - 1] ?? null)
    : null
  const nextSection = current
    ? (progress.sections[current.index + 1] ?? null)
    : null

  function goToSection(next: SectionProgress | null | undefined) {
    if (current) confirmKeys(current.toConfirm)
    void autosave.flush()
    onSection(next ? next.id : undefined)
    // A new screen starts at its own top, not halfway down the last one.
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }

  /**
   * What is standing between this report and being locked, named rather than
   * counted: each entry says what is wrong, which section asks it, and jumps
   * there. Built from the validator's own issues, so it says exactly what the
   * server would say.
   */
  const blocked = useMemo(() => {
    if (issues.length === 0) return null
    const sectionOf = (key: string) =>
      progress.sections.find(
        (section) =>
          section.missing.includes(key) || section.toConfirm.includes(key),
      ) ??
      progress.sections.find((section) =>
        sectionsOf(template)
          .find((candidate) => candidate.title === section.title)
          ?.fields.some((field) => field.key === key),
      ) ??
      null
    return issues.map((issue) => ({ ...issue, section: sectionOf(issue.key) }))
  }, [issues, progress, template])

  async function onFinaliseClick() {
    // Pressing Finalise from a section screen confirms that screen's
    // suggestions, exactly as pressing Next or Back does. Otherwise the last
    // section's suggestions have no way to be confirmed at all — its footer
    // button IS Finalise — and the technician is told to fix two answers that
    // are on the screen in front of them.
    const justConfirmed = current?.toConfirm ?? []
    confirmKeys(justConfirmed)

    // Finalise sends its own payload, but flushing first means a failed
    // finalise still leaves the latest draft on the server.
    await autosave.flush()

    // `pending` is this render's answer and does not know about the line
    // above; validating against it would refuse the report for suggestions
    // just confirmed. The server sees them confirmed because mutations from
    // one client are sent in order, and `confirmPrefill` went first.
    const stillPending = Object.fromEntries(
      Object.entries(pending).filter(([key]) => !justConfirmed.includes(key)),
    )

    const result = validateReport({
      template,
      data,
      signedSlots,
      photoCounts,
      prefill: stillPending,
    })
    if (!result.ok) {
      setErrors(
        Object.fromEntries(
          result.issues.map((issue) => [issue.key, issue.message]),
        ),
      )
      setIssues(result.issues)
      return
    }
    setErrors({})
    setIssues([])
    // A fresh look at the sheet: what stopped an earlier preview may be
    // long mended.
    setPreviewTrouble(null)
    setConfirming(true)
  }

  /**
   * The lock itself, from the sheet's own button.
   *
   * Validated a second time rather than reusing the payload that opened the
   * sheet: the sheet can answer the finish time, and an answer made in the
   * last five seconds belongs in the document as much as any other.
   */
  function onConfirmFinalise() {
    const result = validateReport({
      template,
      data,
      signedSlots,
      photoCounts,
      prefill: pending,
    })
    if (!result.ok) {
      setConfirming(false)
      setErrors(
        Object.fromEntries(
          result.issues.map((issue) => [issue.key, issue.message]),
        ),
      )
      setIssues(result.issues)
      return
    }
    finalise.mutate({
      businessId,
      reportId,
      data: result.payload,
      templateVersion: template.version,
    })
  }

  return (
    // One column on a phone; on a desktop a standing section list beside a
    // readable measure — the page had been stretching every field across the
    // full 1280px shell, which is not a form so much as a wall.
    <div className="px-4 pb-[calc(120px+env(safe-area-inset-bottom))] pt-2 lg:grid lg:grid-cols-[minmax(200px,240px)_minmax(0,1fr)] lg:items-start lg:gap-8 lg:px-6">
      <div className="sticky top-4 hidden lg:block">
        <SectionNav
          progress={progress}
          currentId={current?.id ?? null}
          onOpen={(section) => goToSection(section)}
          onOverview={() => goToSection(null)}
        />
      </div>

      <div className="lg:max-w-[720px]">
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
            disabled={finalise.isPending || !ready}
            lastVisit={
              lastVisit
                ? {
                    finalisedAt: lastVisit.finalisedAt,
                    labels: lastVisit.labels,
                    onCopy: () => copyLast.mutate(lastVisit.reportId),
                    pending: copyLast.isPending,
                  }
                : undefined
            }
          />
        )}

        {/* The overview lists the sections; a section screen shows exactly one.
          Rendering every field on both would make the overview the long scroll
          this flow exists to replace. */}
        {visibleSections(sectionsOf(template), data)
          .filter(
            (section, index) =>
              current && sectionKey(section, index) === current.id,
          )
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

              {section.quick && (
                <QuickAnswer
                  mode={section.quick}
                  fields={section.fields}
                  data={data}
                  onAnswer={(patch) =>
                    setData((prev) => ({ ...prev, ...patch }))
                  }
                />
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
                  suggestion={
                    (pending as Partial<PrefillMap>)[field.key]?.source
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
                  after={
                    field.kind === 'heading' && field.quick ? (
                      <QuickAnswer
                        mode={field.quick}
                        fields={groupAfter(section.fields, index)}
                        data={data}
                        onAnswer={(patch) =>
                          setData((prev) => ({ ...prev, ...patch }))
                        }
                      />
                    ) : undefined
                  }
                  photoContext={{
                    businessId,
                    reportId,
                    roster,
                    usual,
                    remember,
                    phrases,
                    // Live answers, so a licence row follows the technician picked
                    // a moment ago rather than the one last saved.
                    context: context
                      ? { ...context, answers: data }
                      : undefined,
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
              {blocked.length === 1
                ? '1 thing to finish'
                : `${blocked.length} things to finish`}
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {blocked.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => goToSection(item.section)}
                    className="text-left underline underline-offset-2"
                  >
                    {item.message}
                    {item.section && (
                      <span className="text-muted">
                        {' '}
                        — {item.section.title}
                      </span>
                    )}
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
          <FormAlert className="mt-4">
            {clashed
              ? 'Not saved — someone else changed the same answer while you were editing. Reload to see what they wrote; this device keeps your answers and offers them back.'
              : 'Not saved — check your connection, then tap Retry. Your answers are still on this device until you leave the page.'}
          </FormAlert>
        )}

        {/* Not for an incomplete report: that refusal names its questions, and
          `onError` has already turned them into the list of things to finish.
          A generic "could not finalise" above a precise list of why is the
          same news twice, the vaguer one first. */}
        {finalise.isError && !incompleteIssues(finalise.error) && (
          <FormAlert className="mt-4">
            {finaliseError(finalise.error, { isCorrection, licenceFix })}
          </FormAlert>
        )}
        {Object.keys(errors).length > 0 && !blocked && (
          <FormAlert className="mt-4">
            Some required details are missing. Check the fields marked above.
          </FormAlert>
        )}

        {/* Offered, never applied on its own: these answers may be older than
          what another device has since saved, and only the person who typed
          them can tell. */}
        <Sheet
          open={stranded !== null}
          onClose={() => setStranded(null)}
          title="Unsaved answers on this phone"
          description={
            stranded
              ? `Typed here ${whenRoughly(stranded.savedAt)}, and never saved to the server.`
              : undefined
          }
          footer={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  void forgetDraft(reportId)
                  setStranded(null)
                }}
                className={`${SECONDARY_BUTTON} flex-1`}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => {
                  if (stranded) {
                    setData((prev) => ({ ...prev, ...stranded.data }))
                  }
                  setStranded(null)
                }}
                className={`${NEUTRAL_BUTTON} flex-1`}
              >
                Restore them
              </button>
            </div>
          }
        >
          <p className="text-body text-ink-2">
            This phone still holds answers from a session that ended before they
            reached the server — a tab closed, or a connection that dropped.
            Restoring them puts them back on top of what is here now.
          </p>
        </Sheet>

        <FinaliseSheet
          open={confirming}
          onClose={() => {
            setConfirming(false)
            setPreviewTrouble(null)
          }}
          onConfirm={onConfirmFinalise}
          pending={finalise.isPending}
          template={template}
          data={data}
          context={context}
          signedSlots={signedSlots ?? []}
          photoCount={Object.values(photoCounts ?? {}).reduce(
            (total, n) => total + n,
            0,
          )}
          onAnswer={(key, value) =>
            setData((prev) => ({ ...prev, [key]: value }))
          }
          onPreview={openPreview}
          previewTrouble={previewTrouble}
        />

        {hydrated && previewing !== null && (
          <DraftPreviewViewer
            key={previewing}
            nonce={previewing}
            businessId={businessId}
            reportId={reportId}
            title={identity.title}
            fileName={identity.fileName}
            flush={autosave.flush}
            onClose={closePreview}
            onRefused={previewRefused}
          />
        )}

        {/* `data-ready` is the readiness signal the e2e suite waits on: the
          footer's buttons change label per screen, so waiting on any one of
          them by name was a wait on the layout rather than on hydration. */}
        <div
          data-report-footer
          data-ready={ready ? 'true' : 'false'}
          /* Typing a comment must not hide the way to the next section: iOS does
           not shrink the layout viewport for the keyboard, so a fixed bar sits
           under it unless it is offset by what the keyboard actually covers. */
          style={keyboardInset > 0 ? { bottom: keyboardInset } : undefined}
          // Fixed above the dock on a phone, where it must stay under the thumb;
          // on a desktop it belongs at the end of the form it acts on, rather
          // than floating across the middle of the screen.
          className={`chrome-blur fixed inset-x-0 ${ABOVE_DOCK} z-30 mx-auto flex max-w-[460px] gap-2 border-t border-hairline p-3 lg:static lg:mt-8 lg:max-w-none lg:rounded-2xl lg:border lg:border-hairline lg:p-3`}
        >
          {current ? (
            <>
              <button
                type="button"
                disabled={!hydrated}
                onClick={() => goToSection(previousSection)}
                className={`${SECONDARY_BUTTON} flex items-center justify-center gap-2 px-4`}
              >
                <ArrowLeft size={17} strokeWidth={2} />
                {previousSection ? 'Back' : 'Overview'}
              </button>
              {nextSection ? (
                <button
                  type="button"
                  disabled={!hydrated}
                  onClick={() => goToSection(nextSection)}
                  className={`${NEUTRAL_BUTTON} flex min-w-0 flex-1 items-center justify-center gap-2`}
                >
                  <span className="truncate">
                    Next: {nextSection.number ? `${nextSection.number}. ` : ''}
                    {nextSection.title}
                  </span>
                  <ArrowRight size={17} strokeWidth={2} className="shrink-0" />
                </button>
              ) : (
                <FinaliseButton
                  disabled={finalise.isPending || !ready}
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
                className={`${SECONDARY_BUTTON} flex flex-1 items-center justify-center gap-2`}
              >
                <Save size={17} strokeWidth={2} />
                {SAVE_LABELS[autosave.status]}
              </button>
              {/* Never greyed out: a technician who believes they are finished
                must be able to press it and be told what is missing, rather
                than left guessing at a dead button. */}
              {progress.complete || !progress.firstIncomplete ? (
                <FinaliseButton
                  disabled={finalise.isPending || !ready}
                  pending={finalise.isPending}
                  onClick={() => void onFinaliseClick()}
                />
              ) : (
                <button
                  type="button"
                  disabled={!hydrated}
                  onClick={() => goToSection(progress.firstIncomplete)}
                  className={`${NEUTRAL_BUTTON} flex flex-1 items-center justify-center gap-2`}
                >
                  Continue
                  <ArrowRight size={17} strokeWidth={2} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** `at 2:05pm today`, `on Mon 14 Sept, 2:05pm` — enough to recognise a
 * session by. In the phone's own zone: it is about what was typed on it. */
function whenRoughly(at: number): string {
  const zone = deviceTimezone()
  const today = todayKey(zone)
  const day = dayKeyOf(at, zone)
  const time = formatTime(at, zone)
  return day === today
    ? `at ${time} today`
    : `on ${formatJobDate(day, today)}, ${time}`
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
      className={`${PRIMARY_BUTTON} flex flex-1 items-center justify-center gap-2`}
    >
      <Lock size={17} strokeWidth={2} />
      {pending ? 'Locking…' : 'Finalise & lock'}
    </button>
  )
}

/**
 * The questions a server-side refusal named, if it named any.
 *
 * Convex delivers a `ConvexError`'s payload as `data`; anything else — a lost
 * connection, a report someone else locked first — has none, and keeps the
 * general message.
 */
function incompleteIssues(error: unknown): Array<ReportIssue> | null {
  const data: unknown = (error as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object') return null
  const payload = data as { code?: unknown; issues?: unknown }
  if (payload.code !== 'REPORT_INCOMPLETE' || !Array.isArray(payload.issues))
    return null
  return payload.issues.filter(
    (issue): issue is ReportIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as ReportIssue).key === 'string' &&
      typeof (issue as ReportIssue).message === 'string',
  )
}

/**
 * The fields a heading's quick answer covers: everything under it, up to the
 * next heading. A group is what the technician sees as one card, not the whole
 * section it happens to sit in.
 */
function groupAfter(
  fields: Array<FieldDef>,
  headingIndex: number,
): Array<FieldDef> {
  const rest = fields.slice(headingIndex + 1)
  const nextHeading = rest.findIndex((field) => field.kind === 'heading')
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading)
}

/**
 * One tap that answers a group of questions with "nothing found".
 *
 * Disappears once there is nothing left for it to settle, so it never reads as
 * a button that does nothing, and says how many answers it would fill so the
 * technician knows exactly what they are agreeing to.
 */
function QuickAnswer({
  mode,
  fields,
  data,
  onAnswer,
}: {
  mode: QuickMode
  fields: Array<FieldDef>
  data: Record<string, unknown>
  onAnswer: (patch: Record<string, unknown>) => void
}) {
  const hydrated = useHydrated()
  const patch = quickAnswersFor(fields, mode, data)
  const count = Object.keys(patch).length
  if (count === 0) return null

  return (
    <button
      type="button"
      disabled={!hydrated}
      onClick={() => onAnswer(patch)}
      className={`${SECONDARY_BUTTON_COMPACT} mt-2 flex w-full items-center justify-center gap-2`}
    >
      <CheckCheck size={16} strokeWidth={2} />
      {mode === 'allYes'
        ? `Yes to all ${count}`
        : `Nothing found — answer all ${count}`}
    </button>
  )
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
function finaliseError(
  error: unknown,
  {
    isCorrection,
    licenceFix,
  }: { isCorrection: boolean; licenceFix?: LicenceFix | null },
) {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('HOLDER_LICENCE_MISSING')) {
    // Only ever the author's own refusal: anyone else is refused sooner, as
    // not the one who signs (HOLDER_MUST_FINALISE). The notice at the top of
    // the report has the field.
    if (licenceFix === 'self') {
      return 'Add your licence number at the top of this report, then finalise again.'
    }
    return 'This report needs a licence number on the account it belongs to. Ask the owner to add it in Settings → Team, then finalise again.'
  }
  if (message.includes('HOLDER_LICENCE_EXPIRED')) {
    return 'The licence on this account has expired. Ask the owner to update it in Settings → Team, then finalise again.'
  }
  if (message.includes('TECHNICIAN_NOT_SIGNER')) {
    // A correction copies the original's answers, names included, onto a
    // draft written by whoever pressed Correct — typically the owner fixing a
    // technician's certificate. "Ask them to write it" is a dead end there:
    // they cannot open a correction while this one exists. Deleting it is what
    // lets them start their own.
    return isCorrection
      ? 'This correction names someone else — as technician, inspector or installer — and only they can finalise a certificate in their name. Name yourself in each of those, or delete this draft so they can correct it themselves.'
      : 'This certificate names someone else — as technician, inspector or installer — and only they can finalise a certificate in their name. Name yourself in each of those, or ask them to write it.'
  }
  if (message.includes('HOLDER_MUST_SIGN')) {
    return 'The technician’s signature on this certificate was drawn from someone else’s sign-in. Sign it again yourself, then finalise.'
  }
  if (message.includes('HOLDER_MUST_FINALISE')) {
    return 'This is a regulated document, so only the person whose licence it carries can finalise it. Ask them to sign it from their own account.'
  }
  if (message.includes('SWITCHED_REGULATED')) {
    return 'This is a regulated document, so it has to be finalised by the licence holder themselves. Switch back to your own account and ask them to sign it.'
  }
  if (message.includes('REPORT_FINALISED')) {
    return 'This report has already been finalised.'
  }
  if (message.includes('TEMPLATE_NOT_FROZEN')) {
    // A business's own form is locked with a copy of its wording, so the
    // report can never later print an edit made after it was signed. That
    // copy could not be saved; nothing was locked.
    return 'The form’s wording could not be saved with this report, so it has not been finalised. Your answers are kept. Try again — if it keeps happening, ask the owner: the form or its option lists may have grown too large to save with a report.'
  }
  if (message.includes('TEMPLATE_VERSION_MISMATCH')) {
    return 'This form has been updated since you opened it. Reload the page and check your answers before finalising.'
  }
  if (message.includes('NO_ACCESS') || message.includes('NOT_EDITABLE')) {
    return 'This report belongs to someone else, so you cannot finalise it.'
  }
  return 'Could not finalise this report. Your answers are still saved — try again in a moment.'
}
