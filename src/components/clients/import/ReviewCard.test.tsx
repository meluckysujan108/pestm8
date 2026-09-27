import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { statusOf } from '#/lib/clientImport/convert'
import { ReviewCard } from './ReviewCard'
import type { Id } from '../../../../convex/_generated/dataModel'
import type {
  ReviewClient,
  ReviewIssue,
  ReviewSite,
} from '#/lib/clientImport/types'

/**
 * One card of the review, rendered: what it says about a client already
 * here, how its buttons are named, and how it keeps a client with a great
 * many sites or issues to a card's length.
 */

const site = (n: number, over: Partial<ReviewSite> = {}): ReviewSite => ({
  addressLine: `${n} Wattle St`,
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
  ...over,
})

function client(over: Partial<ReviewClient> = {}): ReviewClient {
  return {
    key: 'c1',
    rowNumbers: [1],
    kind: 'person',
    name: 'Jo Smith',
    sites: [site(12)],
    issues: [],
    included: true,
    ...over,
  }
}

function render(c: ReviewClient) {
  return renderToStaticMarkup(
    <ReviewCard
      client={c}
      status={statusOf(c)}
      hydrated
      onEdit={() => {}}
      onToggle={() => {}}
      onFix={() => {}}
    />,
  )
}

const text = (html: string) => html.replace(/<[^>]+>/g, '')

describe('ReviewCard', () => {
  const existing = 'k1' as Id<'clients'>

  it('says a client adds to one already here only when something is added', () => {
    const adding = render(
      client({
        existingClientId: existing,
        sites: [site(12, { duplicate: true }), site(14)],
      }),
    )
    expect(adding).toContain('Adds to an existing client')

    const nothingNew = render(
      client({
        existingClientId: existing,
        sites: [site(12, { duplicate: true })],
      }),
    )
    expect(nothingNew).not.toContain('Adds to an existing client')
    expect(nothingNew).toContain('Already a client in PestM8')
  })

  it('names the client on Leave out and Include, as on Edit', () => {
    expect(render(client())).toContain('aria-label="Leave out Jo Smith"')
    expect(render(client({ included: false }))).toContain(
      'aria-label="Include Jo Smith"',
    )
    expect(render(client({ name: '' }))).toContain(
      'aria-label="Leave out this client"',
    )
  })

  it('puts a one-tap fix straight after what it fixes', () => {
    const html = render(
      client({
        email: 'pete@gmial.com',
        issues: [
          {
            level: 'warning',
            field: 'email',
            message: 'Email pete@gmial.com: did you mean pete@gmail.com?',
            fix: { label: 'Use pete@gmail.com', apply: (c) => c },
          },
        ],
      }),
    )
    expect(text(html)).toContain(
      'did you mean pete@gmail.com? Use pete@gmail.com',
    )
  })

  it('shows a person no contact person or site contact, a business both', () => {
    const withContacts = {
      contactPerson: 'Mia Chen',
      sites: [site(12, { siteContactName: 'Col', siteContactPhone: '0433' })],
    }
    const person = text(render(client(withContacts)))
    expect(person).not.toContain('Mia Chen')
    expect(person).not.toContain('Site contact')
    const business = text(render(client({ ...withContacts, kind: 'business' })))
    expect(business).toContain('Mia Chen')
    expect(business).toContain('Site contact: Col, 0433')
  })

  it('shows five of a great many sites, and offers the rest', () => {
    const html = render(
      client({ sites: Array.from({ length: 300 }, (_, i) => site(i + 1)) }),
    )
    expect(html).toContain('5 Wattle St')
    expect(html).not.toContain('6 Wattle St')
    expect(html).toContain('Show all 300 sites')
  })

  it('shows eight of a great many issues, errors first, and counts the rest', () => {
    const warnings: Array<ReviewIssue> = Array.from({ length: 11 }, (_, i) => ({
      level: 'warning',
      field: 'postcode',
      siteIndex: i,
      message: `Warning ${i + 1}.`,
    }))
    const html = render(
      client({
        sites: Array.from({ length: 12 }, (_, i) => site(i + 1)),
        issues: [
          ...warnings,
          { level: 'error', field: 'name', message: 'The name is too long.' },
        ],
      }),
    )
    expect(html).toContain('The name is too long.')
    expect(html).toContain('Warning 7.')
    expect(html).not.toContain('Warning 8.')
    expect(html).toContain('Show 4 more')
  })
})
