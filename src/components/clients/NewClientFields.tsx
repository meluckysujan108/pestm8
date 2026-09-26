import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Ref } from 'react'
import type { Infer } from 'convex/values'
import { Segmented } from '#/components/primitives/Segmented'
import { EmailInput } from '#/components/forms/EmailInput'
import { FIELD, FormField } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  VerifiedAddressFields,
  addressCheckToSend,
} from '#/components/forms/VerifiedAddressFields'
import type { AddressCheck } from '#/components/forms/VerifiedAddressFields'
import type { ErrorCopy } from '#/components/forms/describeError'
import { AbnInput } from './AbnInput'
import type { Id } from '../../../convex/_generated/dataModel'
import type {
  newClientFields,
  newPropertyFields,
} from '../../../convex/properties'

export type ClientKind = 'person' | 'business'

/** A site's address and who to ask for there — a new client's first site, or
 * another site at an existing client (NewJobSheet, Prompt 6.3).
 *
 * `addressCheck` is not typed by anyone: SiteAddressFields keeps it up to
 * date — 'picked' while the four fields still hold the suggestion picked for
 * them, 'typed' otherwise — so it travels with the draft to `newClientArgs`
 * and `newSiteArgs` instead of each sheet holding it separately. */
export type NewSiteValue = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
  addressCheck: AddressCheck
}

export const EMPTY_NEW_SITE: NewSiteValue = {
  addressLine: '',
  suburb: '',
  state: 'WA',
  postcode: '',
  siteContactName: '',
  siteContactPhone: '',
  addressCheck: 'typed',
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
    addressCheck: addressCheckToSend(value.addressCheck, value),
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
    addressCheck: addressCheckToSend(site.addressCheck, site),
    ...(clientKind === 'business' && {
      siteContactName: optional(site.siteContactName),
      siteContactPhone: optional(site.siteContactPhone),
    }),
  }
}

/**
 * FormAlert's words for a new client that could not be saved: the server's
 * INVALID_ABN said plainly, the rest as every form says them (describeError).
 * `AbnInput` stops a bad ABN before submit, so this is the backstop for the
 * two checks ever disagreeing — and "could not save" would send someone
 * looking everywhere but the ABN.
 */
export const NEW_CLIENT_ERROR_COPY: ErrorCopy = {
  INVALID_ABN: "That ABN doesn't pass the ATO check — check the 11 digits.",
}

/**
 * The client + first-property fields, shared between `NewPropertySheet.tsx`
 * (adding a client on its own) and `NewJobSheet.tsx` (adding one inline
 * while booking a job) — extracted so the two stay identical rather than
 * drifting if either is tweaked later.
 *
 * The address, phone and email are checked as they go in, and again at Save
 * when the form is inside a SaveWarningsProvider (both sheets are): anything
 * that may be wrong but might be right is listed above the button, never
 * refused.
 */
export function NewClientFields({
  value,
  onChange,
  businessState,
}: {
  value: NewClientFieldsValue
  onChange: (patch: Partial<NewClientFieldsValue>) => void
  /** The business's own state (the route context's): its addresses are
   * suggested first, one in another state is pointed out, and a phone number
   * missing its area code most likely has this state's. */
  businessState: string
}) {
  const abnId = useId()
  const phoneId = useId()
  const emailId = useId()
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
          kind="choice"
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
        <FormField id={abnId} label="ABN (optional)" className="mt-4">
          <AbnInput
            id={abnId}
            value={value.abn}
            onChange={(abn) => onChange({ abn })}
            size="lg"
          />
        </FormField>
      )}

      <SiteAddressFields
        value={value}
        onChange={onChange}
        businessState={businessState}
      />

      {/* The same labels as the client sheet's edit form: a business's phone
          and email are head office's, not whoever is on site. FormField, not
          Field: these render their own error and warning lines, which inside
          a <label> would become part of the field's name. */}
      <FormField
        id={phoneId}
        label={business ? 'Main phone (optional)' : 'Phone (optional)'}
        className="mt-4"
      >
        <PhoneInput
          id={phoneId}
          value={value.phone}
          onChange={(phone) => onChange({ phone })}
          businessState={businessState}
          size="lg"
        />
      </FormField>
      <FormField
        id={emailId}
        label={business ? 'Main email (optional)' : 'Email (optional)'}
        className="mt-4"
      >
        <EmailInput
          id={emailId}
          value={value.email}
          onChange={(email) => onChange({ email })}
          size="lg"
        />
      </FormField>

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
              businessState={businessState}
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
              className="relative tap-target mt-3 text-body font-semibold text-blue"
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
 * (Prompt 6.2) and the field verification checks (VerifiedAddressFields):
 * picking a suggestion fills all four at once, and whatever ends up in them —
 * picked, typed, or rewritten by autofill since — is checked against each
 * other as it goes in and again at Save. Only a postcode that is not four
 * digits is refused; the rest are warnings above the save button.
 *
 * Keeps the draft's `addressCheck` up to date through `onChange`, for
 * `newClientArgs` / `newSiteArgs`. Needs a SaveWarningsProvider around the
 * form for the checks at Save.
 */
export function SiteAddressFields({
  value,
  onChange,
  businessState,
}: {
  value: Pick<NewSiteValue, 'addressLine' | 'suburb' | 'state' | 'postcode'>
  onChange: (patch: Partial<NewSiteValue>) => void
  /** The work area: an address in another state is pointed out. */
  businessState: string
}) {
  const idPrefix = useId()
  return (
    <VerifiedAddressFields
      idPrefix={idPrefix}
      value={value}
      onChange={onChange}
      workState={businessState}
      onCheckChange={(addressCheck) => onChange({ addressCheck })}
    />
  )
}

/** Who to ask for at a business client's site (Prompt 6.3) — on the day, the
 * technician's Call rings this number rather than head office's. */
export function SiteContactFields({
  value,
  onChange,
  nameRef,
  businessState,
}: {
  value: Pick<NewSiteValue, 'siteContactName' | 'siteContactPhone'>
  onChange: (patch: Partial<NewSiteValue>) => void
  nameRef?: Ref<HTMLInputElement>
  /** For the area code a number missing one most likely has. */
  businessState?: string
}) {
  const phoneId = useId()
  return (
    <>
      <Field label="Site contact name">
        <Input
          inputRef={nameRef}
          value={value.siteContactName}
          onChange={(siteContactName) => onChange({ siteContactName })}
        />
      </Field>
      <FormField id={phoneId} label="Site contact number" className="mt-4">
        <PhoneInput
          id={phoneId}
          value={value.siteContactPhone}
          onChange={(siteContactPhone) => onChange({ siteContactPhone })}
          businessState={businessState}
          size="lg"
        />
      </FormField>
    </>
  )
}

function Input({
  value,
  onChange,
  required,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  required?: boolean
  inputRef?: Ref<HTMLInputElement>
}) {
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD} w-full`}
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
