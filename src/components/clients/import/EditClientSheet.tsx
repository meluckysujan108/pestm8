import { useEffect, useId, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { Segmented } from '#/components/primitives/Segmented'
import { FieldMessage } from '#/components/forms/FieldMessage'
import { FormField } from '#/components/forms/FormField'
import { useHydrated } from '#/lib/useHydrated'
import { AU_STATE_CODES } from '../../../../convex/lib/clientImport'
import { PRIMARY_BUTTON } from './ui'
import type { ReactNode } from 'react'
import type { ReviewClient, ReviewIssue } from '#/lib/clientImport/types'

type SiteDraft = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
  note: string
  duplicate: boolean
}

type Draft = {
  kind: 'person' | 'business'
  name: string
  contactPerson: string
  phone: string
  email: string
  abn: string
  sites: Array<SiteDraft>
}

function draftOf(client: ReviewClient): Draft {
  return {
    kind: client.kind,
    name: client.name,
    contactPerson: client.contactPerson ?? '',
    phone: client.phone ?? '',
    email: client.email ?? '',
    abn: client.abn ?? '',
    sites: client.sites.map((site) => ({
      addressLine: site.addressLine,
      suburb: site.suburb,
      state: site.state,
      postcode: site.postcode,
      siteContactName: site.siteContactName ?? '',
      siteContactPhone: site.siteContactPhone ?? '',
      note: site.note ?? '',
      duplicate: site.duplicate === true,
    })),
  }
}

/** Blank is "none": left off rather than kept as '', as the import sends it. */
function given<TKey extends string>(key: TKey, value: string) {
  const trimmed = value.trim()
  return (trimmed ? { [key]: trimmed } : {}) as Partial<Record<TKey, string>>
}

/**
 * The draft as the client it makes. Only the fields are changed: the issues
 * are the old ones, for `recheckClient` to judge again — which keeps what
 * was put right on the way in only while it still holds.
 */
function applyDraft(client: ReviewClient, draft: Draft): ReviewClient {
  const {
    contactPerson: _contactPerson,
    phone: _phone,
    email: _email,
    abn: _abn,
    ...rest
  } = client
  return {
    ...rest,
    kind: draft.kind,
    name: draft.name.replace(/\s+/g, ' ').trim(),
    ...given('contactPerson', draft.contactPerson),
    ...given('phone', draft.phone),
    ...given('email', draft.email),
    ...given('abn', draft.abn),
    sites: draft.sites.map((site) => ({
      addressLine: site.addressLine.replace(/\s+/g, ' ').trim(),
      suburb: site.suburb.replace(/\s+/g, ' ').trim(),
      state: site.state,
      postcode: site.postcode.trim(),
      ...given('siteContactName', site.siteContactName),
      ...given('siteContactPhone', site.siteContactPhone),
      ...given('note', site.note),
      // `recheckClient` works out afresh whether it is already here.
      ...(site.duplicate ? { duplicate: true } : {}),
    })),
  }
}

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
  onClose,
  onSave,
}: {
  /** The client being edited; null while the sheet is shut. */
  client: ReviewClient | null
  businessState: string
  onClose: () => void
  onSave: (client: ReviewClient) => void
}) {
  const hydrated = useHydrated()
  const formId = useId()
  return (
    <Sheet
      open={client !== null}
      onClose={onClose}
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
  const [draft, setDraft] = useState(() => draftOf(client))
  const original = useRef(draftOf(client)).current
  const business = draft.kind === 'business'

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
  const setSite = (index: number, patch: Partial<SiteDraft>) =>
    setDraft((d) => ({
      ...d,
      sites: d.sites.map((site, i) =>
        i === index ? { ...site, ...patch } : site,
      ),
    }))

  /** What the review said about a field, while it still has the value the
   * review saw. */
  const said = (
    field: ReviewIssue['field'],
    siteIndex?: number,
  ): ReviewIssue | undefined => {
    const now =
      siteIndex === undefined
        ? (draft as Record<string, unknown>)[field]
        : (draft.sites[siteIndex] as Record<string, unknown> | undefined)?.[
            field
          ]
    const was =
      siteIndex === undefined
        ? (original as Record<string, unknown>)[field]
        : (original.sites[siteIndex] as Record<string, unknown> | undefined)?.[
            field
          ]
    if (now !== was) return undefined
    return client.issues.find(
      (issue) =>
        issue.field === field &&
        issue.siteIndex === siteIndex &&
        issue.level !== 'fixed',
    )
  }

  const input = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    issue: ReviewIssue | undefined,
    extra: { inputMode?: 'numeric' | 'tel' | 'email'; type?: string } = {},
  ) => (
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
          type={extra.type ?? 'text'}
          inputMode={extra.inputMode}
          value={value}
          disabled={!hydrated}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  )

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
        <Segmented
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

      {input(
        `${ids}-name`,
        business ? 'Business name' : 'Client name',
        draft.name,
        (name) => set({ name }),
        said('name'),
      )}
      {business &&
        input(
          `${ids}-contact`,
          'Contact person',
          draft.contactPerson,
          (contactPerson) => set({ contactPerson }),
          said('contactPerson'),
        )}
      {input(
        `${ids}-phone`,
        business ? 'Main phone' : 'Phone',
        draft.phone,
        (phone) => set({ phone }),
        said('phone'),
        { type: 'tel', inputMode: 'tel' },
      )}
      {input(
        `${ids}-email`,
        business ? 'Main email' : 'Email',
        draft.email,
        (email) => set({ email }),
        said('email'),
        { type: 'email', inputMode: 'email' },
      )}
      {business &&
        input(
          `${ids}-abn`,
          'ABN',
          draft.abn,
          (abn) => set({ abn }),
          said('abn'),
          { inputMode: 'numeric' },
        )}

      {draft.sites.map((site, i) => (
        <fieldset
          key={i}
          className="mt-6 rounded-2xl border border-hairline bg-surface px-3.5 pb-4 pt-3"
        >
          <legend className="sr-only">
            {draft.sites.length > 1 ? `Site ${i + 1}` : 'Site'}
          </legend>
          <p aria-hidden className="text-row-title text-ink">
            {draft.sites.length > 1 ? `Site ${i + 1}` : 'Site'}
          </p>
          {site.duplicate && (
            <p className="mt-0.5 text-caption text-grey-ink">
              Already in PestM8 — it won’t be imported again. Change the address
              if it’s a different place.
            </p>
          )}
          {input(
            `${ids}-${i}-street`,
            'Street',
            site.addressLine,
            (addressLine) => setSite(i, { addressLine }),
            said('addressLine', i),
          )}
          {input(
            `${ids}-${i}-suburb`,
            'Suburb',
            site.suburb,
            (suburb) => setSite(i, { suburb }),
            said('suburb', i),
          )}
          <div className="grid grid-cols-2 gap-3">
            <StateSelect
              id={`${ids}-${i}-state`}
              value={site.state}
              disabled={!hydrated}
              issue={said('state', i)}
              onChange={(state) => setSite(i, { state })}
            />
            {input(
              `${ids}-${i}-postcode`,
              'Postcode',
              site.postcode,
              (postcode) => setSite(i, { postcode }),
              said('postcode', i),
              { inputMode: 'numeric' },
            )}
          </div>
          {business && (
            <>
              {input(
                `${ids}-${i}-contact`,
                'Site contact',
                site.siteContactName,
                (siteContactName) => setSite(i, { siteContactName }),
                undefined,
              )}
              {input(
                `${ids}-${i}-contact-phone`,
                'Site contact’s phone',
                site.siteContactPhone,
                (siteContactPhone) => setSite(i, { siteContactPhone }),
                said('siteContactPhone', i),
                { type: 'tel', inputMode: 'tel' },
              )}
            </>
          )}
          <FormField
            id={`${ids}-${i}-note`}
            label="Site note"
            size="md"
            className="mt-4"
            hint="Pinned on the site, for whoever goes there."
          >
            {(control) => (
              <textarea
                {...control}
                value={site.note}
                rows={3}
                disabled={!hydrated}
                onChange={(event) => setSite(i, { note: event.target.value })}
                className={control.className.replace(
                  /\bh-11\b/,
                  'min-h-24 py-2.5',
                )}
              />
            )}
          </FormField>
        </fieldset>
      ))}

      {general.map((issue) => (
        <FieldMessage key={issue.message} tone="error" className="mt-5">
          {issue.message}
        </FieldMessage>
      ))}
      <button
        type="button"
        disabled={!hydrated}
        onClick={() =>
          setDraft((d) => ({
            ...d,
            sites: [
              ...d.sites,
              {
                addressLine: '',
                suburb: '',
                state: businessState,
                postcode: '',
                siteContactName: '',
                siteContactPhone: '',
                note: '',
                duplicate: false,
              },
            ],
          }))
        }
        className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-[15px] font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
      >
        <Plus aria-hidden size={17} strokeWidth={2.2} />
        Add a site
      </button>
    </form>
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
