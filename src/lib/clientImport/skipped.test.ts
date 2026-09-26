import { describe, expect, test } from 'vitest'
import { rowsCsv } from './skipped'
import type { ImportSheet } from './types'

const SHEET: ImportSheet = {
  fileName: 'clients.csv',
  headers: ['Name', 'Address', 'Phone', 'Notes'],
  rows: [
    ['Jo Bloggs', '12 Wattle St, Bayswater WA 6053', '0412 345 678', ''],
    ['Ann "Annie" Lee', '3 Beach Rd\nScarborough WA 6019', '', 'Gate'],
    ['=HYPERLINK("http://x","Click")', '1 Hay St', '+61 412 345 678', '@me'],
    ['Bo', '-1 Nowhere', '\t0412', '\rx'],
  ],
}

describe('rowsCsv', () => {
  test('the headings and the rows asked for, in file order', () => {
    expect(rowsCsv(SHEET, [2, 1, 2, 9, 0])).toBe(
      'Name,Address,Phone,Notes\r\n' +
        'Jo Bloggs,"12 Wattle St, Bayswater WA 6053",0412 345 678,\r\n' +
        '"Ann ""Annie"" Lee","3 Beach Rd\nScarborough WA 6019",,Gate\r\n',
    )
  })

  test("cells a spreadsheet would run as a formula get a ' in front", () => {
    expect(rowsCsv(SHEET, [3, 4]).split('\r\n').slice(1, 3)).toEqual([
      `"'=HYPERLINK(""http://x"",""Click"")",1 Hay St,'+61 412 345 678,'@me`,
      `Bo,'-1 Nowhere,'\t0412,"'\rx"`,
    ])
  })

  test('with reasons, a last column says why', () => {
    const csv = rowsCsv(
      SHEET,
      [1],
      new Map([[1, 'No suburb, and no postcode.']]),
    )
    expect(csv).toBe(
      "Name,Address,Phone,Notes,Why it wasn't imported\r\n" +
        'Jo Bloggs,"12 Wattle St, Bayswater WA 6053",0412 345 678,,"No suburb, and no postcode."\r\n',
    )
  })

  test('no rows: just the headings', () => {
    expect(rowsCsv(SHEET, [])).toBe('Name,Address,Phone,Notes\r\n')
  })
})
