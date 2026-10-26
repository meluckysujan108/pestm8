import { describe, expect, test } from 'vitest'
import {
  clientCountLabel,
  directoryCount,
  keptClientsMode,
  newestDrawn,
} from './keptClients'
import type { Directory } from '#/lib/directory'

/**
 * The Clients page with the line down: every client from the phone's copy,
 * counted from what it holds, unless the newest clients' first page is in
 * memory and the copy isn't known to be; and on a line that looks up, every
 * client from memory once the newest are late.
 */

const DOWN = {
  lineDown: true,
  directoryReadable: true,
  copyRead: true,
  firstPageInMemory: false,
  directoryInMemory: false,
  late: false,
}
const UP = { ...DOWN, lineDown: false }

describe('when the page reads every client from the phone', () => {
  test('with the line down', () => {
    expect(keptClientsMode(DOWN)).toBe(true)
    expect(keptClientsMode({ ...DOWN, firstPageInMemory: true })).toBe(true)
  })

  test('not on a line that looks up, while the newest clients may still come', () => {
    expect(keptClientsMode(UP)).toBe(false)
    expect(keptClientsMode({ ...UP, directoryInMemory: true })).toBe(false)
  })

  test('on a line that looks up, once the newest are late and every client is in memory', () => {
    expect(
      keptClientsMode({ ...UP, late: true, directoryInMemory: true }),
    ).toBe(true)
    // Not for a list that would only be waited for in their place.
    expect(keptClientsMode({ ...UP, late: true })).toBe(false)
  })

  test('not when the first page is in memory and the copy isn’t: the page stays as it was', () => {
    expect(
      keptClientsMode({
        ...DOWN,
        firstPageInMemory: true,
        directoryReadable: false,
      }),
    ).toBe(false)
  })

  test('not on a guess, with the first page in memory and the phone’s copy still being read', () => {
    expect(
      keptClientsMode({ ...DOWN, firstPageInMemory: true, copyRead: false }),
    ).toBe(false)
  })

  test('with neither, the list says it could not load rather than waiting for good', () => {
    expect(keptClientsMode({ ...DOWN, directoryReadable: false })).toBe(true)
    expect(
      keptClientsMode({ ...DOWN, directoryReadable: false, copyRead: false }),
    ).toBe(true)
  })
})

describe('whether the newest clients are on screen', () => {
  test('once their first page and the filter row’s choices are both in memory', () => {
    expect(
      newestDrawn({
        firstPageInMemory: true,
        overviewInMemory: true,
        lineDown: false,
      }),
    ).toBe(true)
    // The choices still to come: the cards wait, so the row never lands
    // above them.
    expect(
      newestDrawn({
        firstPageInMemory: true,
        overviewInMemory: false,
        lineDown: false,
      }),
    ).toBe(false)
    expect(
      newestDrawn({
        firstPageInMemory: false,
        overviewInMemory: true,
        lineDown: false,
      }),
    ).toBe(false)
  })

  test('with the line down, without the choices, which won’t come', () => {
    expect(
      newestDrawn({
        firstPageInMemory: true,
        overviewInMemory: false,
        lineDown: true,
      }),
    ).toBe(true)
  })
})

function directory(
  clients: Array<{ id: string; archived?: boolean }>,
  capped = false,
): Directory {
  return {
    clients: clients.map((c) => ({
      _id: c.id,
      _creationTime: 1,
      name: c.id,
      kind: 'person',
      createdAt: 1,
      ...(c.archived ? { archivedAt: 2 } : {}),
    })),
    sites: [],
    capped,
  } as unknown as Directory
}

describe('the count', () => {
  test('every client the page lists, as the server counts them: none archived', () => {
    expect(
      directoryCount(
        directory([{ id: 'a' }, { id: 'b', archived: true }, { id: 'c' }]),
      ),
    ).toEqual({ total: 2, capped: false })
    expect(directoryCount(directory([{ id: 'a' }], true))).toEqual({
      total: 1,
      capped: true,
    })
  })

  test('digits with their noun, and a + when the list was cut short', () => {
    expect(clientCountLabel({ total: 0, capped: false })).toBe('0 clients')
    expect(clientCountLabel({ total: 1, capped: false })).toBe('1 client')
    expect(clientCountLabel({ total: 12, capped: false })).toBe('12 clients')
    expect(clientCountLabel({ total: 1, capped: true })).toBe('1+ clients')
    expect(clientCountLabel({ total: 500, capped: true })).toBe('500+ clients')
  })
})
