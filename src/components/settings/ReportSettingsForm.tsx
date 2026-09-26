import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { ReportPolicySection } from './ReportPolicySection'
import { ReportSwitchRow } from './ReportSwitchRow'
import { reportTextChanges } from './reportChanges'
import { FieldRow, SaveBar, SettingsGroup, SettingsLinkRow } from './ui'
import { useSavedFlash } from './useJustSaved'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Settings → Reports, for whoever holds `business.manage`: what a report's
 * title calls the business, where the business's own copy goes, who may send
 * a report where, and whether a job may close without one.
 *
 * The two text fields are one form with one Save; the switches save the
 * moment they are flipped. `forms` is the Forms group, which answers to a
 * different capability (`templates.manage`), passed in so it sits second —
 * after how a report looks, before how it is sent — rather than after
 * everything this form owns.
 *
 * Everything here reads `businesses.reportSettings`, which is business.manage
 * only: nobody without it may render this, or they would ask for something
 * the server refuses them.
 */
export function ReportSettingsForm({
  businessId,
  businessSlug,
  businessName,
  forms,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  /** The last name the title band falls back to. */
  businessName: string
  forms?: ReactNode
}) {
  const hydrated = useHydrated()
  const id = useId()
  const { data } = useQuery(rq.reportSettings(businessId))
  // `null` only for a business that has gone; nothing to edit either way.
  const settings = data ?? undefined

  // What has been typed, or null for "as saved". The page shows the saved
  // value until someone types, so the fields fill in when the settings
  // arrive (they may not have by the first render) and follow a change made
  // elsewhere, instead of freezing whatever the first render saw.
  const [title, setTitle] = useState<string | null>(null)
  const [copy, setCopy] = useState<string | null>(null)

  const convexUpdate = useConvexMutation(api.businesses.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportBrandName?: string
      reportCopyEmail?: string
    }) => convexUpdate(args),
  })
  const setTechnicianRecipients = useMutation({
    mutationFn: (allowTechnicianRecipients: boolean) =>
      convexUpdate({ businessId, allowTechnicianRecipients }),
  })

  const warnings = useSaveWarnings()
  const saved = useSavedFlash()

  const dirty =
    settings !== undefined &&
    Object.keys(reportTextChanges({ title, copy }, settings, businessName))
      .length > 0

  // Read when the save goes, after any checks at Save have answered, not
  // when Save was pressed: an address put right while its domain was still
  // being looked up is what the field shows and what "Saved" claims, so it
  // is what goes.
  const latest = useLatest({ title, copy, settings })

  async function submit(sent: typeof latest.current) {
    if (!sent.settings) return
    const fields = reportTextChanges(
      { title: sent.title, copy: sent.copy },
      sent.settings,
      businessName,
    )
    if (Object.keys(fields).length === 0) return
    await save.mutateAsync({ businessId, ...fields })
    // Back to showing what is saved — the server's version of it, the
    // address tidied — unless something was typed while it was saving.
    setTitle((now) => (now === sent.title ? null : now))
    setCopy((now) => (now === sent.copy ? null : now))
    saved.mark()
  }

  const fallbackName = settings?.tradingName?.trim() || businessName
  const shownTitle = title ?? settings?.reportBrandName ?? ''
  const shownCopy = copy ?? settings?.reportCopyEmail ?? ''
  const loading = settings === undefined

  return (
    <SaveWarningsProvider value={warnings}>
      <form onSubmit={(e) => warnings.guard(e, () => submit(latest.current))}>
        <SettingsGroup
          id={`${id}-appearance`}
          title="Appearance"
          // Shown as it will print, live: the field is the name at the front
          // of the title band, not the whole title, and "Pest M8 Service
          // Report Service Report" is what guessing otherwise produces. (The
          // AS forms print their own headings, so no band, hence "such as".)
          footer={`Starts the title of reports such as “${
            shownTitle.trim() || fallbackName
          } Service Report”.`}
        >
          <FieldRow id={`${id}-title`} label="Report title">
            <input
              id={`${id}-title`}
              value={shownTitle}
              onChange={(e) => setTitle(e.target.value)}
              disabled={loading}
              // What it prints as when left blank: the band falls back to
              // the trading name, then the business's own.
              placeholder={loading ? undefined : fallbackName}
              autoComplete="off"
              className={`${fieldInputClass()} disabled:opacity-60`}
            />
          </FieldRow>
          <SettingsLinkRow
            to="/$businessSlug/settings/business"
            params={{ businessSlug }}
            title="Letterhead & logo"
            subtitle="Logo, address and contact details"
          />
        </SettingsGroup>

        {forms}

        <SettingsGroup
          id={`${id}-sending`}
          title="Sending"
          // What `reports.finalise` does with it (queueFormDeliveries): the
          // copy rides along on the emails a form asks for as it is locked,
          // and falls back to the business email. A send from the report's
          // own Send button carries no copy, so this does not claim one.
          // With no business email on file there is nothing to fall back to,
          // and the line says what the placeholder does.
          footer={`Copied on the emails a form sends as it’s finalised.${
            loading
              ? ''
              : settings.email
                ? ' Blank uses your business email.'
                : ' Leave blank to send no copy.'
          }`}
        >
          <FieldRow id={`${id}-copy`} label="Business copy">
            <EmailInput
              id={`${id}-copy`}
              value={shownCopy}
              onChange={setCopy}
              initial={settings?.reportCopyEmail ?? ''}
              placeholder={
                loading ? undefined : settings.email || 'No copy is sent'
              }
            />
          </FieldRow>
        </SettingsGroup>

        {/* A group of its own, so the Sending footer sits under the field it
            explains rather than under this switch's own line of help. */}
        <SettingsGroup id={`${id}-approvals`} title="Approvals">
          {/* The recipient rule (convex/lib/recipients.ts): someone without
              business.manage may send to the addresses on the client's
              record, and anywhere else waits in the owner's approval queue.
              This lets those sends go straight away. */}
          <ReportSwitchRow
            title="Technicians can email new addresses"
            description="Off, a report to an address not on the client’s record waits for your approval."
            checked={settings?.allowTechnicianRecipients}
            disabled={!hydrated || setTechnicianRecipients.isPending}
            failed={setTechnicianRecipients.isError}
            onCheckedChange={(checked) =>
              setTechnicianRecipients.mutate(checked)
            }
          />
        </SettingsGroup>

        <ReportPolicySection businessId={businessId} />

        <FormAlert error={save.isError ? save.error : null} className="mt-4" />
        <SaveWarningsPanel className="mt-4" />

        <SaveBar
          visible={dirty || save.isPending || saved.recently}
          pending={save.isPending}
          label={warnings.saveLabel(dirty ? 'Save' : 'Saved')}
          disabled={!hydrated || !dirty}
        />
      </form>
    </SaveWarningsProvider>
  )
}
