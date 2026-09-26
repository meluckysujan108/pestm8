import { describe, expect, test } from 'vitest'
import { ImportFileError, cellToText, readImportFile } from './read'

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
  })

  test('blank rows go, cells are trimmed, rows are as wide as the headings', async () => {
    const sheet = await readImportFile(
      file(
        '\n,,\nName , Phone,,\n  Jo  ,0412\n\n,,\nAnn\nBo,0400,extra,more\n',
      ),
    )
    expect(sheet.headers).toEqual(['Name', 'Phone'])
    expect(sheet.rows).toEqual([
      ['Jo', '0412'],
      ['Ann', ''],
      ['Bo', '0400'],
    ])
  })

  test('a heading left blank is named for its column', async () => {
    const sheet = await readImportFile(file('Name,,Phone\nJo,x,0412\n'))
    expect(sheet.headers).toEqual(['Name', 'Column B', 'Phone'])
  })

  test("MYOB's {} line above the headings is passed over", async () => {
    const sheet = await readImportFile(
      file('{}\nCo./Last Name,First Name,Card ID\nSmith,Jo,*None\n', 'x.txt'),
    )
    expect(sheet.headers).toEqual(['Co./Last Name', 'First Name', 'Card ID'])
    expect(sheet.rows).toHaveLength(1)
  })

  test('a quote mark never closed is an error, not a swallowed file', async () => {
    const e = await error(
      readImportFile(file('Name,Notes\nJo,"gate\nAnn,dog\nBo,cat\n')),
    )
    expect(e.message).toMatch(/quote mark/)
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
    expect(e.message).toMatch(/Couldn't read “clients.xlsx” as an Excel/)
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

/** A one-sheet workbook as Excel saves one: text as shared strings, a
 * mobile and an ABN typed as numbers, a date and a TRUE. */
function workbook(): Uint8Array<ArrayBuffer> {
  const strings = ['Name', 'Mobile', 'ABN', 'Since', 'Company?', 'Postcode']
  strings.push('Wattle Strata Pty Ltd')
  const s = (i: number) => `<c r="${'ABCDEF'[i]}1" t="s"><v>${i}</v></c>`
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
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${[0, 1, 2, 3, 4, 5].map(s).join('')}</row><row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2"><v>412345678</v></c><c r="C2"><v>51824753556</v></c><c r="D2" s="1"><v>45325</v></c><c r="E2" t="b"><v>1</v></c><c r="F2"><v>810</v></c></row></sheetData></worksheet>`,
  })
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
  })
})
