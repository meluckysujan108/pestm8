import { abnDigits } from '../../../convex/lib/abn'
import { edited } from '#/components/clients/clientEdits'
import type { Id } from '../../../convex/_generated/dataModel'
import type { AddressValue } from '#/lib/addressVerify'
import type { ClientKind } from '#/lib/clientFilters'

/**
 * What a client's edit sends (`clients.update`): the client sheet's Edit and
 * the job sheet's Edit → Client details. Pure, so it is tested without the
 * form, which reaches the kept copy's keeper.
 */

export type ClientEditArgs = {
  businessId: Id<'businesses'>
  clientId: Id<'clients'>
  kind?: ClientKind
  name?: string
  phone?: string
  email?: string
  addressLine?: string
  suburb?: string
  state?: string
  postcode?: string
  abn?: string
  contactPerson?: string
  tags?: Array<string>
  clientNumber?: number
}

/** The client as the form opened it: what a field is compared with. */
export type ClientEditBase = {
  _id: Id<'clients'>
  kind: ClientKind
  name: string
  phone?: string
  email?: string
  addressLine?: string
  suburb?: string
  state?: string
  postcode?: string
  abn?: string
  clientNumber?: number
  tags?: Array<string>
}

/** What is in the fields. */
export type ClientEditValue = {
  kind: ClientKind
  name: string
  phone: string
  email: string
  address: AddressValue
  abn: string
  contactPerson: string
  tags: Array<string>
  /** The number typed, read as a number; null when it isn't one. */
  clientNumber: number | null
}

export function clientEditArgs({
  businessId,
  client,
  value,
  contactPersonBefore,
  canRenumber,
}: {
  businessId: Id<'businesses'>
  client: ClientEditBase
  value: ClientEditValue
  /** The contact person the field opened with, '' for none. */
  contactPersonBefore: string
  /** The owner, who alone may change the client number. */
  canRenumber: boolean
}): ClientEditArgs {
  const { kind, name, phone, email, address, abn, contactPerson, tags } = value
  const hasAddress = [
    address.addressLine,
    address.suburb,
    address.postcode,
  ].some((part) => part.trim() !== '')
  return {
    businessId,
    clientId: client._id,
    // Each only when changed, and blank clears it (clients.update).
    // Untouched fields are left out, so a save that changes nothing
    // writes nothing, and a field the office changed meanwhile, left alone
    // here, is not put back. The type and name too: they were always sent.
    ...(kind !== client.kind && { kind }),
    ...(name.trim() !== client.name.trim() && { name }),
    ...edited('phone', phone, client.phone),
    ...edited('email', email, client.email),
    ...(tags.join('\n') !== (client.tags ?? []).join('\n') && { tags }),
    // The owner's alone to change (clients.update refuses anyone else).
    ...(canRenumber &&
      value.clientNumber !== null &&
      value.clientNumber !== client.clientNumber && {
        clientNumber: value.clientNumber,
      }),
    // Omitted (not cleared) when kind isn't business: `clients.update`
    // skips undefined args, so toggling to person just stops showing
    // the address rather than wiping it — same "hidden, not deleted"
    // treatment as clientContacts when kind flips away from business.
    // The ABN and contact person are left alone the same way.
    ...(kind === 'business' && {
      ...edited('addressLine', address.addressLine, client.addressLine),
      ...edited('suburb', address.suburb, client.suburb),
      // A state on its own is not an address: with no street, suburb
      // or postcode it is cleared, which also mends a lone "ACT".
      ...edited('state', hasAddress ? address.state : '', client.state),
      ...edited('postcode', address.postcode, client.postcode),
      ...((abnDigits(abn) ?? abn.trim()) !== (client.abn ?? '') && {
        abn: abn.trim(),
      }),
      // The server makes the name the primary contact, and blank takes
      // the star off (nobody is deleted).
      ...edited('contactPerson', contactPerson, contactPersonBefore),
    }),
  }
}
