import { useId } from 'react'
import { FormField } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import { VerifiedAddressFields } from '#/components/forms/VerifiedAddressFields'
import type { AddressCheck } from '#/components/forms/VerifiedAddressFields'
import { TextInput } from '#/components/clients/clientFormFields'
import type { ClientKind } from '#/lib/clientFilters'

export type PropertyFieldsValue = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
}

/**
 * One property's address, and its site contact for a business client — the
 * same fields for editing a property and adding another, so the two cannot
 * drift. In the client sheet's small card, placeholders stand in for
 * labels, so each field is also named by an aria-label. A whole-sheet form
 * (the job sheet's Edit → Property details) gives them visible labels, since
 * a filled field has no placeholder left to name it.
 *
 * The address is VerifiedAddressFields: checked as it goes in and again at
 * Save, against the business's own state. `initial` is what the property has
 * saved, when editing one: left as it is, nothing in it is refused or looked
 * up again. Must sit inside a SaveWarningsProvider for the checks at Save.
 */
export function PropertyFields({
  value,
  onChange,
  initial,
  clientKind,
  businessState,
  onCheckChange,
  picked,
  labels = 'placeholders',
}: {
  value: PropertyFieldsValue
  onChange: (patch: Partial<PropertyFieldsValue>) => void
  initial?: PropertyFieldsValue
  clientKind: ClientKind
  businessState: string
  /** How the address came to be, for the mutation's `addressCheck`. */
  onCheckChange: (check: AddressCheck) => void
  /** The address is a suggestion picked before this was drawn (in Clients
   * → New client): still picked, until it is changed. */
  picked?: boolean
  labels?: 'visible' | 'placeholders'
}) {
  const id = useId()
  const nameId = `${id}-site-name`
  const phoneId = `${id}-site-phone`
  return (
    <>
      <VerifiedAddressFields
        idPrefix={id}
        value={value}
        onChange={onChange}
        workState={businessState}
        initial={initial}
        size="md"
        labels={labels}
        onCheckChange={onCheckChange}
        picked={picked}
      />
      {clientKind === 'business' &&
        (labels === 'visible' ? (
          // Spaced as VerifiedAddressFields spaces its labelled fields.
          <>
            <FormField
              id={nameId}
              label="Site contact name (optional)"
              size="md"
              className="mt-4"
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  value={value.siteContactName}
                  onChange={(e) =>
                    onChange({ siteContactName: e.target.value })
                  }
                />
              )}
            </FormField>
            <FormField
              id={phoneId}
              label="Site contact number (optional)"
              size="md"
              className="mt-4"
            >
              <PhoneInput
                id={phoneId}
                value={value.siteContactPhone}
                onChange={(siteContactPhone) => onChange({ siteContactPhone })}
                initial={initial?.siteContactPhone}
                businessState={businessState}
                size="md"
                name="Site contact number"
              />
            </FormField>
          </>
        ) : (
          <>
            <TextInput
              value={value.siteContactName}
              onChange={(siteContactName) => onChange({ siteContactName })}
              placeholder="Site contact name"
              ariaLabel="Site contact name"
            />
            {/* In a box of its own, so its message lines sit under it rather
                than a card's gap away. */}
            <div>
              <PhoneInput
                id={phoneId}
                value={value.siteContactPhone}
                onChange={(siteContactPhone) => onChange({ siteContactPhone })}
                initial={initial?.siteContactPhone}
                businessState={businessState}
                size="md"
                placeholder="Site contact number"
                ariaLabel="Site contact number"
                name="Site contact number"
              />
            </div>
          </>
        ))}
    </>
  )
}
