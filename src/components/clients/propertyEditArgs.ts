import { changed } from '#/components/clients/clientEdits'
import {
  addressChanged,
  addressCheckToSend,
} from '#/components/forms/verifiedAddress'
import type { AddressCheck } from '#/components/forms/verifiedAddress'
import type { PropertyFieldsValue } from '#/components/clients/PropertyFields'
import type { Doc, Id } from '../../../convex/_generated/dataModel'

/**
 * A property's edit from the job sheet (PropertyEditMode), as the save sends
 * it. Here, with no React and nothing from lib/offline, so it is tested on
 * its own: the form reaches the kept copy's keeper, which a test can't load
 * without a deployment's address.
 */

type EditedProperty = Pick<
  Doc<'properties'>,
  | '_id'
  | 'addressLine'
  | 'suburb'
  | 'state'
  | 'postcode'
  | 'siteContactName'
  | 'siteContactPhone'
>

export type PropertyEditArgs = {
  businessId: Id<'businesses'>
  propertyId: Id<'properties'>
  addressLine?: string
  suburb?: string
  state?: string
  postcode?: string
  addressCheck?: AddressCheck
  siteContactName?: string
  siteContactPhone?: string
}

/** What the property has saved, in the form's fields. */
export function propertyFieldsOf(
  property: EditedProperty,
): PropertyFieldsValue {
  return {
    addressLine: property.addressLine,
    suburb: property.suburb,
    state: property.state,
    postcode: property.postcode,
    siteContactName: property.siteContactName ?? '',
    siteContactPhone: property.siteContactPhone ?? '',
  }
}

/**
 * Only what changed, so a save that changes nothing writes nothing, and an
 * edit the office made meanwhile to a field left alone here survives:
 * - the address as one, with how it came to be (`addressCheck`), when any
 *   part of it changed;
 * - the site contact's name and number each when changed, blank clearing
 *   it, and only for a business client: a homeowner's are hidden, so saving
 *   their address must leave them as they are.
 */
export function propertyEditArgs({
  businessId,
  property,
  value,
  addressCheck,
  clientKind,
}: {
  businessId: Id<'businesses'>
  property: EditedProperty
  value: PropertyFieldsValue
  addressCheck: AddressCheck
  clientKind: Doc<'clients'>['kind']
}): PropertyEditArgs {
  const saved = propertyFieldsOf(property)
  const check = addressCheckToSend(addressCheck, value, saved)
  return {
    businessId,
    propertyId: property._id,
    ...(addressChanged(value, saved) && {
      addressLine: value.addressLine,
      suburb: value.suburb,
      state: value.state,
      postcode: value.postcode,
      ...(check !== undefined && { addressCheck: check }),
    }),
    ...(clientKind === 'business' &&
      changed(value.siteContactName, property.siteContactName) && {
        siteContactName: value.siteContactName.trim(),
      }),
    ...(clientKind === 'business' &&
      changed(value.siteContactPhone, property.siteContactPhone) && {
        siteContactPhone: value.siteContactPhone.trim(),
      }),
  }
}
