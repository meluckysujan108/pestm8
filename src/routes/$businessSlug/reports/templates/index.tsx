import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Archive, ArchiveRestore, Copy, Trash2 } from 'lucide-react'
import { Drawer } from 'vaul'
import { api } from '../../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { TEMPLATE_LIST } from '#/lib/reportTemplates'
import type { TemplateId } from '#/lib/reportTemplates'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/$businessSlug/reports/templates/')({
  component: TemplatesPage,
})

function TemplatesPage() {
  const { business, membership } = Route.useRouteContext()

  const { data: custom } = useSuspenseQuery(
    convexQuery(api.customTemplates.list, { businessId: business._id }),
  )

  if (membership.role !== 'owner') {
    return (
      <>
        <PageHeader kicker="Reports" title="Templates" />
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
      <PageHeader kicker="Reports" title="Templates" />

      <div className="px-4 pt-4 pb-6">
        <p className="section-label mb-2">Built-in</p>
        <div className="flex flex-col gap-2.5">
          {TEMPLATE_LIST.map((template) => (
            <BuiltinRow
              key={template.id}
              businessId={business._id}
              // `TEMPLATE_LIST` only ever holds the 4 built-ins — `'custom'`
              // is a marker `resolveReportTemplate` produces, never a source.
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

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-row-title text-ink">{name}</span>
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
          {legalBasis}
        </span>
      </div>
      <p className="mt-1 text-body text-muted">{blurb}</p>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="mt-3 h-10 w-full rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98]"
      >
        Clone &amp; edit
      </button>
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
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          <form
            className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              clone.mutate({ businessId, sourceTemplateId, name })
            }}
          >
            <Drawer.Title className="text-sheet-title text-ink">
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
                className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
              />
            </label>
            <button
              type="submit"
              disabled={clone.isPending || !hydrated}
              className="mt-5 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
            >
              {clone.isPending ? 'Cloning…' : 'Clone template'}
            </button>
          </form>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
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
    onError: async (error) => {
      // The delete button always tries a real delete first — the mutation
      // itself is the one place that actually knows whether anything
      // references this template, so the label follows what it did, not a
      // client-side guess made in advance.
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('TEMPLATE_IN_USE')) {
        await archive.mutateAsync({ businessId, templateId: template._id })
        setNotice('In use by an existing report — archived instead of deleted.')
      }
    },
  })

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

      {notice && <p className="mt-1.5 text-caption text-amber-ink">{notice}</p>}

      <div className="mt-3 flex gap-2">
        <Link
          to="/$businessSlug/reports/templates/$templateId"
          params={{ businessSlug: business.slug, templateId: template._id }}
          className="flex h-10 flex-1 items-center justify-center rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98]"
        >
          Edit
        </Link>
        <button
          type="button"
          aria-label="Duplicate"
          onClick={() => setDuplicateOpen(true)}
          className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95]"
        >
          <Copy size={16} strokeWidth={1.7} />
        </button>
        {template.archivedAt ? (
          <button
            type="button"
            aria-label="Unarchive"
            disabled={unarchive.isPending}
            onClick={() => unarchive.mutate({ businessId, templateId: template._id })}
            className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
          >
            <ArchiveRestore size={16} strokeWidth={1.7} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Archive"
            disabled={archive.isPending}
            onClick={() => archive.mutate({ businessId, templateId: template._id })}
            className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
          >
            <Archive size={16} strokeWidth={1.7} />
          </button>
        )}
        <button
          type="button"
          aria-label="Delete"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ businessId, templateId: template._id })}
          className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50"
        >
          <Trash2 size={16} strokeWidth={1.7} />
        </button>
      </div>

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
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          <form
            className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              duplicate.mutate({ businessId, templateId, name })
            }}
          >
            <Drawer.Title className="text-sheet-title text-ink">
              Duplicate template
            </Drawer.Title>
            <label className="mt-4 flex flex-col gap-1.5">
              <span className="section-label">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
              />
            </label>
            <button
              type="submit"
              disabled={duplicate.isPending || !hydrated}
              className="mt-5 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
            >
              {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
            </button>
          </form>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
