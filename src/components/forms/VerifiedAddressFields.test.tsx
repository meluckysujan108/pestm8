import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { VerifiedAddressFields } from './VerifiedAddressFields'
import { SiteAddressFields } from '#/components/clients/NewClientFields'

/**
 * An address picked from the suggestions in one client mode's block, and
 * carried to another's by a fix in New Job (the matching plan's M3): still
 * the suggestion picked, so it says "Street found", is sent as picked, and
 * isn't looked up on the map again at Book.
 */

const PICKED = {
  addressLine: '40 Coode St',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
}

function draw(picked?: boolean) {
  return renderToStaticMarkup(
    <VerifiedAddressFields
      idPrefix="site"
      value={PICKED}
      onChange={() => {}}
      workState="WA"
      picked={picked}
    />,
  )
}

describe('VerifiedAddressFields drawn with an address already picked', () => {
  test('is still picked: Street found, as under the block it was picked in', () => {
    expect(draw(true)).toContain('Street found')
  })

  test('typed, or not said to be picked, it is not', () => {
    expect(draw(false)).not.toContain('Street found')
    expect(draw()).not.toContain('Street found')
  })
})

describe('SiteAddressFields, the block New Job draws', () => {
  test('takes it as picked from the draft it is given (`addressCheck`)', () => {
    const drawSite = (addressCheck: 'picked' | 'typed') =>
      renderToStaticMarkup(
        <SiteAddressFields
          value={{ ...PICKED, addressCheck }}
          onChange={() => {}}
          businessState="WA"
          idPrefix="site"
        />,
      )
    expect(drawSite('picked')).toContain('Street found')
    expect(drawSite('typed')).not.toContain('Street found')
  })
})
