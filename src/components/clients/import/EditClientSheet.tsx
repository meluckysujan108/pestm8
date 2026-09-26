import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Plus } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { FieldMessage } from '#/components/forms/FieldMessage'
import { FormField } from '#/components/forms/FormField'
import { useHydrated } from '#/lib/useHydrated'
import { AU_STATE_CODES } from '../../../../convex/lib/clientImport'
import { applyDraft, blankSite, draftOf } from './draft'
import type { ReactNode, RefObject } from 'react'
import type { Draft, SiteDraft } from './draft'
import type { ReviewClient, ReviewIssue } from '#/lib/clientImport/types'

/** What the review said, by field and site, for looking up rather than
 * searching: a client with hundreds of sites has hundreds of issues, and
 * every box asks on every keystroke. */
type IssueAt = ReadonlyMap<string, ReviewIssue>

const issueKey = (field: ReviewIssue['field'], siteIndex?: number) =>
  `${field}|${siteIndex ?? ''}`

/**
 * Everything about one client, to put right what the file got wrong: its
 * name and kind, how to reach it, and each site. Save hands the result back
 * to be judged again, exactly as a fix is.
 *
 * What the review said about a field shows under it until the field is
 * changed — then it is the review's to say again, at Save.
 */
export function EditClientSheet({
  client,
  businessState,
  returnFocusRef,
  onClose,
  onSave,
}: {
  /** The client being edited; null while the sheet is shut. */
  client: ReviewClient | null
  businessState: string
  /** Where focus goes back to when the sheet shuts: the card's Edit. */
  returnFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
  onSave: (client: ReviewClient) => void
}) {
  const hydrated = useHydrated()
  const formId = useId()
  return (
    <Sheet
      open={client !== null}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Edit client"
      description="Changes are checked again when you save. Nothing is imported yet."
      footer={
        <button
          type="submit"
          form={formId}
          disabled={!hydrated}
          className={`${PRIMARY_BUTTON} w-full`}
        >
          Save
        </button>
      }
    >
      {client && (
        <EditForm
          key={client.key}
          formId={formId}
          client={client}
          businessState={businessState}
          onSave={onSave}
        />
      )}
    </Sheet>
  )
}

function EditForm({
  formId,
  client,
  businessState,
  onSave,
}: {
  formId: string
  client: ReviewClient
  businessState: string
  onSave: (client: ReviewClient) => void
}) {
  const hydrated = useHydrated()
  const ids = useId()
  const form = useRef<HTMLFormElement>(null)
  const addSite = useRef<HTMLButtonElement>(null)
  const added = useRef(0)
  // The client as the review saw it, taken once: what a field is compared
  // with to know whether the review's words about it still apply.
  const [original] = useState(() => draftOf(client))
  const [draft, setDraft] = useState(original)
  const business = draft.kind === 'business'

  const issueAt: IssueAt = useMemo(() => {
    const found = new Map<string, ReviewIssue>()
    for (const issue of client.issues) {
      if (issue.level === 'fixed') continue
      const key = issueKey(issue.field, issue.siteIndex)
      if (!found.has(key)) found.set(key, issue)
    }
    return found
  }, [client])

  // The first thing to put right, brought into view once the sheet has
  // slid up. Not focused: on a phone that would throw the keyboard over
  // the sheet before the person has read it.
  useEffect(() => {
    const timer = setTimeout(() => {
      form.current
        ?.querySelector('[aria-invalid="true"]')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 350)
    return () => clearTimeout(timer)
  }, [])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  // Stable, so typing in one site draws that site's boxes again and no
  // other's (`SiteFields` is memoised).
  const setSite = useCallback(
    (id: string, patch: Partial<SiteDraft>) =>
      setDraft((d) => ({
        ...d,
        sites: d.sites.map((site) =>
          site.id === id ? { ...site, ...patch } : site,
        ),
      })),
    [],
  )
  const removeSite = useCallback((id: string) => {
    setDraft((d) => ({ ...d, sites: d.sites.filter((site) => site.id !== id) }))
    // Its Remove button has gone with it; the keyboard carries on from the
    // end of the sites rather than the top of the sheet.
    requestAnimationFrame(() => addSite.current?.focus())
  }, [])

  /** What the review said about one of the client's own fields, while it
   * still has the value the review saw. */
  const said = (
    field: 'name' | 'contactPerson' | 'phone' | 'email' | 'abn',
  ): ReviewIssue | undefined =>
    draft[field] === original[field] ? issueAt.get(issueKey(field)) : undefined

  // An issue about the client as a whole: "No address — a client needs at
  // least one site." Said until one is added.
  const general =
    draft.sites.length > 0
      ? []
      : client.issues.filter(
          (issue) =>
            issue.level === 'error' &&
            issue.siteIndex === undefined &&
            issue.field === 'addressLine',
        )

  return (
    <form
      ref={form}
      id={formId}
      className="pb-4"
      // The review judges what was typed, and says why at Save; the
      // browser's own email check would refuse to save anything at all
      // while one field is still wrong.
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        onSave(applyDraft(client, draft))
      }}
    >
      <div className="mt-1 flex flex-col gap-1.5">
        <span className="section-label">Client type</span>
        {/* An answer, not a view: a radio group, as the client form's. */}
        <Segmented
          kind="choice"
          label="Client type"
          value={draft.kind}
          disabled={!hydrated}
          onChange={(kind) => set({ kind })}
          options={[
            { value: 'person', label: 'Person' },
            { value: 'business', label: 'Business' },
          ]}
        />
      </div>

      <TextField
        id={`${ids}-name`}
        label={business ? 'Business name' : 'Client name'}
        value={draft.name}
        onChange={(name) => set({ name })}
        issue={said('name')}
        disabled={!hydrated}
      />
      {business && (
        <TextField
          id={`${ids}-contact`}
          label="Contact person"
          value={draft.contactPerson}
          onChange={(contactPerson) => set({ contactPerson })}
          issue={said('contactPerson')}
          disabled={!hydrated}
        />
      )}
      <TextField
        id={`${ids}-phone`}
        label={business ? 'Main phone' : 'Phone'}
        value={draft.phone}
        onChange={(phone) => set({ phone })}
        issue={said('phone')}
        disabled={!hydrated}
        type="tel"
        inputMode="tel"
      />
      <TextField
        id={`${ids}-email`}
        label={business ? 'Main email' : 'Email'}
        value={draft.email}
        onChange={(email) => set({ email })}
        issue={said('email')}
        disabled={!hydrated}
        type="email"
        inputMode="email"
      />
      {business && (
        <TextField
          id={`${ids}-abn`}
          label="ABN"
          value={draft.abn}
          onChange={(abn) => set({ abn })}
          issue={said('abn')}
          disabled={!hydrated}
          inputMode="numeric"
        />
      )}

      {draft.sites.map((site, i) => (
        <SiteFields
          key={site.id}
          idPrefix={ids}
          site={site}
          original={
            site.from === undefined ? undefined : original.sites[site.from]
          }
          position={i}
          count={draft.sites.length}
          business={business}
          disabled={!hydrated}
          issueAt={issueAt}
          onChange={setSite}
          onRemove={removeSite}
        />
      ))}

      {general.map((issue) => (
        <FieldMessage key={issue.message} tone="error" className="mt-5">
          {issue.message}
        </FieldMessage>
      ))}
      <button
        ref={addSite}
        type="button"
        disabled={!hydrated}
        onClick={() => {
          added.current += 1
          const id = `new-${added.current}`
          setDraft((d) => ({
            ...d,
            sites: [...d.sites, blankSite(id, businessState)],
          }))
        }}
        className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-[15px] font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
      >
        <Plus aria-hidden size={17} strokeWidth={2.2} />
        Add a site
      </button>
    </form>
  )
}

/**
 * One site's boxes. Memoised, and handed stable callbacks: a keystroke in
 * one site of a property manager's three hundred draws that site again,
 * not all of them.
 */
const SiteFields = memo(function SiteFields({
  idPrefix,
  site,
  original,
  position,
  count,
  business,
  disabled,
  issueAt,
  onChange,
  onRemove,
}: {
  idPrefix: string
  site: SiteDraft
  /** The site as the review saw it; absent for one added here. */
  original: SiteDraft | undefined
  /** Where it is in the list now, for its heading. */
  position: number
  count: number
  business: boolean
  disabled: boolean
  issueAt: IssueAt
  onChange: (id: string, patch: Partial<SiteDraft>) => void
  onRemove: (id: string) => void
}) {
  const id = `${idPrefix}-${site.id}`
  const heading = count > 1 ? `Site ${position + 1}` : 'Site'

  /** What the review said about this site's field, while it still has the
   * value the review saw. */
  const said = (
    field:
      | 'addressLine'
      | 'suburb'
      | 'state'
      | 'postcode'
      | 'siteContactPhone'
      | 'note',
  ): ReviewIssue | undefined =>
    original !== undefined &&
    site.from !== undefined &&
    site[field] === original[field]
      ? issueAt.get(issueKey(field, site.from))
      : undefined

  const noteIssue = said('note')

  return (
    <fieldset className="mt-6 rounded-2xl border border-hairline bg-surface px-3.5 pb-4 pt-3">
      <legend className="sr-only">{heading}</legend>
      <div className="flex min-h-9 items-center justify-between gap-3">
        <p aria-hidden className="text-row-title text-ink">
          {heading}
        </p>
        {/* Down to one, not none: a client needs a site, and a wrong one is
            better put right than removed. */}
        {count > 1 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(site.id)}
            // Drawn 36px, tapped at 44 (`tap-target`).
            className="relative tap-target inline-flex min-h-9 items-center text-[14px] font-semibold text-red transition active:opacity-60 disabled:opacity-50"
          >
            Remove this site
          </button>
        )}
      </div>
      {site.duplicate && (
        <p className="mt-0.5 text-caption text-grey-ink">
          {site.heldBy
            ? `Already in PestM8, on ${site.heldBy}`
            : 'Already in PestM8'}{' '}
          — it won’t be imported again. Change the address if it’s a different
          place.
        </p>
      )}
      <TextField
        id={`${id}-street`}
        label="Street"
        value={site.addressLine}
        onChange={(addressLine) => onChange(site.id, { addressLine })}
        issue={said('addressLine')}
        disabled={disabled}
      />
      <TextField
        id={`${id}-suburb`}
        label="Suburb"
        value={site.suburb}
        onChange={(suburb) => onChange(site.id, { suburb })}
        issue={said('suburb')}
        disabled={disabled}
      />
      <div className="grid grid-cols-2 gap-3">
        <StateSelect
          id={`${id}-state`}
          value={site.state}
          disabled={disabled}
          issue={said('state')}
          onChange={(state) => onChange(site.id, { state })}
        />
        <TextField
          id={`${id}-postcode`}
          label="Postcode"
          value={site.postcode}
          onChange={(postcode) => onChange(site.id, { postcode })}
          issue={said('postcode')}
          disabled={disabled}
          inputMode="numeric"
        />
      </div>
      {business && (
        <>
          <TextField
            id={`${id}-contact`}
            label="Site contact"
            value={site.siteContactName}
            onChange={(siteContactName) =>
              onChange(site.id, { siteContactName })
            }
            issue={undefined}
            disabled={disabled}
          />
          <TextField
            id={`${id}-contact-phone`}
            label="Site contact’s phone"
            value={site.siteContactPhone}
            onChange={(siteContactPhone) =>
              onChange(site.id, { siteContactPhone })
            }
            issue={said('siteContactPhone')}
            disabled={disabled}
            type="tel"
            inputMode="tel"
          />
        </>
      )}
      <FormField
        id={`${id}-note`}
        label="Site note"
        size="md"
        className="mt-4"
        hint="Pinned on the site, for whoever goes there."
        error={noteIssue?.level === 'error' ? noteIssue.message : undefined}
        warning={noteIssue?.level === 'warning' ? noteIssue.message : undefined}
      >
        {(control) => (
          <textarea
            {...control}
            value={site.note}
            rows={3}
            disabled={disabled}
            onChange={(event) =>
              onChange(site.id, { note: event.target.value })
            }
            className={control.className.replace(/\bh-11\b/, 'min-h-24 py-2.5')}
          />
        )}
      </FormField>
    </fieldset>
  )
})

function TextField({
  id,
  label,
  value,
  onChange,
  issue,
  disabled,
  type = 'text',
  inputMode,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  issue: ReviewIssue | undefined
  disabled: boolean
  type?: string
  inputMode?: 'numeric' | 'tel' | 'email'
}) {
  return (
    <FormField
      id={id}
      label={label}
      size="md"
      className="mt-4"
      error={issue?.level === 'error' ? issue.message : undefined}
      warning={issue?.level === 'warning' ? issue.message : undefined}
    >
      {(control) => (
        <input
          {...control}
          type={type}
          inputMode={inputMode}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  )
}

function StateSelect({
  id,
  value,
  disabled,
  issue,
  onChange,
}: {
  id: string
  value: string
  disabled: boolean
  issue: ReviewIssue | undefined
  onChange: (state: string) => void
}): ReactNode {
  const known = (AU_STATE_CODES as ReadonlyArray<string>).includes(value)
  return (
    <FormField
      id={id}
      label="State"
      size="md"
      className="mt-4"
      error={issue?.level === 'error' ? issue.message : undefined}
      warning={issue?.level === 'warning' ? issue.message : undefined}
    >
      {(control) => (
        <select
          {...control}
          value={known ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {!known && (
            <option value="" disabled>
              State
            </option>
          )}
          {AU_STATE_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      )}
    </FormField>
  )
}
