import { describe, expect, test } from 'vitest'
import { ImportFileError, cellToText, readImportFile } from './read'
import { rowsCsv } from './skipped'

function file(
  content: string | Uint8Array<ArrayBuffer>,
  name = 'clients.csv',
): File {
  return new File([content], name)
}

/** Bytes as Windows-1252 writes them: the ASCII range as is, and the few
 * characters these tests need at their code points. */
function cp1252(text: string): Uint8Array<ArrayBuffer> {
  const special: Record<string, number> = {
    é: 0xe9,
    '“': 0x93,
    '”': 0x94,
    '’': 0x92,
    '–': 0x96,
  }
  return new Uint8Array([...text].map((ch) => special[ch] ?? ch.charCodeAt(0)))
}

async function error(promise: Promise<unknown>): Promise<ImportFileError> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(ImportFileError)
    return e as ImportFileError
  }
  throw new Error('expected an ImportFileError')
}

describe('reading a text file', () => {
  test('Windows-1252 from Excel decodes to the right characters', async () => {
    const bytes = cp1252(
      'Name,Notes\r\nCafé Roma,“Back gate” – dog’s name is Rex\r\n',
    )
    const sheet = await readImportFile(file(bytes))
    expect(sheet.headers).toEqual(['Name', 'Notes'])
    expect(sheet.rows).toEqual([
      ['Café Roma', '“Back gate” – dog’s name is Rex'],
    ])
  })

  test('a UTF-8 byte-order mark is not part of the first heading', async () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('Name,Phone\nCafé Roma,0412 345 678\n'),
    ])
    const sheet = await readImportFile(file(bytes))
    expect(sheet.headers).toEqual(['Name', 'Phone'])
    expect(sheet.rows[0][0]).toBe('Café Roma')
  })

  test("Excel's Unicode Text (UTF-16, tab-separated) reads", async () => {
    const text = 'Name\tSuburb\r\nJo Bloggs\tBayswater\r\n'
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < text.length; i++) {
      bytes[2 + i * 2] = text.charCodeAt(i)
    }
    const sheet = await readImportFile(file(bytes, 'clients.txt'))
    expect(sheet.headers).toEqual(['Name', 'Suburb'])
    expect(sheet.rows).toEqual([['Jo Bloggs', 'Bayswater']])
  })

  test('semicolons, with commas inside the addresses', async () => {
    const sheet = await readImportFile(
      file(
        'Name;Address;Phone\n' +
          'Jo Bloggs;12 Wattle St, Bayswater WA 6053;0412 345 678\n' +
          'Ann Lee;3/4 Beach Rd, Scarborough WA 6019;08 9245 1234\n',
      ),
    )
    expect(sheet.headers).toEqual(['Name', 'Address', 'Phone'])
    expect(sheet.rows[1]).toEqual([
      'Ann Lee',
      '3/4 Beach Rd, Scarborough WA 6019',
      '08 9245 1234',
    ])
  })

  test('a quoted address across two lines stays one cell', async () => {
    const sheet = await readImportFile(
      file(
        'Name,Address,Notes\r\n' +
          '"Jo Bloggs","12 Wattle St\r\nBayswater WA 6053","Gate code ""1234"""\r\n',
      ),
    )
    expect(sheet.rows).toEqual([
      ['Jo Bloggs', '12 Wattle St\r\nBayswater WA 6053', 'Gate code "1234"'],
    ])
  })

  test('tabs, and a "sep=" line naming the separator', async () => {
    const tabs = await readImportFile(
      file('Name\tSuburb\nJo\tBayswater\n', 'clients.tsv'),
    )
    expect(tabs.rows).toEqual([['Jo', 'Bayswater']])
    const hinted = await readImportFile(
      file('sep=;\nName;Suburb\nJo;Bayswater, north side\n'),
    )
    expect(hinted.headers).toEqual(['Name', 'Suburb'])
    expect(hinted.rows).toEqual([['Jo', 'Bayswater, north side']])
    // Excel doesn't show the "sep=" line as a row, so it isn't counted.
    expect(hinted.sourceRows).toEqual([2])
  })

  test('blank rows go, cells are trimmed, rows are padded to one width', async () => {
    const sheet = await readImportFile(
      file('\n,,\nName , Phone,,\n  Jo  ,0412\n\n,,\nAnn\nBo,0400,,\n'),
    )
    // Empty cells past the last one used, heading or row, aren't columns.
    expect(sheet.headers).toEqual(['Name', 'Phone'])
    expect(sheet.rows).toEqual([
      ['Jo', '0412'],
      ['Ann', ''],
      ['Bo', '0400'],
    ])
    // Each row keeps the number a spreadsheet shows it at, blank ones and
    // the headings counted.
    expect(sheet.sourceRows).toEqual([4, 7, 8])
  })

  test('row numbers count a title, blank rows and the headings, and a cell across lines as one row', async () => {
    const sheet = await readImportFile(
      file(
        'Client list 2024\n' + // 1
          '\n' + // 2
          'Name,Address,Notes\n' + // 3
          'Jo Bloggs,"12 Wattle St\nBayswater WA 6053",gate\n' + // 4
          ',,\n' + // 5
          '\n' + // 6
          'Ann Lee,3 Beach Rd Scarborough WA 6019,\n', // 7
      ),
    )
    expect(sheet.headers).toEqual(['Name', 'Address', 'Notes'])
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jo Bloggs', 'Ann Lee'])
    expect(sheet.sourceRows).toEqual([4, 7])
  })

  test('with no blank or title rows, data row i is row i + 2', async () => {
    const sheet = await readImportFile(
      file('Name,Phone\nJo,0412\nAnn,0400\nBo,0401\n'),
    )
    expect(sheet.sourceRows).toEqual([2, 3, 4])
  })

  test('blank rows don’t upset the guess at the separator', async () => {
    // Counted as rows, the blank ones would bring semicolons' average below
    // two cells a row, and the file would be read as commas.
    const sheet = await readImportFile(
      file(
        'Name;Address;Phone\n\n\n' +
          'Jo Bloggs;12 Wattle St, Bayswater WA 6053;0412 345 678\n\n' +
          'Ann Lee;3/4 Beach Rd, Scarborough WA 6019;08 9245 1234\n\n',
      ),
    )
    expect(sheet.headers).toEqual(['Name', 'Address', 'Phone'])
    expect(sheet.rows[1]).toEqual([
      'Ann Lee',
      '3/4 Beach Rd, Scarborough WA 6019',
      '08 9245 1234',
    ])
    expect(sheet.sourceRows).toEqual([4, 6])
  })

  test('a heading left blank is named for its column', async () => {
    const sheet = await readImportFile(file('Name,,Phone\nJo,x,0412\n'))
    expect(sheet.headers).toEqual(['Name', 'Column B', 'Phone'])
  })

  test('a column with data but no heading is kept, and named for its column', async () => {
    const sheet = await readImportFile(
      file(
        'Name,Street,Suburb,State,Postcode,\n' +
          'Jo Bloggs,1 A St,Bayswater,WA,6053,0412 345 678\n' +
          'Ann Lee,2 B St,Bayswater,WA,6053\n' +
          ',,,,,,0400 111 222\n',
      ),
    )
    expect(sheet.headers).toEqual([
      'Name',
      'Street',
      'Suburb',
      'State',
      'Postcode',
      'Column F',
      'Column G',
    ])
    expect(sheet.rows).toEqual([
      ['Jo Bloggs', '1 A St', 'Bayswater', 'WA', '6053', '0412 345 678', ''],
      ['Ann Lee', '2 B St', 'Bayswater', 'WA', '6053', '', ''],
      // A row whose only cell is past the headings is still a row.
      ['', '', '', '', '', '', '0400 111 222'],
    ])
  })

  test('a title above the headings is passed over', async () => {
    const sheet = await readImportFile(
      file(
        'Client list 2024,,,,\n' +
          'Name,Street,Suburb,State,Postcode\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053\n',
      ),
    )
    expect(sheet.headers).toEqual([
      'Name',
      'Street',
      'Suburb',
      'State',
      'Postcode',
    ])
    expect(sheet.rows).toEqual([
      ['Jane Smith', '1 A St', 'Bayswater', 'WA', '6053'],
    ])
    expect(sheet.sourceRows).toEqual([3])
  })

  test('a title above headings the Match step doesn’t know is passed over too', async () => {
    const sheet = await readImportFile(
      file(
        'Client list 2024,,,,\n' +
          'Cust,Addr,Sub,St,PC\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053\n',
      ),
    )
    expect(sheet.headers).toEqual(['Cust', 'Addr', 'Sub', 'St', 'PC'])
    expect(sheet.rows).toEqual([
      ['Jane Smith', '1 A St', 'Bayswater', 'WA', '6053'],
    ])
    expect(sheet.sourceRows).toEqual([3])
  })

  test('headings over only some of the columns are still the headings', async () => {
    // Merged cells over sub-columns, say ("Address" over street, suburb,
    // state and postcode). The clients below fill more cells, and are
    // clients all the same.
    const sheet = await readImportFile(
      file(
        'Name,Address,,,\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053\n' +
          'Tom Brown,2 B St,Bayswater,WA,6053\n',
      ),
    )
    expect(sheet.headers).toEqual([
      'Name',
      'Address',
      'Column C',
      'Column D',
      'Column E',
    ])
    expect(sheet.rows).toEqual([
      ['Jane Smith', '1 A St', 'Bayswater', 'WA', '6053'],
      ['Tom Brown', '2 B St', 'Bayswater', 'WA', '6053'],
    ])
    expect(sheet.sourceRows).toEqual([2, 3])
  })

  test('one heading the Match step knows, over unheaded columns, is not a title', async () => {
    const sheet = await readImportFile(
      file('Name,,\nJo Bloggs,1 A St,Bayswater\nAnn Lee,2 B St,Morley\n'),
    )
    expect(sheet.headers).toEqual(['Name', 'Column B', 'Column C'])
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jo Bloggs', 'Ann Lee'])
    expect(sheet.sourceRows).toEqual([2, 3])

    // Nor is it a band over the first client, whose cells are mostly words
    // the Match step knows.
    const known = await readImportFile(
      file('Name,,\nJo Bloggs,Business,Email\nAnn Lee,Residential,Phone\n'),
    )
    expect(known.headers).toEqual(['Name', 'Column B', 'Column C'])
    expect(known.rows.map((row) => row[0])).toEqual(['Jo Bloggs', 'Ann Lee'])
    expect(known.sourceRows).toEqual([2, 3])
  })

  /** Headings of the owner's own — only "Mobile No." is one the Match step
   * knows — over a client whose Cat and Pref are "Business" and "Email",
   * two it does. */
  const ownHeadings =
    'Cust,Street Addr,Sub,PC,Mobile No.,Cat,Pref\n' +
    'Jane Smith,1 Wattle St,Bayswater,6053,0412 345 678,Business,Email\n' +
    'Tom Brown,2 B St,Bayswater,6053,0400 111 222,Residential,Phone\n' +
    'Ann Lee,3 C St,Morley,6062,0400 333 444,Residential,SMS\n'
  const ownHeaders = [
    'Cust',
    'Street Addr',
    'Sub',
    'PC',
    'Mobile No.',
    'Cat',
    'Pref',
  ]

  test('headings of its own, over a client whose details hold words the Match step knows', async () => {
    const sheet = await readImportFile(file(ownHeadings))
    expect(sheet.headers).toEqual(ownHeaders)
    expect(sheet.rows.map((row) => row[0])).toEqual([
      'Jane Smith',
      'Tom Brown',
      'Ann Lee',
    ])
    expect(sheet.rows[0]).toEqual([
      'Jane Smith',
      '1 Wattle St',
      'Bayswater',
      '6053',
      '0412 345 678',
      'Business',
      'Email',
    ])
    expect(sheet.sourceRows).toEqual([2, 3, 4])
  })

  test('a title over headings that cover only some of the columns', async () => {
    const sheet = await readImportFile(
      file(
        'Client list 2024,,,,\n' +
          'Name,Address,,,\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053\n' +
          'Tom Brown,2 B St,Morley,WA,6062\n',
      ),
    )
    expect(sheet.headers.slice(0, 2)).toEqual(['Name', 'Address'])
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jane Smith', 'Tom Brown'])
    expect(sheet.sourceRows).toEqual([3, 4])
  })

  test('a title over merged headings that leave gaps', async () => {
    const sheet = await readImportFile(
      file(
        'Client list 2024,,,,,,\n' +
          'Name,Address,,,,Contact,\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053,0412 345 678,jane@example.com\n',
      ),
    )
    expect(sheet.headers[0]).toBe('Name')
    expect(sheet.headers[1]).toBe('Address')
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jane Smith'])
    expect(sheet.sourceRows).toEqual([3])
  })

  test('a title of two cells over a sheet only a little wider', async () => {
    const sheet = await readImportFile(
      file(
        'Client list,Printed 1/1/2024\n' +
          'Name,Address,Phone\n' +
          'Jane Smith,"1 A St, Bayswater WA 6053",0412 345 678\n',
      ),
    )
    expect(sheet.headers).toEqual(['Name', 'Address', 'Phone'])
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jane Smith'])
    expect(sheet.sourceRows).toEqual([3])
  })

  test('a title of two cells over headings of its own is passed over', async () => {
    const sheet = await readImportFile(
      file('Client list,,,,Printed 1/1/2024,,\n\n' + ownHeadings),
    )
    expect(sheet.headers).toEqual(ownHeaders)
    expect(sheet.rows.map((row) => row[0])).toEqual([
      'Jane Smith',
      'Tom Brown',
      'Ann Lee',
    ])
    // The title is row 1, a blank row 2 and the headings row 3.
    expect(sheet.sourceRows).toEqual([4, 5, 6])
  })

  test('a client with more of the Match step’s words than the headings is still a client', async () => {
    // Headings over only some of the columns: the client fills more cells
    // and knows more words ("Business", "Email", "Tenant"), but most of
    // its cells aren't headings, so it isn't the real headings under a band.
    const partial = await readImportFile(
      file(
        'Name,Address,,,,,,\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053,Business,Email,Tenant\n' +
          'Tom Brown,2 B St,Bayswater,WA,6053,Residential,Phone,Owner\n',
      ),
    )
    expect(partial.headers.slice(0, 3)).toEqual(['Name', 'Address', 'Column C'])
    expect(partial.rows.map((row) => row[0])).toEqual([
      'Jane Smith',
      'Tom Brown',
    ])
    expect(partial.sourceRows).toEqual([2, 3])

    // Every column headed: the client's row fills no more cells than the
    // headings, so it can't be the real headings under a band either.
    const full = await readImportFile(
      file(
        'Name,Mobile,Cat,Pref,Occ\n' +
          'Jane Smith,0412 345 678,Business,Email,Tenant\n',
      ),
    )
    expect(full.headers).toEqual(['Name', 'Mobile', 'Cat', 'Pref', 'Occ'])
    expect(full.rows.map((row) => row[0])).toEqual(['Jane Smith'])
    expect(full.sourceRows).toEqual([2])
  })

  test('a band as full as half the widest row, under a title, is still stepped over', async () => {
    const sheet = await readImportFile(
      file(
        'Wattle Pest Control – clients\n' +
          '\n' +
          'Client,,Address,,Contact,\n' +
          'Name,Company,Street,Suburb,Phone,Email\n' +
          'Jo Bloggs,,1 A St,Bayswater,0412 345 678,jo@example.com\n',
      ),
    )
    expect(sheet.headers).toEqual([
      'Name',
      'Company',
      'Street',
      'Suburb',
      'Phone',
      'Email',
    ])
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jo Bloggs'])
    expect(sheet.sourceRows).toEqual([5])
  })

  test('headings of its own the Match step doesn’t know: the first row is the headings', async () => {
    const sheet = await readImportFile(
      file(
        'Cust,Addr,Sub,St,PC\n' +
          'Jane Smith,1 A St,Bayswater,WA,6053\n' +
          'Tom Brown,2 B St,Bayswater,WA,6053\n',
      ),
    )
    expect(sheet.headers).toEqual(['Cust', 'Addr', 'Sub', 'St', 'PC'])
    expect(sheet.rows.map((row) => row[0])).toEqual(['Jane Smith', 'Tom Brown'])
    expect(sheet.sourceRows).toEqual([2, 3])
  })

  test('a title, a date and a band of grouped headings above the real ones', async () => {
    const sheet = await readImportFile(
      file(
        'Wattle Pest Control,Exported 03/02/2024,,,,\n' +
          '\n' +
          'Client,,Address,,,\n' +
          'Name,Phone,Street,Suburb,State,Postcode\n' +
          'Jo Bloggs,0412 345 678,1 A St,Bayswater,WA,6053\n',
      ),
    )
    expect(sheet.headers).toEqual([
      'Name',
      'Phone',
      'Street',
      'Suburb',
      'State',
      'Postcode',
    ])
    expect(sheet.rows).toEqual([
      ['Jo Bloggs', '0412 345 678', '1 A St', 'Bayswater', 'WA', '6053'],
    ])
    expect(sheet.sourceRows).toEqual([5])
  })

  test('a heading merged down beside a band keeps its name', async () => {
    // "Name" merged over rows 1–2 is in row 1 only; "Address" and "Contact"
    // are merged across the columns named in row 2.
    const sheet = await readImportFile(
      file(
        'Name,Address,,,,Contact,\n' +
          ',Street,Suburb,State,Postcode,Phone,Email\n' +
          'Jo Bloggs,1 A St,Bayswater,WA,6053,0412 345 678,jo@example.com\n',
      ),
    )
    expect(sheet.headers).toEqual([
      'Name',
      'Street',
      'Suburb',
      'State',
      'Postcode',
      'Phone',
      'Email',
    ])
    expect(sheet.rows).toEqual([
      [
        'Jo Bloggs',
        '1 A St',
        'Bayswater',
        'WA',
        '6053',
        '0412 345 678',
        'jo@example.com',
      ],
    ])
    expect(sheet.sourceRows).toEqual([3])
  })

  test('with only one column, the first row is still the headings', async () => {
    const sheet = await readImportFile(file('Name\nJo Bloggs\nAnn Lee\n'))
    expect(sheet.headers).toEqual(['Name'])
    expect(sheet.rows).toEqual([['Jo Bloggs'], ['Ann Lee']])
    // A heading of its own is no title either, with no fuller row below.
    const own = await readImportFile(file('Cust\nJo Bloggs\nAnn Lee\n'))
    expect(own.headers).toEqual(['Cust'])
    expect(own.rows).toEqual([['Jo Bloggs'], ['Ann Lee']])
    expect(own.sourceRows).toEqual([2, 3])
  })

  test('headings are looked for in the first 10 rows only', async () => {
    // Past that it's more likely a list of names than a title, and the
    // first row is the headings as usual.
    const names = Array.from({ length: 10 }, (_, i) => `Client ${i}`)
    const sheet = await readImportFile(
      file(`Name\n${names.join('\n')}\nJo Bloggs,0412 345 678\n`),
    )
    expect(sheet.headers).toEqual(['Name', 'Column B'])
    expect(sheet.rows).toHaveLength(11)
  })

  test("MYOB's {} line above the headings is passed over", async () => {
    const sheet = await readImportFile(
      file('{}\nCo./Last Name,First Name,Card ID\nSmith,Jo,*None\n', 'x.txt'),
    )
    expect(sheet.headers).toEqual(['Co./Last Name', 'First Name', 'Card ID'])
    expect(sheet.rows).toHaveLength(1)
    // The {} is a row in a spreadsheet, so it's counted.
    expect(sheet.sourceRows).toEqual([3])
  })

  test('a quote mark never closed is an error, not a swallowed file', async () => {
    const e = await error(
      readImportFile(file('Name,Notes\nJo,"gate\nAnn,dog\nBo,cat\n')),
    )
    expect(e.message).toMatch(/quote mark/)
  })

  test('a quote mark closed part-way through a cell is an error, naming the row', async () => {
    // Read on, the quote before "of dog" runs to the one after "fine", and
    // Bob's and Cat's rows would vanish into Ann's notes.
    const e = await error(
      readImportFile(
        file(
          'Name,Notes,Street,Suburb,State,Postcode\n' +
            'Ann Able,"Beware" of dog,1 A St,Bayswater,WA,6053\n' +
            'Bob Baker,plain,2 B St,Bayswater,WA,6053\n' +
            'Cat Cole,"quoted, fine",3 C St,Bayswater,WA,6053\n' +
            'Dan Dunn,,4 D St,Bayswater,WA,6053\n',
        ),
      ),
    )
    expect(e.message).toBe(
      "Row 2 of the file has a quote mark (\") that doesn't open or close a cell properly, so the rows after it can't be read. Fix that row and try again.",
    )
  })

  test('the row a broken quote mark is on counts the blank rows above it', async () => {
    const e = await error(
      readImportFile(
        file(
          'Name,Notes,Street\n\n' +
            'Ann Able,"Beware" of dog,1 A St\n' +
            'Bob Baker,plain,2 B St\n' +
            'Cat Cole,"quoted, fine",3 C St\n',
        ),
      ),
    )
    expect(e.message).toMatch(/^Row 3 of the file has a quote mark/)
  })

  test('a quote mark inside a cell, not at its start, is just a character', async () => {
    const sheet = await readImportFile(
      file('Name,Notes\nJo,12" pipe by the gate\nAnn,"dog, cat"\n'),
    )
    expect(sheet.rows).toEqual([
      ['Jo', '12" pipe by the gate'],
      ['Ann', 'dog, cat'],
    ])
  })
})

describe('the rows-not-imported download, imported again', () => {
  const sheet = {
    fileName: 'clients.csv',
    headers: [
      'Name',
      'Mobile',
      'Street',
      'Suburb',
      'State',
      'Postcode',
      'Notes',
    ],
    rows: [
      [
        '@Home Cleaning',
        '+61 412 345 678',
        '1 A St',
        'Bayswater',
        'WA',
        '6053',
        '- dog in yard',
      ],
      ['=Wattle Strata', '', '2 B St', 'Bayswater', 'WA', '6053', 'Gate "4"'],
      // A ' of the row's own, not in front of = + - @, is left alone.
      [
        "'Brien Pest",
        '',
        '3 C St',
        'Bayswater',
        'WA',
        '6053',
        "'Tis the season, it's fine",
      ],
      // …and one of its own in front of them is kept too.
      ["'=Odd Name", '', '4 D St', 'Bayswater', 'WA', '6053', "''- keep"],
    ],
  }

  test('comes back exactly as it was, without the apostrophes it was given', async () => {
    const csv = rowsCsv(sheet, [1, 2, 3, 4])
    expect(csv).toContain("'@Home Cleaning,'+61 412 345 678,")
    // The download starts with a byte-order mark for Excel's sake.
    const back = await readImportFile(file(`\uFEFF${csv}`))
    expect(back.headers).toEqual(sheet.headers)
    expect(back.rows).toEqual(sheet.rows)
  })

  test('with its reasons column, that column comes back as one more', async () => {
    const reasons = new Map([[1, 'No street address']])
    const back = await readImportFile(file(rowsCsv(sheet, [1], reasons)))
    expect(back.headers).toEqual([...sheet.headers, "Why it wasn't imported"])
    expect(back.rows).toEqual([[...sheet.rows[0], 'No street address']])
  })

  test("only a ' in front of = + - or @ comes off; any other is the file's own", async () => {
    const back = await readImportFile(
      file("Name,Mobile,Notes\n'Jo,'0412 345 678,'- dog\n"),
    )
    expect(back.rows).toEqual([["'Jo", "'0412 345 678", '- dog']])
  })
})

describe('what the page refuses', () => {
  test('more than 2,000 rows', async () => {
    const rows = Array.from({ length: 3240 }, (_, i) => `Client ${i},6053`)
    const e = await error(
      readImportFile(file(`Name,Postcode\n${rows.join('\n')}\n`, 'big.csv')),
    )
    expect(e.message).toBe(
      '“big.csv” has 3,240 rows; PestM8 takes up to 2,000 at a time — split it and import each part.',
    )
  })

  test('exactly 2,000 rows is fine', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `Client ${i},6053`)
    const sheet = await readImportFile(
      file(`Name,Postcode\n${rows.join('\n')}\n`),
    )
    expect(sheet.rows).toHaveLength(2000)
  })

  test('a title and blank rows above the headings, and blank rows among them, are not counted', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `Client ${i},6053`)
    const sheet = await readImportFile(
      file(`Clients,\n,\n\nName,Postcode\n${rows.join('\n,\n')}\n\n`),
    )
    expect(sheet.headers).toEqual(['Name', 'Postcode'])
    expect(sheet.rows).toHaveLength(2000)
    // …though they are in the row numbers: the headings are row 4, and a
    // blank row follows every client.
    expect(sheet.sourceRows?.[0]).toBe(5)
    expect(sheet.sourceRows?.[1999]).toBe(5 + 2 * 1999)
  })

  test('headings and no rows, or nothing at all', async () => {
    expect((await error(readImportFile(file('Name,Phone\n')))).message).toMatch(
      /no rows under them/,
    )
    expect((await error(readImportFile(file('')))).message).toMatch(/empty/)
  })

  test('other kinds of file', async () => {
    expect(
      (await error(readImportFile(file('x', 'clients.xls')))).message,
    ).toMatch(/older Excel file/)
    expect(
      (await error(readImportFile(file('x', 'clients.numbers')))).message,
    ).toMatch(/Numbers/)
    expect(
      (await error(readImportFile(file('x', 'clients.pdf')))).message,
    ).toMatch(/CSV and Excel/)
  })

  test('no extension: the file type decides', async () => {
    const csv = new File(['Name,Suburb\nJo,Bayswater\n'], 'clients', {
      type: 'text/csv',
    })
    expect((await readImportFile(csv)).rows).toEqual([['Jo', 'Bayswater']])
    const unknown = new File(['x'], 'clients', { type: 'image/png' })
    expect((await error(readImportFile(unknown))).message).toMatch(
      /CSV and Excel/,
    )
  })

  test('over 5 MB', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x61)
    const e = await error(readImportFile(file(big)))
    expect(e.message).toMatch(/5\.0 MB; PestM8 takes files up to 5 MB/)
  })

  test('a file that says .xlsx and isn’t one', async () => {
    const e = await error(readImportFile(file('Name\nJo\n', 'clients.xlsx')))
    expect(e.message).toMatch(/Could not read “clients.xlsx” as an Excel/)
  })
})

describe('cellToText: an Excel cell as the text a person sees', () => {
  test('whole numbers stay whole, with no exponent or grouping', () => {
    expect(cellToText(412345678)).toBe('412345678')
    expect(cellToText(51824753556)).toBe('51824753556')
    expect(cellToText(810)).toBe('810')
    expect(cellToText(0)).toBe('0')
    expect(cellToText(-0)).toBe('0')
    expect(cellToText(1e21)).toBe('1000000000000000000000')
  })

  test('fractions lose only the float noise', () => {
    expect(cellToText(12.5)).toBe('12.5')
    expect(cellToText(0.1 + 0.2)).toBe('0.3')
    expect(cellToText(Number.NaN)).toBe('')
  })

  test('dates the Australian way round, booleans in capitals, blanks empty', () => {
    expect(cellToText(new Date(Date.UTC(2024, 1, 3)))).toBe('03/02/2024')
    expect(cellToText(new Date(Number.NaN))).toBe('')
    expect(cellToText(true)).toBe('TRUE')
    expect(cellToText(false)).toBe('FALSE')
    expect(cellToText(null)).toBe('')
    expect(cellToText(undefined)).toBe('')
    expect(cellToText('  as typed ')).toBe('  as typed ')
  })
})

// ---------------------------------------------------------------- Excel

/** A CRC-32 for the zip below. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** A zip of uncompressed files: all an .xlsx needs to be. */
function zip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const out: Array<number> = []
  const central: Array<number> = []
  const u16 = (arr: Array<number>, n: number) => arr.push(n & 0xff, n >>> 8)
  const u32 = (arr: Array<number>, n: number) =>
    arr.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24)
  let count = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name)
    const data = new TextEncoder().encode(content)
    const crc = crc32(data)
    const offset = out.length
    u32(out, 0x04034b50)
    u16(out, 20)
    u16(out, 0)
    u16(out, 0)
    u16(out, 0)
    u16(out, 0)
    u32(out, crc)
    u32(out, data.length)
    u32(out, data.length)
    u16(out, nameBytes.length)
    u16(out, 0)
    out.push(...nameBytes, ...data)

    u32(central, 0x02014b50)
    u16(central, 20)
    u16(central, 20)
    u16(central, 0)
    u16(central, 0)
    u16(central, 0)
    u16(central, 0)
    u32(central, crc)
    u32(central, data.length)
    u32(central, data.length)
    u16(central, nameBytes.length)
    u16(central, 0)
    u16(central, 0)
    u16(central, 0)
    u16(central, 0)
    u32(central, 0)
    u32(central, offset)
    central.push(...nameBytes)
    count++
  }
  const centralOffset = out.length
  out.push(...central)
  u32(out, 0x06054b50)
  u16(out, 0)
  u16(out, 0)
  u16(out, count)
  u16(out, count)
  u32(out, central.length)
  u32(out, centralOffset)
  u16(out, 0)
  return new Uint8Array(out)
}

/** A one-sheet workbook as Excel saves one, its text as shared strings:
 * `sheetData` is the sheet's rows, as XML. */
function xlsx(
  strings: Array<string>,
  sheetData: string,
): Uint8Array<ArrayBuffer> {
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clients" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
  })
}

/** A cell holding shared string `i`. */
const text = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`

/** A mobile and an ABN typed as numbers, a date and a TRUE. */
function workbook(): Uint8Array<ArrayBuffer> {
  const strings = ['Name', 'Mobile', 'ABN', 'Since', 'Company?', 'Postcode']
  strings.push('Wattle Strata Pty Ltd')
  const headings = [0, 1, 2, 3, 4, 5].map((i) => text(`${'ABCDEF'[i]}1`, i))
  return xlsx(
    strings,
    `<row r="1">${headings.join('')}</row><row r="2">${text('A2', 6)}<c r="B2"><v>412345678</v></c><c r="C2"><v>51824753556</v></c><c r="D2" s="1"><v>45325</v></c><c r="E2" t="b"><v>1</v></c><c r="F2"><v>810</v></c></row>`,
  )
}

describe('reading an Excel workbook', () => {
  test("numbers, a date and a boolean come through as they're seen", async () => {
    const sheet = await readImportFile(file(workbook(), 'Clients.xlsx'))
    expect(sheet.headers).toEqual([
      'Name',
      'Mobile',
      'ABN',
      'Since',
      'Company?',
      'Postcode',
    ])
    expect(sheet.rows).toEqual([
      [
        'Wattle Strata Pty Ltd',
        '412345678',
        '51824753556',
        '03/02/2024',
        'TRUE',
        '810',
      ],
    ])
    expect(sheet.sourceRows).toEqual([2])
  })

  test('row numbers are the sheet’s, with the rows it left empty counted', async () => {
    // A title in row 1, nothing in row 2, the headings in row 3, and an
    // empty row 5 between the clients: rows Excel doesn't write at all.
    const strings = ['Client list 2024', 'Name', 'Suburb']
    strings.push('Jo Bloggs', 'Bayswater', 'Ann Lee', 'Morley')
    const sheet = await readImportFile(
      file(
        xlsx(
          strings,
          `<row r="1">${text('A1', 0)}</row>` +
            `<row r="3">${text('A3', 1)}${text('B3', 2)}</row>` +
            `<row r="4">${text('A4', 3)}${text('B4', 4)}</row>` +
            `<row r="6">${text('A6', 5)}${text('B6', 6)}</row>`,
        ),
        'Clients.xlsx',
      ),
    )
    expect(sheet.headers).toEqual(['Name', 'Suburb'])
    expect(sheet.rows).toEqual([
      ['Jo Bloggs', 'Bayswater'],
      ['Ann Lee', 'Morley'],
    ])
    expect(sheet.sourceRows).toEqual([4, 6])
  })
})
