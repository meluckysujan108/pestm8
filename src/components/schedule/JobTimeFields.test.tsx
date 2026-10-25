import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { JobTimeFields, useJobTimes } from './JobTimeFields'

const PERTH = 'Australia/Perth'
/** A Monday. */
const DAY = '2026-10-26'

function Times({
  start,
  end,
  length,
  dayKey = DAY,
}: {
  start: string
  end: string
  length: number
  dayKey?: string
}) {
  const times = useJobTimes({ start, end, length })
  return (
    <JobTimeFields
      times={times}
      dayKey={dayKey}
      timezone={PERTH}
      idPrefix="test"
    />
  )
}

const render = (props: Parameters<typeof Times>[0]) =>
  renderToStaticMarkup(<Times {...props} />)

describe('a job’s start and end, as a form opens on them', () => {
  test('say the job back as its card will', () => {
    const html = render({ start: '09:00', end: '10:00', length: 60 })
    expect(html).toContain('9:00am – 10:00am · 1 hr')
    expect(html).not.toContain('Choose')
  })

  test('a job that already runs past midnight opens as it is, not refused', () => {
    // Booked as minutes before there was an end to pick: its end reads
    // before its start, and it is left alone unless the times are changed.
    const html = render({ start: '22:00', end: '01:00', length: 180 })
    expect(html).toContain('10:00pm – Tue 1:00am · 3 hr')
    expect(html).not.toContain('Choose')
    expect(html).not.toContain('aria-invalid')
  })

  test('with the date cleared, the length alone', () => {
    const html = render({
      start: '08:00',
      end: '12:30',
      length: 270,
      dayKey: '',
    })
    expect(html).toContain('>4 hr 30 min<')
  })

  test('each time is read with what is said under them', () => {
    const html = render({ start: '09:00', end: '10:00', length: 60 })
    expect(html.match(/aria-describedby="test-times"/g)).toHaveLength(2)
    expect(html).toContain('id="test-times"')
  })
})
