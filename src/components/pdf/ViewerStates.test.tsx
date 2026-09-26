import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ErrorState, PasswordState } from './ViewerStates'

/**
 * The password form, rendered. What a technician sees between pressing Open
 * and pdf.js answering is the same form, busy — not a "Loading PDF…" screen
 * that would take the field, and the keyboard, away.
 */

function render(props: { wrong: boolean; checking: boolean }) {
  return renderToStaticMarkup(
    <PasswordState {...props} onSubmit={() => {}} onCancel={() => {}} />,
  )
}

describe('PasswordState', () => {
  it('keeps the field while a password is checked, with Open busy', () => {
    const html = render({ wrong: false, checking: true })
    expect(html).toContain('aria-label="PDF password"')
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>.*Checking…/)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Loading PDF')
  })

  it('hides the last refusal while the next try is checked', () => {
    const html = render({ wrong: true, checking: true })
    expect(html).not.toContain('Wrong password')
    expect(html).not.toContain('aria-invalid')
  })

  it('says a refused password was wrong, on the same field', () => {
    const html = render({ wrong: true, checking: false })
    expect(html).toContain('Wrong password. Try again.')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="pdf-password-wrong"')
  })

  it('never disables the field itself, which would drop the keyboard', () => {
    for (const checking of [false, true]) {
      const input = /<input[^>]*>/.exec(render({ wrong: false, checking }))
      expect(input?.[0]).toBeDefined()
      // The attributes, not the words: the field's class carries a
      // `disabled:` style for when some other field is disabled.
      expect(input?.[0]).not.toMatch(/\sdisabled(?:=|\s|\/?>)/)
      expect(input?.[0]).not.toMatch(/\sreadonly(?:=|\s|\/?>)/i)
    }
  })
})

describe('ErrorState', () => {
  const error = (props: {
    reason: 'download' | 'damaged'
    detail: string | null
  }) => renderToStaticMarkup(<ErrorState {...props} onRetry={() => {}} />)

  it('says what the source said went wrong, rather than blaming the signal', () => {
    const html = error({
      reason: 'download',
      detail: 'Your latest answers haven’t saved yet.',
    })
    expect(html).toContain('Your latest answers haven’t saved yet.')
    expect(html).not.toContain('Check your signal')
    expect(html).toContain('Try again')
  })

  it('falls back to its own sentence when the source said nothing useful', () => {
    expect(error({ reason: 'download', detail: null })).toContain(
      'Check your signal and try again.',
    )
    expect(error({ reason: 'damaged', detail: null })).toContain(
      'The file may be damaged, or not a PDF.',
    )
  })
})
