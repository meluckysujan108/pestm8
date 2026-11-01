import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { EMPTY_NEW_CLIENT, NewClientFields } from './NewClientFields'
import type { NewClientFieldsValue } from './NewClientFields'

/**
 * New client in the order a caller gives it (C11): who they are, their
 * phone and email, then the address. The number is the first thing they
 * give, and whether they are a client already needs no address. One order
 * in New Job's New client tab and Clients → New client, which both draw
 * these fields.
 */

function labels(value: NewClientFieldsValue): Array<string> {
  const html = renderToStaticMarkup(
    <NewClientFields value={value} onChange={() => {}} businessState="WA" />,
  )
  return [...html.matchAll(/class="section-label"[^>]*>([^<]+)</g)].map(
    (m) => m[1],
  )
}

const order = (all: Array<string>, wanted: Array<string>) =>
  all.filter((label) => wanted.includes(label))

describe('the order of New client', () => {
  test('a person: name, phone, email, then the address', () => {
    expect(
      order(labels(EMPTY_NEW_CLIENT), [
        'Client name',
        'Phone (optional)',
        'Email (optional)',
        'Street address',
      ]),
    ).toEqual([
      'Client name',
      'Phone (optional)',
      'Email (optional)',
      'Street address',
    ])
  })

  test('a business: name, ABN, phone, email, contact person, then the address', () => {
    expect(
      order(labels({ ...EMPTY_NEW_CLIENT, kind: 'business' }), [
        'Company name',
        'ABN (optional)',
        'Main phone (optional)',
        'Main email (optional)',
        'Contact person (optional)',
        'Street address',
      ]),
    ).toEqual([
      'Company name',
      'ABN (optional)',
      'Main phone (optional)',
      'Main email (optional)',
      'Contact person (optional)',
      'Street address',
    ])
  })
})
