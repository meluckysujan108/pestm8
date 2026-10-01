import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, onlineManager } from '@tanstack/react-query'
import { ConvexError } from 'convex/values'
import { describeError } from '#/components/forms/describeError'
import { getContext } from '#/integrations/tanstack-query/root-provider'
import {
  SEND_ERROR,
  SEND_REFUSED,
  newAddressLine,
  sendErrorCode,
  sendToEach,
  senderName,
  suggestedRecipients,
} from './SendSheet'

describe('the addresses the send sheet offers', () => {
  const jane = {
    address: 'jane@gmail.com',
    name: 'Jane Nguyen',
    kind: 'client' as const,
    role: null,
    primary: false,
  }
  const bob = {
    address: 'bob@strata.com.au',
    name: 'Bob Lee',
    kind: 'contact' as const,
    role: 'Strata manager',
    primary: false,
  }
  const kim = {
    address: 'kim@agents.com.au',
    name: 'Kim Wu',
    kind: 'contact' as const,
    role: null,
    primary: true,
  }

  it('never chooses one that can never be delivered to', () => {
    // Saved on the client before addresses were checked, and put on the
    // sheet by the form's "send a copy to the client". Chosen, it failed at
    // the server with no reason given.
    const [bad, good] = suggestedRecipients({
      asked: ['bob@gmail', 'strata@office.com.au'],
      people: [],
      before: [],
      knownAddresses: [],
    })
    expect(bad).toMatchObject({
      address: 'bob@gmail',
      chosen: false,
      fix: 'bob@gmail.com',
    })
    expect(bad.problem).toMatch(/\.com/)
    expect(good).toMatchObject({ chosen: true, problem: null, fix: null })
  })

  it('offers the client from their record, chosen, even when the form asked for nobody', () => {
    const list = suggestedRecipients({
      asked: [],
      people: [jane, bob, kim],
      before: [],
      knownAddresses: [jane.address, bob.address, kim.address],
    })
    // The client first, then contacts with the primary one leading.
    expect(list.map((r) => [r.address, r.chosen, r.who])).toEqual([
      ['jane@gmail.com', true, 'Jane Nguyen · Client'],
      ['kim@agents.com.au', false, 'Kim Wu · Primary contact'],
      ['bob@strata.com.au', false, 'Bob Lee · Strata manager'],
    ])
  })

  it('puts the form’s own people first, named when the client book knows them', () => {
    const list = suggestedRecipients({
      asked: ['bob@strata.com.au', 'office@body-corp.com.au'],
      people: [jane, bob],
      before: [],
      knownAddresses: [jane.address, bob.address],
    })
    expect(list.map((r) => [r.address, r.chosen, r.who])).toEqual([
      ['bob@strata.com.au', true, 'Bob Lee · Strata manager'],
      ['office@body-corp.com.au', true, 'Asked for on the form'],
      ['jane@gmail.com', true, 'Jane Nguyen · Client'],
    ])
  })

  it('leaves anyone who already has this report unchosen, and says when it went', () => {
    const list = suggestedRecipients({
      asked: ['jane@gmail.com'],
      people: [jane],
      before: [
        { to: ['jane@gmail.com'], status: 'sent', sentAt: 1000 },
        { to: ['old@x.com.au'], status: 'failed' },
      ],
      knownAddresses: [jane.address],
    })
    expect(list.map((r) => [r.address, r.chosen, r.sentAt])).toEqual([
      ['jane@gmail.com', false, 1000],
      // Tried before and failed: offered, never assumed.
      ['old@x.com.au', false, null],
    ])
  })

  it('still lists each address once', () => {
    const list = suggestedRecipients({
      asked: ['a@x.com.au'],
      people: [],
      before: [
        { to: ['a@x.com.au', 'b@y.com.au'], status: 'failed' },
        { to: ['b@y.com.au'], status: 'failed' },
      ],
      knownAddresses: ['a@x.com.au'],
    })
    expect(list.map((r) => [r.address, r.chosen, r.known])).toEqual([
      ['a@x.com.au', true, true],
      ['b@y.com.au', false, false],
    ])
  })
})

describe('what a failed send says', () => {
  it('names an address the server refused, not "could not send"', () => {
    expect(sendErrorCode({ data: 'INVALID_EMAIL' })).toBe('INVALID_EMAIL')
    expect(
      sendErrorCode(
        new Error(
          '[CONVEX A(email:sendReportPdf)] Uncaught ConvexError: INVALID_EMAIL',
        ),
      ),
    ).toBe('INVALID_EMAIL')
    expect(SEND_ERROR.INVALID_EMAIL).toMatch(/can’t receive email/)
  })

  it('keeps the codes it already knew, and UNKNOWN for the rest', () => {
    expect(sendErrorCode(new Error('EMAIL_NOT_CONFIGURED'))).toBe(
      'EMAIL_NOT_CONFIGURED',
    )
    expect(sendErrorCode(new Error('socket hang up'))).toBe('UNKNOWN')
    expect(sendErrorCode({ data: 'SOMETHING_NEW' })).toBe('UNKNOWN')
  })
})

describe('a tap of Send', () => {
  afterEach(() => {
    onlineManager.setOnline(true)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('sends to each address in turn, and says how each one went', async () => {
    const sendOne = vi.fn(async (to: string) => {
      if (to === 'strata@office.com.au') {
        throw new ConvexError('SEND_RATE_LIMITED')
      }
    })
    const addresses = ['jane@gmail.com', 'strata@office.com.au', 'bob@x.com.au']

    await expect(sendToEach(addresses, sendOne)).resolves.toEqual([
      { address: 'jane@gmail.com', code: null },
      { address: 'strata@office.com.au', code: 'SEND_RATE_LIMITED' },
      { address: 'bob@x.com.au', code: null },
    ])
    expect(sendOne.mock.calls.map(([to]) => to)).toEqual(addresses)
  })

  it('with no signal emails nobody — then, or when the signal comes back', async () => {
    // The app's own client, mounted as QueryClientProvider mounts it: it
    // listens for the signal to come back. No socket is opened without
    // `window`.
    vi.stubEnv('VITE_CONVEX_URL', 'https://happy-otter-123.convex.cloud')
    vi.stubGlobal('navigator', { onLine: false })
    onlineManager.setOnline(false)
    const client = getContext().queryClient
    client.mount()
    try {
      const sendOne = vi.fn(async () => {})
      const send = new MutationObserver(client, {
        mutationFn: (addresses: Array<string>) =>
          sendToEach(addresses, sendOne),
      })

      await expect(
        send.mutate(['jane@gmail.com', 'strata@office.com.au']),
      ).rejects.toThrow('offline')
      // One line for the whole tap, not a failure beside each address.
      const words = describeError(send.getCurrentResult().error, SEND_REFUSED)
      expect(words).toBe(SEND_REFUSED.offline)
      expect(words).toMatch(/Nothing was sent/)

      vi.stubGlobal('navigator', { onLine: true })
      onlineManager.setOnline(true)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sendOne).not.toHaveBeenCalled()
    } finally {
      client.unmount()
    }
  })
})

describe('how a send is described afterwards', () => {
  it('names who sent it, and the account it was sent from', () => {
    expect(senderName('Terence')).toBe('Terence')
    expect(senderName('Terence', 'Kevin')).toBe('Terence, in Kevin’s account')
  })

  it('says which addresses weren’t on the client’s record, as they were then', () => {
    expect(newAddressLine(['strata@example.com'])).toBe(
      'Wasn’t on the client’s record: strata@example.com',
    )
    expect(newAddressLine(['a@example.com', 'b@example.com'])).toBe(
      'Weren’t on the client’s record: a@example.com, b@example.com',
    )
  })
})
