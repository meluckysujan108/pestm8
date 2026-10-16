import { describe, expect, test } from 'vitest'
import {
  backfillCopy,
  differentCopy,
  fieldList,
  importNoteCopy,
  pauseCopy,
  problemHeading,
  recentFooterCopy,
  startSyncingBody,
  syncProblemCopy,
  waitingCount,
} from './xeroCopy'
import { xeroBadgeText, xeroRowValue } from './XeroBadge'
import { syncOf } from './syncView'
import type { XeroView } from './XeroPage'

/** A connected view as `xero.status` gives it, matched and syncing or not. */
function view(over: Record<string, unknown> = {}): XeroView {
  return {
    connectionId: 'xc_1',
    kind: 'business',
    tenantName: 'Pest M8 Pest Control',
    status: 'connected',
    connectedAt: 1,
    connectedByName: 'Terence Walsh',
    problem: null,
    shortCode: '!x7Kp2',
    disconnectReason: null,
    match: {
      state: 'ready',
      at: 1,
      linked: 412,
      review: 0,
      fresh: 37,
      different: 1,
      leads: 6,
      shared: 0,
      problem: null,
      staleAfter: null,
    },
    syncStartedAt: null,
    sync: null,
    ...over,
  } as unknown as XeroView
}

const counts = {
  inXero: 0,
  review: 0,
  different: 0,
  failed: 0,
  stopped: 0,
  waiting: 0,
}

function syncing(over: Partial<typeof counts>): XeroView {
  return view({
    syncStartedAt: 2,
    sync: {
      counts: { ...counts, ...over },
      lastSentAt: null,
      pausedUntil: null,
      pauseReason: null,
      backfill: null,
      recent: [],
      problems: 0,
    },
  })
}

describe('the hub badge', () => {
  test('Reconnect beats everything', () => {
    expect(
      xeroBadgeText(
        view({ status: 'needs_reconnect', syncStartedAt: 2, sync: null }),
      ),
    ).toBe('Reconnect')
  })

  test('before syncing, the match’s to check', () => {
    const v = view()
    expect(xeroBadgeText(v)).toBeNull()
    const withReview = view({
      match: { ...(v.match as object), review: 4 },
    })
    expect(xeroBadgeText(withReview)).toBe('4 to check')
  })

  test('syncing: to check, then different, then nothing', () => {
    expect(xeroBadgeText(syncing({ review: 3, different: 2 }))).toBe(
      '3 to check',
    )
    expect(xeroBadgeText(syncing({ different: 1_204 }))).toBe('1,204 different')
    expect(xeroBadgeText(syncing({ waiting: 9 }))).toBeNull()
  })

  test('the row’s value gives way to a badge', () => {
    expect(xeroRowValue(syncing({ review: 1 }))).toBeUndefined()
    expect(xeroRowValue(syncing({}))).toBe('Pest M8 Pest Control')
    expect(xeroRowValue(null)).toBe('Not connected')
  })
})

describe('syncOf', () => {
  test('null until Start syncing', () => {
    expect(syncOf(view())).toBeNull()
  })

  test('started with no sync row yet reads as nothing sent', () => {
    const sync = syncOf(view({ syncStartedAt: 5, sync: null }))
    expect(sync?.startedAt).toBe(5)
    expect(sync?.counts).toEqual(counts)
    expect(sync?.recent).toEqual([])
  })
})

describe('sync copy', () => {
  test('fields read as a list', () => {
    expect(fieldList(['email'])).toBe('email address')
    expect(fieldList(['email', 'phoneMobile'])).toBe(
      'email address and mobile number',
    )
    expect(fieldList(['name', 'email', 'taxNumber'])).toBe(
      'name, email address and ABN',
    )
    expect(fieldList(['nonsense'])).toBe('details')
  })

  test('an unknown problem still says what to do', () => {
    expect(syncProblemCopy('something_new')).toBe(syncProblemCopy('unknown'))
    expect(syncProblemCopy(null)).toBe(syncProblemCopy('unknown'))
    expect(syncProblemCopy('email_invalid')).toMatch(/email address/)
  })

  test('only a day or a server pause is worth a line', () => {
    expect(pauseCopy('minute', 'Org', 'soon')).toBeNull()
    expect(pauseCopy(null, 'Org', 'soon')).toBeNull()
    expect(pauseCopy('day', 'Org', 'Fri 16 Oct, 8:00am')).toBe(
      'Xero’s daily limit for Org is used up. PestM8 carries on Fri 16 Oct, 8:00am, and changes wait here till then.',
    )
  })

  test('a Different warning reads right whatever differs', () => {
    expect(differentCopy(['email'], 'Jan Morris')).toBe(
      'Xero’s email address for Jan Morris is different, so PestM8 left Xero’s alone.',
    )
    expect(differentCopy(['persons'], 'Subi Café Group')).toBe(
      'Xero’s contact people for Subi Café Group are different, so PestM8 left Xero’s alone.',
    )
    expect(differentCopy(['email', 'phoneMobile'], 'Jan')).toBe(
      'Xero’s email address and mobile number for Jan are different, so PestM8 left Xero’s alone.',
    )
    expect(differentCopy(['nonsense'], 'Jan')).toBe(
      'Xero’s details for Jan are different, so PestM8 left Xero’s alone.',
    )
  })

  test('a problem is headed by what happened: never added, a change refused, or only something left off', () => {
    expect(
      problemHeading({
        code: 'email_invalid',
        clientName: 'Jan',
        inXero: false,
      }),
    ).toBe('Could not add Jan')
    expect(
      problemHeading({
        code: 'email_invalid',
        clientName: 'Jan',
        inXero: true,
      }),
    ).toBe('Could not update Jan')
    expect(
      problemHeading({
        code: 'email_not_ascii',
        clientName: 'Zoë Brennan',
        inXero: true,
      }),
    ).toBe('Zoë Brennan')
  })

  test('someone who can’t change clients is told who can', () => {
    expect(syncProblemCopy('email_invalid', { canEdit: false })).toMatch(
      /Ask the business owner/,
    )
    expect(syncProblemCopy('email_invalid')).not.toMatch(/business owner/)
    // Nothing of the client's to change: the same for everyone.
    expect(syncProblemCopy('xero_unavailable', { canEdit: false })).toBe(
      syncProblemCopy('xero_unavailable'),
    )
    expect(syncProblemCopy('name_unread')).toMatch(/couldn’t look it up/)
  })

  test('the footer under Recent problems, and the count under Adding', () => {
    expect(recentFooterCopy(5, 5)).toBeNull()
    expect(recentFooterCopy(5, 7)).toBe('The newest 5 of 7.')
    expect(backfillCopy(412, 449)).toBe(
      '412 of 449 in Xero. It carries on if you leave this page.',
    )
    expect(backfillCopy(0, 0)).toBe('It carries on if you leave this page.')
  })

  test('waiting caps at 99+', () => {
    expect(waitingCount(99)).toBe('99')
    expect(waitingCount(100)).toBe('99+')
  })

  test('Start syncing says what goes and what waits', () => {
    expect(
      startSyncingBody({
        fresh: 37,
        linked: 412,
        review: 4,
        tenantName: 'Org',
      }),
    ).toBe(
      'PestM8 adds 37 clients to Org and fills in blanks on the 412 it matched. The 4 to check wait until you decide. Contacts added to Xero stay there, even if you disconnect.',
    )
    expect(
      startSyncingBody({ fresh: 1, linked: 0, review: 0, tenantName: 'Org' }),
    ).toBe(
      'PestM8 adds 1 client to Org. Contacts added to Xero stay there, even if you disconnect.',
    )
  })

  test('the undo note counts, and says nothing for none', () => {
    expect(importNoteCopy(0)).toBeNull()
    expect(importNoteCopy(1)).toBe(
      '1 of these clients is already in Xero and stays there.',
    )
    expect(importNoteCopy(1_200)).toBe(
      '1,200 of these clients are already in Xero and stay there.',
    )
  })
})
