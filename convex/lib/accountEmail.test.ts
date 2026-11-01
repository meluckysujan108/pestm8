import { describe, expect, test } from 'vitest'
import {
  emailWhen,
  memberXeroConnectedEmail,
  xeroConnectedEmail,
} from './accountEmail'

/**
 * The "Xero connected" emails (1 Nov 2026): connecting Xero needs no two-step
 * sign-in, so these are how someone hears that their account sent the client
 * book somewhere. The connect itself is tested in convex/xeroConnect.test.ts.
 */

const PERTH = 'Australia/Perth'

describe('emailWhen', () => {
  test('says when as the app does, in the business’s time zone', () => {
    // 08:12 UTC is 4:12pm in Perth (UTC+8, no daylight saving).
    expect(emailWhen(Date.UTC(2026, 10, 1, 8, 12), PERTH)).toBe(
      'Sun 1 Nov, 4:12pm',
    )
    expect(emailWhen(Date.UTC(2026, 10, 1, 8, 12), 'Australia/Sydney')).toBe(
      'Sun 1 Nov, 7:12pm',
    )
  })

  test('a time zone Intl doesn’t know is said in Perth’s, never thrown', () => {
    expect(emailWhen(Date.UTC(2026, 10, 1, 8, 12), 'Not/AZone')).toBe(
      'Sun 1 Nov, 4:12pm',
    )
  })

  test('midnight and noon are 12, not 0', () => {
    expect(emailWhen(Date.UTC(2026, 9, 31, 16, 5), PERTH)).toBe(
      'Sun 1 Nov, 12:05am',
    )
    expect(emailWhen(Date.UTC(2026, 10, 1, 4, 0), PERTH)).toBe(
      'Sun 1 Nov, 12:00pm',
    )
  })
})

describe('Xero connected emails', () => {
  const facts = {
    orgName: 'Walsh <b>&</b> Sons',
    businessName: 'Coastal Pest',
    when: 'Sun 1 Nov, 4:12pm',
    mine: true,
  }

  test('an organisation’s name is text, never markup', () => {
    const own = xeroConnectedEmail({
      name: 'Kevin',
      facts,
      settingsUrl: 'https://pestm8.test/coastal-pest/settings/my-xero',
    })
    const owners = memberXeroConnectedEmail({
      name: 'Terence',
      memberName: 'Kevin <i>Walsh</i>',
      facts,
      teamUrl: 'https://pestm8.test/coastal-pest/settings/team',
    })
    for (const email of [own, owners]) {
      expect(email.html).not.toContain('<b>')
      expect(email.html).not.toContain('<i>')
      expect(email.html).toContain('Walsh &lt;b&gt;&amp;&lt;/b&gt; Sons')
      expect(email.text).toContain('“Walsh <b>&</b> Sons”')
    }
  })

  test('the business’s own organisation points at Settings → Xero and says nothing of leaving', () => {
    const email = xeroConnectedEmail({
      name: 'Terence',
      facts: { ...facts, orgName: 'Coastal Pest Pty Ltd', mine: false },
      settingsUrl: 'https://pestm8.test/coastal-pest/settings/xero',
    })
    expect(email.text).toContain('Settings → Xero.')
    expect(email.text).not.toContain('My Xero')
    expect(email.text).not.toContain('leave')
    expect(email.html).toContain('Open Settings → Xero')
  })

  test('neither asks anyone to reply or write in', () => {
    const emails = [
      xeroConnectedEmail({ facts, settingsUrl: 'https://pestm8.test/a' }),
      memberXeroConnectedEmail({
        memberName: 'Kevin Walsh',
        facts,
        teamUrl: 'https://pestm8.test/b',
      }),
    ]
    for (const email of emails) {
      expect(`${email.text}\n${email.html}`).not.toMatch(
        /reply|write to|email us|get in touch|contact us/i,
      )
    }
  })
})
