import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Archive, ArchiveRestore, Copy, Trash2 } from 'lucide-react'
import { Drawer } from 'vaul'
import { SheetShell } from '#/components/primitives/Sheet'
import { api } from '../../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { CREATABLE_TEMPLATES } from '#/lib/reportTemplates'
import { TemplateSettingsSheet } from '#/components/reports/TemplateSettingsSheet'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError, errorCode } from '#/components/forms/describeError'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'
import { useCan } from '#/lib/access'
import { NEUTRAL_BUTTON_COMPACT, PRIMARY_BUTTON, SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'

export const Route = createFileRoute('/$businessSlug/reports/templates/')({
  component: TemplatesPage,
})

function TemplatesPage() {
  const { business } = Route.useRouteContext()
  const canManageTemplates = useCan('templates.manage')

  const { data: custom } = useSuspenseQuery(
    convexQuery(api.customTemplates.list, { businessId: business._id }),
  )

  if (!canManageTemplates) {
    return (
      <>
        <PageHeader
          businessId={business._id}
          businessSlug={business.slug}
          kicker="Reports"
          title="Templates"
        />
        <div className="px-4 pt-4 pb-6">
          <EmptyState
            title="Owners only"
            body="Ask a business owner to create or edit report templates."
          />
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        kicker="Reports"
        title="Templates"
      />

      <div className="px-4 pt-4 pb-6">
        <p className="section-label mb-2">Built-in</p>
        <div className="flex flex-col gap-2.5">
          {CREATABLE_TEMPLATES.map((template) => (
            <BuiltinRow
              key={template.id}
              businessId={business._id}
              // Only the creatable built-ins — `'custom'` is a marker
              // `resolveReportTemplate` produces, never a source, and a
              // retired template is not offered to clone.
              templateId={template.id as TemplateId}
              name={template.name}
              legalBasis={template.legalBasis}
              blurb={template.blurb}
            />
          ))}
        </div>

        <p className="section-label mt-6 mb-2">Custom</p>
        {custom.length === 0 ? (
          <EmptyState
            title="No custom templates yet"
            body="Clone a built-in template above to start tweaking it."
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {custom.map((t) => (
              <CustomRow key={t._id} businessId={business._id} template={t} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function BuiltinRow({
  businessId,
  templateId,
  name,
  legalBasis,
  blurb,
}: {
  businessId: Id<'businesses'>
  templateId: TemplateId
  name: string
  legalBasis: string
  blurb: string
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-row-title text-ink">{name}</span>
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
          {legalBasis}
        </span>
      </div>
      <p className="mt-1 text-body text-muted">{blurb}</p>
      <div className="mt-3 flex gap-2">
        {/* Settings first: it is the answer to almost every reason an owner
            opens this page, and cloning forks the wording they are required
            to reproduce. */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={`${NEUTRAL_BUTTON_COMPACT} flex-1`}
        >
          Settings
        </button>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
        >
          Clone &amp; edit
        </button>
      </div>
      <TemplateSettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        businessId={businessId}
        templateId={templateId}
      />
      <CloneBuiltinSheet
        businessId={businessId}
        sourceTemplateId={templateId}
        defaultName={name}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  )
}

/** Clone and duplicate make something new, so they say "copy", not "save". */
const COPY_ERROR = {
  TEMPLATE_RETIRED:
    'This template has been retired, so it can no longer be copied.',
  NOT_FOUND:
    'Could not copy: this template has been deleted since the page opened.',
  offline:
    'Could not make the copy: this device is offline. Try again when you have signal.',
  default: 'Could not make the copy. Check your connection and try again.',
}

function CloneBuiltinSheet({
  businessId,
  sourceTemplateId,
  defaultName,
  open,
  onClose,
}: {
  businessId: Id<'businesses'>
  sourceTemplateId: TemplateId
  defaultName: string
  open: boolean
  onClose: () => void
}) {
  const { business } = Route.useRouteContext()
  const [name, setName] = useState(defaultName)
  const hydrated = useHydrated()
  const navigate = useNavigate()

  const convexClone = useConvexMutation(api.customTemplates.cloneBuiltin)
  const clone = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      sourceTemplateId: TemplateId
      name: string
    }) => convexClone(args),
    onSuccess: (templateId) => {
      onClose()
      navigate({
        to: '/$businessSlug/reports/templates/$templateId',
        params: { businessSlug: business.slug, templateId },
      })
    },
  })

  return (
    <SheetShell open={open} onClose={onClose}>
      <form
        className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          clone.mutate({ businessId, sourceTemplateId, name })
        }}
      >
        <Drawer.Title className="pr-10 text-sheet-title text-ink">
          Clone &amp; edit
        </Drawer.Title>
        <p className="mt-1 text-body text-muted">
          This makes an independent copy — the original built-in template
          never changes, and reports already using it are unaffected.
        </p>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="section-label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className={`${FIELD} w-full`}
          />
        </label>
        {/* A failed clone used to leave the sheet open with nothing said. */}
        <FormAlert
          error={clone.isError ? clone.error : null}
          copy={COPY_ERROR}
          className="mt-4"
        />
        <button
          type="submit"
          disabled={clone.isPending || !hydrated}
          className={`${PRIMARY_BUTTON} mt-5 w-full`}
        >
          {clone.isPending ? 'Cloning…' : 'Clone template'}
        </button>
      </form>
    </SheetShell>
  )
}

type CustomTemplateRow = {
  _id: Id<'customReportTemplates'>
  name: string
  shortName: string
  legalBasis: string
  archivedAt?: number
}

function CustomRow({
  businessId,
  template,
}: {
  businessId: Id<'businesses'>
  template: CustomTemplateRow
}) {
  const { business } = Route.useRouteContext()
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const convexArchive = useConvexMutation(api.customTemplates.archive)
  const convexUnarchive = useConvexMutation(api.customTemplates.unarchive)
  const convexRemove = useConvexMutation(api.customTemplates.remove)

  const archive = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; templateId: Id<'customReportTemplates'> }) =>
      convexArchive(args),
  })
  const unarchive = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; templateId: Id<'customReportTemplates'> }) =>
      convexUnarchive(args),
  })
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; templateId: Id<'customReportTemplates'> }) =>
      convexRemove(args),
  })
  const hydrated = useHydrated()
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Archive and unarchive are one tap each: either is undone right here, by
  // the button that takes its place. Delete is not, so it asks.
  const failed = archive.error ?? unarchive.error

  async function deleteTemplate() {
    try {
      await remove.mutateAsync({ businessId, templateId: template._id })
      setConfirmDelete(false)
    } catch (error) {
      // The mutation is the one place that knows whether a report uses this
      // template, so Delete always tries, and archives when it may not.
      if (errorCode(error) !== 'TEMPLATE_IN_USE') return
      await archive.mutateAsync({ businessId, templateId: template._id })
      remove.reset()
      setConfirmDelete(false)
      setNotice('In use by an existing report — archived instead of deleted.')
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-row-title text-ink">{template.name}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {template.archivedAt && (
            <span className="rounded-full border border-amber-line bg-amber-bg px-2 py-0.5 text-[11px] font-semibold text-amber-ink">
              Archived
            </span>
          )}
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
            {template.legalBasis}
          </span>
        </div>
      </div>

      {notice && (
        <p role="status" className="mt-1.5 text-caption text-amber-ink">
          {notice}
        </p>
      )}
      <FormAlert
        className="mt-2"
        error={failed}
        copy={{ default: 'Could not change this template. Check your signal and try again.' }}
      />

      <div className="mt-3 flex gap-2">
        <Link
          to="/$businessSlug/reports/templates/$templateId"
          params={{ businessSlug: business.slug, templateId: template._id }}
          className={`${SECONDARY_BUTTON_COMPACT} flex flex-1 items-center justify-center`}
        >
          Edit
        </Link>
        <button
          type="button"
          aria-label={`Duplicate ${template.name}`}
          disabled={!hydrated}
          onClick={() => setDuplicateOpen(true)}
          className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
        >
          <Copy size={16} strokeWidth={2} />
        </button>
        {template.archivedAt ? (
          <button
            type="button"
            aria-label={`Unarchive ${template.name}`}
            disabled={!hydrated || unarchive.isPending}
            onClick={() => {
              archive.reset()
              unarchive.mutate({ businessId, templateId: template._id })
            }}
            className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
          >
            <ArchiveRestore size={16} strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Archive ${template.name}`}
            disabled={!hydrated || archive.isPending}
            onClick={() => {
              unarchive.reset()
              setNotice(null)
              archive.mutate({ businessId, templateId: template._id })
            }}
            className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
          >
            <Archive size={16} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          aria-label={`Delete ${template.name}`}
          disabled={!hydrated || remove.isPending}
          onClick={() => {
            remove.reset()
            setConfirmDelete(true)
          }}
          className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
        >
          <Trash2 size={16} strokeWidth={2} />
        </button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${template.name}?`}
        body="It can’t be brought back. If a report already uses it, it’s archived instead, so that report keeps its form."
        confirm="Delete"
        cancel="Keep it"
        onConfirm={() => void deleteTemplate()}
        closeOnConfirm={false}
        pending={remove.isPending || archive.isPending}
        pendingLabel="Deleting…"
        error={
          remove.isError && errorCode(remove.error) !== 'TEMPLATE_IN_USE'
            ? describeError(remove.error, {
                default: 'Could not delete this template. Check your signal and try again.',
              })
            : null
        }
      />

      <DuplicateSheet
        businessId={businessId}
        templateId={template._id}
        defaultName={`${template.name} (Copy)`}
        open={duplicateOpen}
        onClose={() => setDuplicateOpen(false)}
      />
    </div>
  )
}

function DuplicateSheet({
  businessId,
  templateId,
  defaultName,
  open,
  onClose,
}: {
  businessId: Id<'businesses'>
  templateId: Id<'customReportTemplates'>
  defaultName: string
  open: boolean
  onClose: () => void
}) {
  const [name, setName] = useState(defaultName)
  const hydrated = useHydrated()

  const convexDuplicate = useConvexMutation(api.customTemplates.duplicate)
  const duplicate = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      templateId: Id<'customReportTemplates'>
      name: string
    }) => convexDuplicate(args),
    onSuccess: onClose,
  })

  return (
    <SheetShell open={open} onClose={onClose}>
      <form
        className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          duplicate.mutate({ businessId, templateId, name })
        }}
      >
        <Drawer.Title className="pr-10 text-sheet-title text-ink">
          Duplicate template
        </Drawer.Title>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="section-label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className={`${FIELD} w-full`}
          />
        </label>
        <FormAlert
          error={duplicate.isError ? duplicate.error : null}
          copy={COPY_ERROR}
          className="mt-4"
        />
        <button
          type="submit"
          disabled={duplicate.isPending || !hydrated}
          className={`${PRIMARY_BUTTON} mt-5 w-full`}
        >
          {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
        </button>
      </form>
    </SheetShell>
  )
}
