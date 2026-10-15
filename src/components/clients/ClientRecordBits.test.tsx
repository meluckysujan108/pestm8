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

  it('shows an active client’s status too, and nothing for no number or tags', () => {
    // The status is always seen, as a job's is: a client saved before
    // statuses existed is Active.
    const html = card({ _id: 'c1', name: 'Alan Vilay', kind: 'person' })
    expect(html).toContain('Active')
    expect(html).not.toContain('#')
  })

  it('says “50+ properties” when the page held only a client’s newest 50', () => {
    // `clients.page` reads a client's newest 50 live sites and says when
    // there were more: the card must not claim 50 is all of them.
    const sites = Array.from({ length: 50 }, (_, i) => ({
      addressLine: `${i + 1} Hay St`,
      suburb: i % 2 ? 'Subiaco' : 'Perth',
    }))
    const render = (propertiesCapped?: boolean) =>
      renderToStaticMarkup(
        <ClientCard
          client={{ _id: 'c1', name: 'Harbourside Strata', kind: 'business' }}
          properties={sites}
          propertiesCapped={propertiesCapped}
          onOpen={() => {}}
        />,
      )
    expect(render(true)).toContain('50+ properties')
    expect(render()).toContain('50 properties')
    expect(render()).not.toContain('50+')

    // One site shown and more behind it is a count, not that site's street.
    const one = renderToStaticMarkup(
      <ClientCard
        client={{ _id: 'c1', name: 'Harbourside Strata', kind: 'business' }}
        properties={[sites[0]]}
        propertiesCapped
        onOpen={() => {}}
      />,
    )
    expect(one).toContain('1+ properties')
    expect(one).not.toContain('1 Hay St')
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
