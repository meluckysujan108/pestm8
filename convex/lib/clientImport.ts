import { v } from 'convex/values'
import { isValidAbn, normaliseAbn } from './abn'
import { emailProblem, normaliseEmail } from './email'
import { checkPhone, normalisePhone } from './phone'
import type { Infer } from 'convex/values'

/**
 * The shared contract of a client import ("Bring your clients across"): the
 * shape a client arrives in, the rules it must pass, and how "already here"
 * is decided. One copy, used by the page that reads the file
 * (src/lib/clientImport) and by the server that writes it
 * (convex/clientImports.ts) — so the review screen can never promise a row
 * the server then refuses, or the other way round.
 *
 * The page does the reading, the fixing and the explaining; the server
 * re-checks everything it is sent, because a page is not a trusted party.
 */

/** A whole file, at most. Xero itself advises splitting above 1,000. */
export const MAX_IMPORT_ROWS = 2000

/** Clients per `addBatch` call: small enough to stay well inside a
 * transaction's limits with several sites and a note each. */
export const IMPORT_BATCH_SIZE = 25

/** How long an import can be undone for. */
export const IMPORT_UNDO_DAYS = 7

export const AU_STATE_CODES = [
  'ACT',
  'NSW',
  'NT',
  'QLD',
  'SA',
  'TAS',
  'VIC',
  'WA',
] as const

/** One site (a `properties` row) as an import sends it. */
export const importSiteValidator = v.object({
  addressLine: v.string(),
  suburb: v.string(),
  state: v.string(),
  postcode: v.string(),
  siteContactName: v.optional(v.string()),
  siteContactPhone: v.optional(v.string()),
  /** Becomes a pinned site note ("gate code 1234, dog in the yard"). */
  note: v.optional(v.string()),
})

/** One client and its sites, as an import sends it. */
export const importClientValidator = v.object({
  /** The page's own id for this client, echoed back in the result. */
  key: v.string(),
  kind: v.union(v.literal('person'), v.literal('business')),
  name: v.string(),
  contactPerson: v.optional(v.string()),
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  abn: v.optional(v.string()),
  /** A client already in PestM8 with this name: its new sites are added to
   * it, and nothing of it is changed. The server checks the name matches. */
  existingClientId: v.optional(v.id('clients')),
  sites: v.array(importSiteValidator),
})

export type ImportSite = Infer<typeof importSiteValidator>
export type ImportClient = Infer<typeof importClientValidator>

/** What happened to one client of a batch. */
export const importResultValidator = v.object({
  key: v.string(),
  /**
   * `created`: a new client with its sites. `added`: new sites on a client
   * already here. `skipped`: every site was already here — nothing written.
   * `failed`: refused, with `reason`; nothing written.
   */
  status: v.union(
    v.literal('created'),
    v.literal('added'),
    v.literal('skipped'),
    v.literal('failed'),
  ),
  reason: v.optional(v.string()),
  clientId: v.optional(v.id('clients')),
  sitesCreated: v.number(),
  sitesSkipped: v.number(),
  notesCreated: v.number(),
})

export type ImportResult = Infer<typeof importResultValidator>

// ---------------------------------------------------------------- keys

/** A name as compared for "already here": case, spacing and punctuation
 * don't make two clients different. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const STREET_WORDS: Record<string, string> = {
  street: 'st',
  road: 'rd',
  avenue: 'ave',
  av: 'ave',
  drive: 'dr',
  court: 'ct',
  crescent: 'cres',
  cr: 'cres',
  place: 'pl',
  parade: 'pde',
  highway: 'hwy',
  terrace: 'tce',
  close: 'cl',
  lane: 'ln',
  boulevard: 'blvd',
  circuit: 'cct',
  grove: 'gr',
  way: 'way',
  square: 'sq',
  esplanade: 'esp',
}

/**
 * A site as compared for "already here": the same street in the same suburb
 * and postcode, however it was written — "12 Wattle Street" and "12 wattle
 * st." are one house; "Unit 2/14" and "2/14" are one unit.
 */
export function siteKey(site: {
  addressLine: string
  suburb: string
  postcode: string
}): string {
  const street = site.addressLine
    .toLowerCase()
    .replace(/\bunit\b|\bu\b|\bapartment\b|\bapt\b|\bflat\b/g, ' ')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => STREET_WORDS[word] ?? word)
    .join(' ')
    .replace(/\s*\/\s*/g, '/')
  return `${street}|${nameKey(site.suburb)}|${site.postcode.trim()}`
}

// ---------------------------------------------------------------- rules

/**
 * Why a phone can't be stored, in `checkPhone`'s words, or null when it can.
 * One rule more than `checkPhone` alone: that sets a trailing extension
 * aside before it counts digits, so a cell holding only an extension
 * ("x21") passes it — and `normalisePhone`, which counts every digit, then
 * throws. The review screen asks this as well, so it can't call a number
 * fine that the server then refuses.
 */
export function phoneProblem(raw: string): string | null {
  const check = checkPhone(raw)
  if (check.level === 'error') {
    return check.message ?? 'That is not a phone number.'
  }
  try {
    normalisePhone(raw)
  } catch {
    return 'That is too short for a phone number.'
  }
  return null
}

export type ClientCheck =
  { ok: true; client: ImportClient } | { ok: false; reason: string }

/**
 * The rules a client must pass to be written, and the values it is written
 * with — the same normalising the app's own forms use (ABN, email, phone).
 * Stricter than `properties.create`, which saves a blank name or a
 * three-digit postcode as sent: a file can hold hundreds of those, and each
 * would be a client nobody can book.
 *
 * `reason` is a sentence for the review screen. It refuses rather than
 * throws, whatever it is sent: a throw would cost the whole batch for one
 * row.
 */
export function checkImportClient(input: ImportClient): ClientCheck {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) return { ok: false, reason: 'No client name.' }
  if (name.length > 200) return { ok: false, reason: 'The name is too long.' }
  if (input.sites.length === 0) {
    return {
      ok: false,
      reason: 'No address — a client needs at least one site.',
    }
  }

  const sites: Array<ImportSite> = []
  for (const site of input.sites) {
    const addressLine = site.addressLine.trim().replace(/\s+/g, ' ')
    const suburb = site.suburb.trim().replace(/\s+/g, ' ')
    const state = site.state.trim().toUpperCase()
    const postcode = site.postcode.trim()
    if (!addressLine)
      return { ok: false, reason: 'A site has no street address.' }
    if (!suburb) return { ok: false, reason: `No suburb for ${addressLine}.` }
    if (!(AU_STATE_CODES as ReadonlyArray<string>).includes(state)) {
      return { ok: false, reason: `No Australian state for ${addressLine}.` }
    }
    if (!/^\d{4}$/.test(postcode)) {
      return {
        ok: false,
        reason: `The postcode for ${addressLine} is not four digits.`,
      }
    }
    // A business's only: a person's is dropped below, so it can't refuse
    // them either.
    const siteContactPhone =
      input.kind === 'business' ? site.siteContactPhone?.trim() : undefined
    if (siteContactPhone && phoneProblem(siteContactPhone)) {
      return {
        ok: false,
        reason: `The site contact's phone for ${addressLine} is not a phone number.`,
      }
    }
    sites.push({
      addressLine,
      suburb,
      state,
      postcode,
      ...(input.kind === 'business' && site.siteContactName?.trim()
        ? { siteContactName: site.siteContactName.trim() }
        : {}),
      ...(siteContactPhone
        ? { siteContactPhone: normalisePhone(siteContactPhone) }
        : {}),
      ...(site.note?.trim() ? { note: site.note.trim().slice(0, 5000) } : {}),
    })
  }

  const email = input.email?.trim()
  if (email && emailProblem(email)) {
    return { ok: false, reason: `${email} is not an email address.` }
  }
  const phone = input.phone?.trim()
  if (phone && phoneProblem(phone)) {
    return { ok: false, reason: `${phone} is not a phone number.` }
  }
  const abn = input.kind === 'business' ? input.abn?.trim() : undefined
  if (abn && !isValidAbn(abn)) {
    return { ok: false, reason: 'The ABN does not pass the ATO check.' }
  }

  return {
    ok: true,
    client: {
      key: input.key,
      kind: input.kind,
      name,
      ...(input.kind === 'business' && input.contactPerson?.trim()
        ? { contactPerson: input.contactPerson.trim() }
        : {}),
      ...(phone ? { phone: normalisePhone(phone) } : {}),
      ...(email ? { email: normaliseEmail(email) } : {}),
      ...(abn ? { abn: normaliseAbn(abn) } : {}),
      ...(input.existingClientId
        ? { existingClientId: input.existingClientId }
        : {}),
      sites,
    },
  }
}
