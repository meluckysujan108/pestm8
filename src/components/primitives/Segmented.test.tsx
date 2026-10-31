import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Segmented } from './Segmented'

/**
 * Where a segmented control's names come from. New Job's first option was
 * "Client Client" to a screen reader and to Playwright: the sheet's `Field`
 * was a <label> around the group, and a label names its first control. Under
 * a caption the group is named by the caption's id, and every option by its
 * own words.
 */

type Mode = 'existing' | 'new'

const OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: 'existing', label: 'Existing client' },
  { value: 'new', label: 'New client' },
]

const noop = () => {}

/** The group's opening tag, and each option's opening tag and words. */
function read(html: string) {
  const group = /<div role="(?:radiogroup|tablist)"[^>]*>/.exec(html)?.[0]
  const options = [...html.matchAll(/(<button[^>]*>)([^<]*)<\/button>/g)].map(
    ([, tag, words]) => ({ tag, words }),
  )
  return { group, options }
}

describe('Segmented’s names', () => {
  test('under a caption, the caption names the group and each option says its own words', () => {
    const html = renderToStaticMarkup(
      <div>
        <span id="client-choice" className="section-label">
          Client
        </span>
        <Segmented
          kind="choice"
          labelledBy="client-choice"
          value="existing"
          onChange={noop}
          options={OPTIONS}
        />
      </div>,
    )
    const { group, options } = read(html)
    expect(group).toContain('role="radiogroup"')
    expect(group).toContain('aria-labelledby="client-choice"')
    expect(group).not.toContain('aria-label=')
    expect(html).not.toContain('<label')
    expect(options.map((o) => o.words)).toEqual([
      'Existing client',
      'New client',
    ])
    for (const { tag } of options) {
      expect(tag).toContain('role="radio"')
      expect(tag).not.toContain('aria-label')
    }
  })

  test('with nothing on screen to say it, its label names it', () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="View"
        value="day"
        onChange={noop}
        options={[
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' },
        ]}
      />,
    )
    const { group, options } = read(html)
    expect(group).toContain('role="tablist"')
    expect(group).toContain('aria-label="View"')
    expect(group).not.toContain('aria-labelledby')
    expect(options.map((o) => o.words)).toEqual(['Day', 'Week'])
  })

  test('takes its name from one place, never two', () => {
    const both = () => (
      // @ts-expect-error a caption's id or a label, not both
      <Segmented
        label="Client"
        labelledBy="client-choice"
        value="new"
        onChange={noop}
        options={OPTIONS}
      />
    )
    const neither = () => (
      // @ts-expect-error a group with no name at all
      <Segmented value="new" onChange={noop} options={OPTIONS} />
    )
    expect([both, neither]).toHaveLength(2)
  })
})
