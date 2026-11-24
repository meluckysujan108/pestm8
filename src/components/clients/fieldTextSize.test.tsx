import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AbnInput } from './AbnInput'
import { AddressLookupInput } from './AddressLookupInput'

/**
 * Under 16px, iOS zooms the whole page into a field as it is tapped and
 * stays zoomed once the keyboard is put away. The client edit form's ABN
 * and address (size md) were 15px, and did (iOS 27.2, 23 Nov 2026).
 */
const inputClass = (html: string) =>
  /<input[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''

describe('the client fields are 16px at every size', () => {
  for (const size of ['lg', 'md'] as const) {
    it(`ABN, ${size}`, () => {
      const html = renderToStaticMarkup(
        <AbnInput id="abn" value="" onChange={() => {}} size={size} />,
      )
      expect(inputClass(html)).toContain('text-[16px]')
      expect(inputClass(html)).not.toContain('text-body')
    })

    it(`street address, ${size}`, () => {
      const html = renderToStaticMarkup(
        <AddressLookupInput
          id="address"
          value=""
          onChange={() => {}}
          onPick={() => {}}
          size={size}
        />,
      )
      expect(inputClass(html)).toContain('text-[16px]')
      expect(inputClass(html)).not.toContain('text-body')
    })
  }
})
