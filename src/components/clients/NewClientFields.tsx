import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { FocusEvent, Ref } from 'react'
import { matchKeyOf, useMatchLines } from './useMatchLines'
import { areaCodeOf } from '../../../convex/lib/contactKeys'
import type { NewClientMatchField, NewClientMatchLine } from './useMatchLines'
import type { Infer } from 'convex/values'
import { Segmented } from '#/components/primitives/Segmented'
import { EmailInput } from '#/components/forms/EmailInput'
import { FieldMessage } from '#/components/forms/FieldMessage'
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
import { Plus } from 'lucide-react'
import { KIND_CHOICES } from '#/lib/clientFilters'

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

/** A site's address, and for a business's the caller as its site contact:
 * what Clients → New client hands a client's Add property when the caller
 * turns out to be theirs. */
export type SiteAddressDraft = Pick<
  NewSiteValue,
  'addressLine' | 'suburb' | 'state' | 'postcode'
> &
  Partial<Pick<NewSiteValue, 'siteContactName' | 'siteContactPhone'>>

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
  INVALID_ABN: 'That ABN does not pass the ATO check. Check its 11 digits.',
}

/** The fields a caller may put focus in (`newClientFieldId`). */
export type NewClientFocusField =
  'clientName' | 'phone' | 'email' | 'addressLine'

/**
 * The id of one of `NewClientFields`' inputs, for a form that passed it
 * `idPrefix`: New Job puts focus in the field a picker's "New client, phone
 * …" filled, as a fix does, rather than leaving it on a field gone from the
 * screen.
 */
export function newClientFieldId(
  idPrefix: string,
  field: NewClientFocusField,
): string {
  // The street's id is the address block's own (VerifiedAddressFields).
  return field === 'addressLine'
    ? `${idPrefix}-street`
    : `${idPrefix}-${field === 'clientName' ? 'name' : field}`
}

export type { NewClientMatchField, NewClientMatchLine } from './useMatchLines'

const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

/**
 * Whether focus leaving `from` is going to another field (`next`, a blur's
 * `relatedTarget`): an input, a select or a textarea outside it. A button
 * (Book, a fix) is not: iOS gives buttons no focus, so a tap there moves it
 * nowhere, `next` is null, and the panel at Book says it instead.
 */
export function movesToAnotherField<T extends { tagName?: string }>(
  next: T | null | undefined,
  from: { contains: (other: T) => boolean },
): boolean {
  if (!next || !FIELD_TAGS.has(next.tagName ?? '')) return false
  return !from.contains(next)
}

/**
 * The client + first-property fields, shared between `NewPropertySheet.tsx`
 * (adding a client on its own) and `NewJobSheet.tsx` (adding one inline
 * while booking a job) — extracted so the two stay identical rather than
 * drifting if either is tweaked later.
 *
 * In the order a caller gives them (C11): who they are, then their phone and
 * email, then the address. The number is the first thing they give, and
 * whether they are already a client needs no address.
 *
 * The address, phone and email are checked as they go in, and again at Save
 * when the form is inside a SaveWarningsProvider (both sheets are): anything
 * that may be wrong but might be right is listed above the button, never
 * refused.
 *
 * With `matchLine`, leaving Name, Phone or Email for another field says who
 * already has what was typed there, under it (lib/clientMatchRows.ts
 * `blurLine`), until that field is changed. Only on moving to another field:
 * a tap on Book or a fix moves focus nowhere on iOS, so nothing is put in
 * above a button being pressed. The field moved to stays where it was on
 * screen as the line goes in above it, and the line's fixes take no tap for
 * the moment it comes in (`useMatchLines`). Left before `matchLine` is
 * given (the client list not read yet), a field's line comes once it is.
 */
export function NewClientFields({
  value,
  onChange,
  businessState,
  idPrefix,
  matchLine,
}: {
  value: NewClientFieldsValue
  onChange: (patch: Partial<NewClientFieldsValue>) => void
  /** The business's own state (the route context's): its addresses are
   * suggested first, one in another state is pointed out, and a phone number
   * missing its area code most likely has this state's. */
  businessState: string
  /** Ids for the fields a caller puts focus in (`newClientFieldId`). */
  idPrefix?: string
  /** Who already has what was typed in a field, decided as it is left.
   * Left out until there is a client list to decide it from. */
  matchLine?: (
    field: NewClientMatchField,
    value: NewClientFieldsValue,
  ) => NewClientMatchLine | null
}) {
  const kindId = useId()
  const abnId = useId()
  const ownId = useId()
  const prefix = idPrefix ?? ownId
  const nameId = newClientFieldId(prefix, 'clientName')
  const phoneId = newClientFieldId(prefix, 'phone')
  const emailId = newClientFieldId(prefix, 'email')
  const business = value.kind === 'business'
  // Each field's line, shown while the field holds what it was decided
  // for: the same number, email or name, however it is written.
  const areaCode = areaCodeOf(businessState)
  const lines = useMatchLines(
    value,
    matchLine && ((field, now) => matchLine(field, { ...value, ...now })),
    (field, typed) => matchKeyOf(field, typed, areaCode),
  )
  const leaving =
    (field: NewClientMatchField) => (event: FocusEvent<HTMLElement>) => {
      if (!movesToAnotherField(event.relatedTarget, event.currentTarget)) {
        return
      }
      lines.leaving(field, event.relatedTarget)
    }
  const changing = (field: NewClientMatchField, next: string) => {
    lines.changing(field, next)
    onChange({ [field]: next })
  }
  const nameLine = lines.lineOf('clientName')
  const phoneLine = lines.lineOf('phone')
  const emailLine = lines.lineOf('email')
  const lineId = (id: string) => `${id}-match`
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
      {/* Not a Field: its <label> would name only the first segment. */}
      <div className="mt-4 flex flex-col gap-1.5">
        <span id={kindId} className="section-label">
          Client type
        </span>
        <Segmented
          kind="choice"
          labelledBy={kindId}
          value={value.kind}
          onChange={(kind) => onChange({ kind })}
          options={KIND_CHOICES}
        />
      </div>

      <Field label={business ? 'Company name' : 'Client name'}>
        <Input
          id={nameId}
          value={value.clientName}
          onChange={(clientName) => changing('clientName', clientName)}
          onBlur={leaving('clientName')}
          describedBy={nameLine ? lineId(nameId) : undefined}
          required
        />
      </Field>
      {/* Outside the <label>, which would take it into the field's name. */}
      {nameLine && <MatchLineMessage id={lineId(nameId)} line={nameLine} />}
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

      {/* The same labels as the client sheet's edit form: a business's phone
          and email are head office's, not whoever is on site. FormField, not
          Field: these render their own error and warning lines, which inside
          a <label> would become part of the field's name. */}
      <FormField
        id={phoneId}
        label={business ? 'Main phone (optional)' : 'Phone (optional)'}
        className="mt-4"
      >
        <div onBlur={leaving('phone')}>
          <PhoneInput
            id={phoneId}
            value={value.phone}
            onChange={(phone) => changing('phone', phone)}
            businessState={businessState}
            size="lg"
            describedBy={phoneLine ? lineId(phoneId) : undefined}
          />
        </div>
        {phoneLine && (
          <MatchLineMessage id={lineId(phoneId)} line={phoneLine} />
        )}
      </FormField>
      <FormField
        id={emailId}
        label={business ? 'Main email (optional)' : 'Email (optional)'}
        className="mt-4"
      >
        <div onBlur={leaving('email')}>
          <EmailInput
            id={emailId}
            value={value.email}
            onChange={(email) => changing('email', email)}
            size="lg"
            describedBy={emailLine ? lineId(emailId) : undefined}
          />
        </div>
        {emailLine && (
          <MatchLineMessage id={lineId(emailId)} line={emailLine} />
        )}
      </FormField>

      {business && (
        <Field label="Contact person (optional)">
          <Input
            value={value.contactPerson}
            onChange={(contactPerson) => onChange({ contactPerson })}
          />
        </Field>
      )}

      <SiteAddressFields
        value={value}
        onChange={onChange}
        businessState={businessState}
        idPrefix={prefix}
      />

      {business && (
        <>
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
                // ring and no keyboard (see "Add work order").
                flushSync(() => setAddingSiteContact(true))
                siteContactInput.current?.focus()
              }}
              className="relative tap-target mt-3 inline-flex items-center gap-1 text-body font-semibold text-blue"
            >
              <Plus size={16} strokeWidth={2.2} />
              Add site contact
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
  idPrefix,
}: {
  value: Pick<
    NewSiteValue,
    'addressLine' | 'suburb' | 'state' | 'postcode' | 'addressCheck'
  >
  onChange: (patch: Partial<NewSiteValue>) => void
  /** The work area: an address in another state is pointed out. */
  businessState: string
  /** The inputs' ids' start (VerifiedAddressFields'): the street is
   * `${idPrefix}-street`. */
  idPrefix?: string
}) {
  const ownId = useId()
  return (
    <VerifiedAddressFields
      idPrefix={idPrefix ?? ownId}
      value={value}
      onChange={onChange}
      workState={businessState}
      onCheckChange={(addressCheck) => onChange({ addressCheck })}
      // Picked in another client mode's block and carried here (a fix in
      // New Job): still the suggestion picked, until it is changed.
      picked={value.addressCheck === 'picked'}
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

/** Who already has what was typed, under the field it was typed in. */
function MatchLineMessage({
  id,
  line,
}: {
  id: string
  line: NewClientMatchLine
}) {
  return (
    <FieldMessage id={id} tone="status" fix={line.fix} fix2={line.fix2}>
      {line.text}
    </FieldMessage>
  )
}

function Input({
  id,
  value,
  onChange,
  onBlur,
  describedBy,
  required,
  inputRef,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void
  describedBy?: string
  required?: boolean
  inputRef?: Ref<HTMLInputElement>
}) {
  return (
    <input
      id={id}
      ref={inputRef}
      type="text"
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      aria-describedby={describedBy}
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
