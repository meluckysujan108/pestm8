import { describe, expect, it } from 'vitest'
import { reportTextChanges } from './reportChanges'

const untouched = { title: null, copy: null }

describe('the report settings form', () => {
  it('sends nothing for fields nobody touched', () => {
    expect(
      reportTextChanges(
        untouched,
        { reportBrandName: 'Pest M8', reportCopyEmail: 'a@b.com' },
        'Pest M8 Pty Ltd',
      ),
    ).toEqual({})
  })

  it('sends nothing for a value typed back as it was', () => {
    expect(
      reportTextChanges(
        { title: 'Pest M8 ', copy: ' a@b.com' },
        { reportBrandName: 'Pest M8', reportCopyEmail: 'a@b.com' },
        'Pest M8 Pty Ltd',
      ),
    ).toEqual({})
  })

  it('sends a new title trimmed, and a new copy address as typed', () => {
    expect(
      reportTextChanges(
        { title: '  Coastal Pest ', copy: 'Office@Coastal.test' },
        {},
        'Coastal Pest Pty Ltd',
      ),
    ).toEqual({
      reportBrandName: 'Coastal Pest',
      reportCopyEmail: 'Office@Coastal.test',
    })
  })

  it('clears the copy address with a blank, which the server removes', () => {
    expect(
      reportTextChanges(
        { title: null, copy: '  ' },
        { reportCopyEmail: 'a@b.com' },
        'Pest M8 Pty Ltd',
      ),
    ).toEqual({ reportCopyEmail: '  ' })
  })

  it('never writes an empty title: blank writes the name it falls back to', () => {
    // The trading name first, as the title band reads it.
    expect(
      reportTextChanges(
        { title: '', copy: null },
        { reportBrandName: 'Old brand', tradingName: 'Pest M8 South' },
        'Pest M8 Pty Ltd',
      ),
    ).toEqual({ reportBrandName: 'Pest M8 South' })
    // Then the business's own name.
    expect(
      reportTextChanges(
        { title: ' ', copy: null },
        { reportBrandName: 'Old brand' },
        'Pest M8 Pty Ltd',
      ),
    ).toEqual({ reportBrandName: 'Pest M8 Pty Ltd' })
  })

  it('leaves a blank title alone when there was none to clear', () => {
    expect(
      reportTextChanges({ title: '', copy: null }, {}, 'Pest M8 Pty Ltd'),
    ).toEqual({})
    // Nor when the saved title is already the name it would fall back to.
    expect(
      reportTextChanges(
        { title: '', copy: null },
        { reportBrandName: 'Pest M8 Pty Ltd' },
        'Pest M8 Pty Ltd',
      ),
    ).toEqual({})
  })
})
