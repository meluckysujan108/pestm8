import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Ref } from 'react'
import type { Infer } from 'convex/values'
import { AU_STATES } from '#/lib/au'
import { Segmented } from '#/components/primitives/Segmented'
import { AbnInput } from './AbnInput'
import { AddressLookupInput } from './AddressLookupInput'
import { PostcodeStateHint } from './PostcodeStateHint'
import type { Id } from '../../../convex/_generated/dataModel'
import type {
  newClientFields,
  newPropertyFields,
} from '../../../convex/properties'

export type ClientKind = 'person' | 'business'

/** A site's address and who to ask for there — a new client's first site, or
 * another site at an existing client (NewJobSheet, Prompt 6.3). */
export type NewSiteValue = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
}

export const EMPTY_NEW_SITE: NewSiteValue = {
  addressLine: '',
  suburb: '',
  state: 'WA',
  postcode: '',
  siteContactName: '',
  siteContactPhone: '',
}

export type NewClientFieldsValue = NewSiteValue & {
  kind: ClientKind
  clientName: string
  abn: string
  contactPerson: string
  phone: string
  email: string
}

export const EMPTY_NEW_CLIENT: NewClientFieldsValue = {
  ...EMPTY_NEW_SITE,
  kind: 'person',
  clientName: '',
  abn: '',
  contactPerson: '',
  phone: '',
  email: '',
}

export type NewClientArgs = Infer<typeof newClientFields>
export type NewSiteArgs = Infer<typeof newPropertyFields>

/** Blank is "not given": the server stores nothing rather than ''. */
function optional(raw: string): string | undefined {
  return raw.trim() || undefined
}

/**
 * The draft as `properties.create`, `jobs.create` and `recurrences.create`
 * take it. The one mapping, used by every caller: the fields used to be
 * listed by hand at each call site, and a field left off one of those lists
 * is saved from one sheet and silently dropped from the other.
 *
 * A person has no ABN, contact person or site contact (Prompt 6.1/6.3), so
 * those are left out for one even when a switch from Business left them typed
 * in: hidden fields are never sent.
 */
export function newClientArgs(value: NewClientFieldsValue): NewClientArgs {
  return {
    clientName: value.clientName.trim(),
    kind: value.kind,
    addressLine: value.addressLine.trim(),
    suburb: value.suburb.trim(),
    state: value.state,
    postcode: value.postcode.trim(),
    phone: optional(value.phone),
    email: optional(value.email),
    ...(value.kind === 'business' && {
      abn: optional(value.abn),
      contactPerson: optional(value.contactPerson),
      siteContactName: optional(value.siteContactName),
      siteContactPhone: optional(value.siteContactPhone),
    }),
  }
}

/** A new site at an existing client, as `jobs.create`'s `newProperty` takes
 * it. The site contact goes only with a business client's, for the same
 * reason as in `newClientArgs`. */
export function newSiteArgs(
  clientId: Id<'clients'>,
  clientKind: ClientKind | undefined,
  site: NewSiteValue,
): NewSiteArgs {
  return {
    clientId,
    addressLine: site.addressLine.trim(),
    suburb: site.suburb.trim(),
    state: site.state,
    postcode: site.postcode.trim(),
    ...(clientKind === 'business' && {
      siteContactName: optional(site.siteContactName),
      siteContactPhone: optional(site.siteContactPhone),
    }),
  }
}

/**
 * The server's INVALID_ABN, said plainly, or null for any other failure.
 * `AbnInput` stops a bad ABN before submit, so this is the backstop for the
 * two checks ever disagreeing — and "could not save" would send someone
 * looking everywhere but the ABN.
 */
export function abnRefusal(error: Error | null): string | null {
  return error?.message.includes('INVALID_ABN')
    ? "That ABN doesn't pass the ATO check — check the 11 digits."
    : null
}

/**
 * The client + first-property fields, shared between `NewPropertySheet.tsx`
 * (adding a client on its own) and `NewJobSheet.tsx` (adding one inline
 * while booking a job) — extracted so the two stay identical rather than
 * drifting if either is tweaked later.
 */
export function NewClientFields({
  value,
  onChange,
  biasState,
}: {
  value: NewClientFieldsValue
  onChange: (patch: Partial<NewClientFieldsValue>) => void
  /** The business's own state, whose addresses are suggested first. */
  biasState?: string
}) {
  const abnId = useId()
  const business = value.kind === 'business'
  const [addingSiteContact, setAddingSiteContact] = useState(false)
  const siteContactInput = useRef<HTMLInputElement>(null)
  // Kept open while it holds anything, like the work order on the booking
  // sheet: a value typed in is never sent unseen.
  const showSiteContact =
    addingSiteContact ||
    value.siteContactName !== '' ||
    value.siteContactPhone !== ''

  return (
    <>
      <Field label="Client type">
        <Segmented
          label="Client type"
          value={value.kind}
          onChange={(kind) => onChange({ kind })}
          options={[
            { value: 'person', label: 'Person' },
            { value: 'business', label: 'Business' },
          ]}
        />
      </Field>

      <Field label={business ? 'Business name' : 'Client name'}>
        <Input
          value={value.clientName}
          onChange={(clientName) => onChange({ clientName })}
          required
        />
      </Field>
      {business && (
        <FieldFor id={abnId} label="ABN (optional)">
          <AbnInput
            id={abnId}
            value={value.abn}
            onChange={(abn) => onChange({ abn })}
            size="lg"
          />
        </FieldFor>
      )}

      <SiteAddressFields
        value={value}
        onChange={onChange}
        biasState={biasState}
      />

      {/* The same labels as the client sheet's edit form: a business's phone
          and email are head office's, not whoever is on site. */}
      <Field label={business ? 'Main phone (optional)' : 'Phone (optional)'}>
        <Input
          value={value.phone}
          onChange={(phone) => onChange({ phone })}
          type="tel"
        />
      </Field>
      <Field label={business ? 'Main email (optional)' : 'Email (optional)'}>
        <Input
          value={value.email}
          onChange={(email) => onChange({ email })}
          type="email"
        />
      </Field>

      {business && (
        <>
          <Field label="Contact person (optional)">
            <Input
              value={value.contactPerson}
              onChange={(contactPerson) => onChange({ contactPerson })}
            />
          </Field>
          {showSiteContact ? (
            <SiteContactFields
              value={value}
              onChange={onChange}
              nameRef={siteContactInput}
            />
          ) : (
            // A button, not a Field: inside a <label> it would take the
            // label's name. type="button" so it can never be the form's
            // submit.
            <button
              type="button"
              onClick={() => {
                // Rendered and focused inside the tap, or iOS shows a focus
                // ring and no keyboard (see "+ Add work order").
                flushSync(() => setAddingSiteContact(true))
                siteContactInput.current?.focus()
              }}
              className="mt-3 text-[15px] font-semibold text-blue"
            >
              + Add site contact
            </button>
          )}
        </>
      )}
    </>
  )
}

/**
 * Street, suburb, state and postcode, with address suggestions on the street
 * (Prompt 6.2). Picking one fills all four at once, so the suburb, state and
 * postcode come from the same place as the street instead of being typed in
 * separately, where nothing checks one against another.
 */
export function SiteAddressFields({
  value,
  onChange,
  biasState,
}: {
  value: Pick<NewSiteValue, 'addressLine' | 'suburb' | 'state' | 'postcode'>
  onChange: (patch: Partial<NewSiteValue>) => void
  biasState?: string
}) {
  const streetId = useId()
  return (
    <>
      <FieldFor id={streetId} label="Street address">
        <AddressLookupInput
          id={streetId}
          value={value.addressLine}
          onChange={(addressLine) => onChange({ addressLine })}
          onPick={(address) => onChange(address)}
          required
          size="lg"
          biasState={biasState}
        />
      </FieldFor>
      <Field label="Suburb">
        <Input
          value={value.suburb}
          onChange={(suburb) => onChange({ suburb })}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="State">
          <select
            value={value.state}
            onChange={(e) => onChange({ state: e.target.value })}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            {AU_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Postcode">
          <Input
            value={value.postcode}
            onChange={(postcode) => onChange({ postcode })}
            required
            inputMode="numeric"
          />
        </Field>
      </div>
      <PostcodeStateHint
        postcode={value.postcode}
        state={value.state}
        onUseState={(state) => onChange({ state })}
      />
    </>
  )
}

/** Who to ask for at a business client's site (Prompt 6.3) — on the day, the
 * technician's Call rings this number rather than head office's. */
export function SiteContactFields({
  value,
  onChange,
  nameRef,
}: {
  value: Pick<NewSiteValue, 'siteContactName' | 'siteContactPhone'>
  onChange: (patch: Partial<NewSiteValue>) => void
  nameRef?: Ref<HTMLInputElement>
}) {
  return (
    <>
      <Field label="Site contact name">
        <Input
          inputRef={nameRef}
          value={value.siteContactName}
          onChange={(siteContactName) => onChange({ siteContactName })}
        />
      </Field>
      <Field label="Site contact number">
        <Input
          value={value.siteContactPhone}
          onChange={(siteContactPhone) => onChange({ siteContactPhone })}
          type="tel"
        />
      </Field>
    </>
  )
}

function Input({
  value,
  onChange,
  type = 'text',
  required,
  inputMode,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  inputMode?: 'numeric' | 'decimal' | 'tel'
  inputRef?: Ref<HTMLInputElement>
}) {
  return (
    <input
      ref={inputRef}
      type={type}
      value={value}
      required={required}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
    />
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="mt-4 flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}

/**
 * `Field` for a control that renders more than its input — a suggestion list,
 * an error line. Wrapped in a <label>, all of that text would become part of
 * the field's name, so it is named with `htmlFor` instead.
 */
function FieldFor({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <label htmlFor={id} className="section-label">
        {label}
      </label>
      <div>{children}</div>
    </div>
  )
}
