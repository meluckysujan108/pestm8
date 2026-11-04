import { useId } from 'react'
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
 * drift. Placeholders stand in for labels in this small card, so each field
 * is also named by an aria-label.
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
}) {
  const id = useId()
  return (
    <>
      <VerifiedAddressFields
        idPrefix={id}
        value={value}
        onChange={onChange}
        workState={businessState}
        initial={initial}
        size="md"
        labels="placeholders"
        onCheckChange={onCheckChange}
        picked={picked}
      />
      {clientKind === 'business' && (
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
              id={`${id}-site-phone`}
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
      )}
    </>
  )
}
