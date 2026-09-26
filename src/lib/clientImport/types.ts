import type { Id } from '../../../convex/_generated/dataModel'
import type { ImportSite } from '../../../convex/lib/clientImport'

/**
 * The import page's side of "Bring your clients across": the types the
 * reading, matching and review steps pass between them. The server's side,
 * and the rules both sides share, are in convex/lib/clientImport.ts.
 *
 *   file ──readImportFile──▶ ImportSheet
 *        ──autoMap─────────▶ ColumnMapping (the person can change it)
 *        ──buildReview─────▶ ReviewClient[] (grouped, fixed, flagged)
 *        ──runOfflineChecks▶ ReviewClient[] (+ address warnings)
 *        ──toImportClient──▶ ImportClient, sent in batches
 */

/** What a column can be. `null` in a mapping means "don't import". */
export type ImportField =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'contactPerson'
  | 'isCompany'
  | 'email'
  | 'phone'
  | 'mobile'
  | 'abn'
  | 'address'
  | 'street'
  | 'street2'
  | 'suburb'
  | 'state'
  | 'postcode'
  | 'siteContactName'
  | 'siteContactPhone'
  | 'notes'

/** One entry per column of the sheet, in order. */
export type ColumnMapping = Array<ImportField | null>

/** A file as read: its header row, and every row after it, as text. */
export type ImportSheet = {
  fileName: string
  headers: Array<string>
  /** Data rows only. Each is padded or cut to `headers.length`. */
  rows: Array<Array<string>>
  /** Each data row's number as the person's spreadsheet shows it (the
   * heading row, and any title or blank rows above or between, counted),
   * for messages that point at a row. Absent: data row i is row i + 2. */
  sourceRows?: Array<number>
}

/** The app a file looks like it came from, by its headers. */
export type SourceApp =
  | 'Jobber'
  | 'Xero'
  | 'MYOB'
  | 'GorillaDesk'
  | 'ServiceM8'
  | 'Tradify'
  | 'Housecall Pro'

/**
 * Something the review screen says about a client:
 *  - `fixed`: already put right, shown so nothing changes unseen
 *    ("Postcode 810 → 0810").
 *  - `warning`: can be imported as it is, but worth a look ("Bayswater is
 *    usually 6053, not 6035"), often with a one-tap fix.
 *  - `error`: will not be imported until fixed ("No street address").
 */
export type ReviewIssue = {
  level: 'fixed' | 'warning' | 'error'
  /** What it is about, for the edit sheet to focus. */
  field:
    | 'name'
    | 'contactPerson'
    | 'email'
    | 'phone'
    | 'abn'
    | 'addressLine'
    | 'suburb'
    | 'state'
    | 'postcode'
    | 'siteContactPhone'
    | 'note'
  /** Which site, for a site field. */
  siteIndex?: number
  message: string
  /** A one-tap fix: the button's words and the client it makes. */
  fix?: { label: string; apply: (client: ReviewClient) => ReviewClient }
}

export type ReviewSite = ImportSite & {
  /** Already in PestM8 (same street, suburb and postcode): not imported. */
  duplicate?: boolean
  /** For a duplicate, the client in PestM8 it is on, when that is another
   * client than this one ("Already in PestM8, on Jane Doe"). Never sent. */
  heldBy?: string
}

export type ReviewClient = {
  /** Stable for the life of the review. */
  key: string
  /** The file's row numbers this client came from (1 = the first data row),
   * for the "rows not imported" download. */
  rowNumbers: Array<number>
  /** The same rows as the person's spreadsheet numbers them (`sourceRows`),
   * for messages that point at one: "Same address as Jo Smith (row 7)".
   * Absent: each of `rowNumbers` plus 1. */
  sheetRows?: Array<number>
  kind: 'person' | 'business'
  name: string
  contactPerson?: string
  phone?: string
  email?: string
  abn?: string
  sites: Array<ReviewSite>
  /** A client of this name is already in PestM8: new sites join it. */
  existingClientId?: Id<'clients'>
  issues: Array<ReviewIssue>
  /** The person can leave a client out. */
  included: boolean
}

/** How the review screen files a client, in this order of precedence. */
export type ReviewStatus =
  | 'error' // won't import until fixed
  | 'duplicate' // every site already in PestM8
  | 'warning' // needs a look
  | 'fixed' // fine, with something put right
  | 'ready'

/** What PestM8 already holds, for "already here". Built from
 * `api.clients.list` and `api.properties.list`. */
export type ExistingIndex = {
  /** `nameKey(name)` → the client. */
  clientsByName: Map<string, Id<'clients'>>
  /** `siteKey(site)` of every site already in PestM8. */
  siteKeys: Set<string>
  /** `siteKey(site)` → the name of the client that site is on, so the review
   * can say whose it is when that isn't the client being imported. */
  siteHolders?: Map<string, string>
}
