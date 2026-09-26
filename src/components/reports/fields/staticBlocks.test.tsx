import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  EmailsControl,
  domainsWithoutMail,
  emailLines,
  noMailMessage,
} from './staticBlocks'
import type { ComponentProps } from 'react'
import type { DomainMail } from '#/lib/emailDomainCheck'

/** A resolver that answers from a table, and says who it was asked about. */
function resolver(answers: Record<string, DomainMail>) {
  const asked: Array<string> = []
  const ask = async (domain: string) => {
    asked.push(domain)
    return answers[domain] ?? 'receives'
  }
  return { ask, asked }
}

describe("the report's recipient box asks whether a domain takes mail", () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names a domain that takes no mail, which no spelling rule catches', async () => {
    // Not a near miss of a common provider, and a fine shape: only DNS
    // knows smithpestcontrol.com.au takes no mail.
    const { ask } = resolver({ 'smithpestcontrol.com.au': 'no-mail' })
    expect(
      await domainsWithoutMail(
        ['jan@smithpestcontrol.com.au', 'office@smithpest.com.au'],
        ask,
      ),
    ).toEqual(['smithpestcontrol.com.au'])
  })

  it('says nothing when the answer is unknown', async () => {
    const { ask } = resolver({ 'smithpest.com.au': 'unknown' })
    expect(await domainsWithoutMail(['jan@smithpest.com.au'], ask)).toEqual([])
  })

  it('asks about each domain once, and only the ones worth asking', async () => {
    const { ask, asked } = resolver({})
    await domainsWithoutMail(
      [
        'a@strata.net.au',
        'b@strata.net.au',
        'bob@gmail.com', // a common provider
        'bob@gmial.com', // offered a typo fix already
        'bob@gmail', // refused already
      ],
      ask,
    )
    expect(asked).toEqual(['strata.net.au'])
  })

  it('does not ask offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const { ask, asked } = resolver({ 'strata.net.au': 'no-mail' })
    expect(await domainsWithoutMail(['a@strata.net.au'], ask)).toEqual([])
    expect(asked).toEqual([])
  })

  it('does not ask under a test runner', async () => {
    vi.stubGlobal('navigator', { onLine: true, webdriver: true })
    const { ask, asked } = resolver({ 'strata.net.au': 'no-mail' })
    expect(await domainsWithoutMail(['a@strata.net.au'], ask)).toEqual([])
    expect(asked).toEqual([])
  })
})

describe('the lines under the recipient box', () => {
  it('warns about a domain that takes no mail, with no fix to offer', () => {
    const entries = ['jan@smithpestcontrol.com.au']
    expect(emailLines(entries, entries, ['smithpestcontrol.com.au'])).toEqual([
      {
        index: 0,
        entry: 'jan@smithpestcontrol.com.au',
        tone: 'warning',
        text: noMailMessage('smithpestcontrol.com.au'),
        fix: null,
      },
    ])
    expect(noMailMessage('x.com.au')).toBe(
      'x.com.au doesn’t look like it receives email.',
    )
  })

  it('says nothing about an address still being typed', () => {
    expect(
      emailLines(
        ['jan@smithpestcontrol.com.au'],
        [],
        ['smithpestcontrol.com.au'],
      ),
    ).toEqual([])
  })

  it('keeps the refusal and the typo fix as they were', () => {
    const entries = ['bob@gmail', 'amy@gmial.com']
    expect(
      emailLines(entries, entries, []).map((l) => [l.tone, l.fix]),
    ).toEqual([
      ['error', 'bob@gmail.com'],
      ['warning', 'amy@gmail.com'],
    ])
  })
})

describe('the recipient box itself', () => {
  it("does not let the browser offer the technician's own address", () => {
    // A customer's address goes here; autocomplete="email" had iOS and
    // Chrome offer the person holding the phone.
    const props = {
      field: { kind: 'emails', key: 'sendTo', label: 'Email report to' },
      value: [],
      onChange: () => {},
      ctx: {},
    } as unknown as ComponentProps<typeof EmailsControl>
    const html = renderToStaticMarkup(<EmailsControl {...props} />)
    expect(html).toMatch(/autocomplete="off"/i)
    expect(html).not.toMatch(/autocomplete="email"/i)
  })
})
