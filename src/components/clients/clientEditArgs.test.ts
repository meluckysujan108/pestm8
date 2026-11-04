// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { clientEditArgs } from './clientEditArgs'
import type { ClientEditBase, ClientEditValue } from './clientEditArgs'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * What a client's edit saves: the client sheet's Edit and the job sheet's
 * Edit → Client details. Only this module, never ClientEditForm.tsx: that
 * reaches the kept copy's keeper, which a test can't load without a
 * deployment's address (and CI has none).
 */

const businessId = 'b1' as Id<'businesses'>
const ids = { businessId, clientId: 'c1' as Id<'clients'> }

const person: ClientEditBase = {
  _id: ids.clientId,
  kind: 'person',
  name: 'J. Nguyen',
  phone: '0412 345 678',
  email: 'jan@nguyen.test',
  clientNumber: 1916,
  tags: ['Real estate'],
}

const business: ClientEditBase = {
  _id: ids.clientId,
  kind: 'business',
  name: 'Mahal Mart',
  phone: '08 9000 1111',
  addressLine: '14 Kewdale Road',
  suburb: 'Welshpool',
  state: 'WA',
  postcode: '6106',
  abn: '51824753556',
  clientNumber: 1917,
}

/** The fields as the form opens them on `client`. */
function opened(client: ClientEditBase, contactPerson = ''): ClientEditValue {
  return {
    kind: client.kind,
    name: client.name,
    phone: client.phone ?? '',
    email: client.email ?? '',
    address: {
      addressLine: client.addressLine ?? '',
      suburb: client.suburb ?? '',
      state: client.state ?? '',
      postcode: client.postcode ?? '',
    },
    abn: client.abn ?? '',
    contactPerson,
    tags: client.tags ?? [],
    clientNumber: client.clientNumber ?? null,
  }
}

function args(
  client: ClientEditBase,
  patch: Partial<ClientEditValue>,
  {
    canRenumber = false,
    contactPersonBefore = '',
  }: { canRenumber?: boolean; contactPersonBefore?: string } = {},
) {
  return clientEditArgs({
    businessId,
    client,
    value: { ...opened(client, contactPersonBefore), ...patch },
    contactPersonBefore,
    canRenumber,
  })
}

describe('a client’s edit sends', () => {
  test('only its ids when nothing changed, so nothing is written', () => {
    expect(args(person, {})).toEqual(ids)
    expect(args(business, {}, { contactPersonBefore: 'Jan Morris' })).toEqual(
      ids,
    )
    // Spaces typed around a value are not a change.
    expect(
      args(person, { name: ' J. Nguyen ', phone: '0412 345 678 ' }),
    ).toEqual(ids)
  })

  test('the type and name only when changed, so a rename made meanwhile by the office is not put back', () => {
    // The phone alone: the name and type the form opened with stay unsent.
    expect(args(person, { phone: '0499 111 222' })).toEqual({
      ...ids,
      phone: '0499 111 222',
    })
    expect(args(person, { name: 'Jenny Nguyen' })).toEqual({
      ...ids,
      name: 'Jenny Nguyen',
    })
    expect(args(person, { kind: 'business' })).toEqual({
      ...ids,
      kind: 'business',
    })
  })

  test('a blank phone or email, which clears it', () => {
    expect(args(person, { phone: '', email: '' })).toEqual({
      ...ids,
      phone: '',
      email: '',
    })
  })

  test('the number only for the owner, and only when it is a new one', () => {
    expect(args(person, { clientNumber: 77 })).toEqual(ids)
    expect(args(person, { clientNumber: 77 }, { canRenumber: true })).toEqual({
      ...ids,
      clientNumber: 77,
    })
    expect(args(person, { clientNumber: null }, { canRenumber: true })).toEqual(
      ids,
    )
  })

  test('a business’s address, ABN and contact person, each only when changed', () => {
    expect(
      args(
        business,
        {
          address: {
            ...opened(business).address,
            addressLine: '14A Kewdale Road',
          },
          abn: '51 824 753 556',
        },
        { contactPersonBefore: 'Jan Morris' },
      ),
    ).toEqual({ ...ids, addressLine: '14A Kewdale Road' })
    expect(
      args(
        business,
        { contactPerson: 'Priya Shah' },
        { contactPersonBefore: 'Jan Morris' },
      ),
    ).toEqual({ ...ids, contactPerson: 'Priya Shah' })
    // Blank takes the star off.
    expect(
      args(
        business,
        { contactPerson: '' },
        { contactPersonBefore: 'Jan Morris' },
      ),
    ).toEqual({ ...ids, contactPerson: '' })
  })

  test('a lone state, with no street, suburb or postcode, cleared', () => {
    const loneState = {
      ...business,
      addressLine: undefined,
      suburb: undefined,
      postcode: undefined,
      state: 'ACT',
    }
    expect(args(loneState, {})).toEqual({ ...ids, state: '' })
  })

  test('none of a business’s own fields once made a homeowner: hidden, not wiped', () => {
    expect(
      args(
        business,
        {
          kind: 'person',
          address: { addressLine: '', suburb: '', state: '', postcode: '' },
          abn: '',
          contactPerson: '',
        },
        { contactPersonBefore: 'Jan Morris' },
      ),
    ).toEqual({ ...ids, kind: 'person' })
  })

  test('a homeowner made a business with their hidden contact person back in the field: nothing about them', () => {
    expect(
      args(
        person,
        { kind: 'business', contactPerson: 'Jan Morris' },
        { contactPersonBefore: 'Jan Morris' },
      ),
    ).toEqual({ ...ids, kind: 'business' })
  })
})
