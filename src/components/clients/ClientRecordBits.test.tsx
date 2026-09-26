import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClientCard } from './ClientCard'
import { addTags, tagsInUse } from './ClientRecordBits'

/**
 * A client's number, status and tags on its card, and the rules the tag box
 * adds by.
 */

const card = (client: Parameters<typeof ClientCard>[0]['client']) =>
  renderToStaticMarkup(
    <ClientCard
      client={client}
      properties={[{ addressLine: '6 Trinity Close', suburb: 'Canning Vale' }]}
      onOpen={() => {}}
    />,
  )

describe('the client card', () => {
  it('shows the number, a lead, and the first three tags', () => {
    const html = card({
      _id: 'c1',
      name: 'Alan Vilay',
      kind: 'person',
      clientNumber: 1928,
      status: 'lead',
      tags: ['GPC', 'Rodents', 'Ants', 'Spiders'],
    })
    expect(html).toContain('#1928')
    expect(html).toContain('Lead')
    expect(html).toContain('GPC')
    expect(html).toContain('Ants')
    expect(html).not.toContain('Spiders')
    expect(html).toContain('+1')
  })

  it('says nothing of an active client’s status, or of no number or tags', () => {
    const html = card({ _id: 'c1', name: 'Alan Vilay', kind: 'person' })
    expect(html).not.toContain('Active')
    expect(html).not.toContain('#')
  })
})

describe('adding tags', () => {
  it('adds several at once, once each whatever the capitals', () => {
    expect(addTags(['GPC'], 'gpc, Real estate ,  Rodents')).toEqual([
      'GPC',
      'Real estate',
      'Rodents',
    ])
  })

  it('stops at twenty, and cuts one that is too long', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`)
    expect(addTags(twenty, 'one more')).toHaveLength(20)
    expect(addTags([], 'x'.repeat(50))).toEqual(['x'.repeat(40)])
  })

  it('lists a business’s tags, the most used first', () => {
    expect(
      tagsInUse([{ tags: ['GPC', 'Rodents'] }, { tags: ['gpc'] }, {}]),
    ).toEqual([
      { tag: 'GPC', count: 2 },
      { tag: 'Rodents', count: 1 },
    ])
  })
})
