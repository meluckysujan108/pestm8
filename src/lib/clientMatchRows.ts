import {
  addressNear,
  emailKeys,
  isPlaceholderName,
  nameKey,
  nameNear,
  phoneKeys,
  phoneKind,
  siteKey,
} from '../../convex/lib/contactKeys'
import {
  MATCH_ROWS_MAX,
  matchNewClient,
  matchNewSite,
} from '../../convex/lib/clientMatch'
import { MAX_JOB_NOTES_LENGTH } from '../../convex/lib/jobNotes'
import { formatUpdated } from './format'
import { pickerName } from './propertyOptions'
import type {
  Candidate,
  Evidence,
  MatchClient,
  MatchIndex,
  MatchResult,
  MatchSite,
  SharedRow,
  Tier,
  TypedAddress,
  TypedClient,
} from '../../convex/lib/clientMatch'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Is the caller already a client? What New Job, Clients → New client and Add
 * property say about it (the matching plan's M3, §2.6–2.8): the matcher's
 * candidates (convex/lib/clientMatch.ts) turned into the panel's rows at
 * Book, the line under Name, Phone or Email as the person moves on, and what
 * each one-tap fix does. Pure, so every row's words are tested without a
 * sheet.
 *
 * The rules the words keep: names, never pronouns ("Jane Nguyen’s", not
 * "hers"); "mobile" for an 04 number, else "number"; "(archived)" or
 * "(inactive)" after a client's name; "different name" or "different
 * address" only for what was typed; curly apostrophes and spaced em dashes.
 *
 * Nothing here rewrites what was typed: each fix is the person's tap, and
 * what the caller said that the client chosen doesn't already have goes
 * with the booking (`callerLine`, `siteContactCarry`), where it can be seen
 * and edited before Book.
 */

/** What a fix does. The form turns it into setters (`planMatchFix`). */
export type MatchFix =
  /** Book at one of the client's sites: existing mode, that site chosen. */
  | {
      kind: 'bookAt'
      label: string
      clientId: Id<'clients'>
      propertyId: Id<'properties'>
    }
  /** A new site for the client at the address typed (or at the client's
   * own site there, should it be one). `choose`, from the line under Name:
   * tapped while no address is typed, the Property picker with this typed
   * instead, so one of their sites can be chosen (`planMatchFix`). */
  | { kind: 'use'; label: string; clientId: Id<'clients'>; choose?: string }
  /** A new site for the client at the address as typed, though it is like
   * one of theirs: the person has seen it, and isn't asked again. */
  | { kind: 'add'; label: string; clientId: Id<'clients'> }
  /** The Property picker opened with `query` typed, the keyboard down. */
  | { kind: 'show'; label: string; query: string }
  /** Clients → New client: the client's sheet, with Add property open on
   * the address typed as it is tapped, unless none is typed or it is theirs
   * already (`openFromNewClient`). `onDetails`: the row or line only shows
   * who the caller may be (what New Job offers Show them for: a mobile or
   * email on their record with no name agreeing, a landline agreeing only
   * by an initial), so their sheet opens as it is, with nothing to add. */
  | {
      kind: 'open'
      label: string
      clientId: Id<'clients'>
      onDetails?: true
    }

/** One row of the panel at Book. */
export type MatchRow = {
  /** Stable for the same client and evidence, so a second press with the
   * same rows books. */
  id: string
  tier: Tier | 'shared' | 'more'
  label: string
  message: string
  fix?: MatchFix
  fix2?: MatchFix
}

/** The line under Name, Phone or Email once focus has moved on. */
export type MatchLine = { text: string; fix?: MatchFix; fix2?: MatchFix }

export type MatchRowsContext = {
  index: MatchIndex
  /** Business clients' contact people, for a candidate found through one. */
  contacts: ReadonlyArray<{ _id: string; clientId: string; name: string }>
  /** What a fix does: books in New Job, or opens the client (Clients → New
   * client, where nothing is booked). */
  verb: 'book' | 'open'
}

const MOBILE = 'mobile'

/** A client's name as a row names them: "Sam Wu (archived)", "Sam Wu
 * (inactive)". */
export function matchName(client: MatchClient | undefined): string {
  if (!client) return 'another client'
  if (client.archivedAt === undefined && client.status === 'inactive') {
    return `${client.name} (inactive)`
  }
  return pickerName(client)
}

/**
 * What is a client's, with the tag `matchName` gives them after it rather
 * than inside the possessive: "Sam Wu’s (inactive)", "Sam Wu’s line
 * (inactive)", "Choose Sam Wu’s site (archived)"; "Jane Nguyen’s" for a
 * client with none. `tag: false` where the sentence has named them with it
 * already ("Sam Wu (inactive) has the same name. 12 Watle St looks like Sam
 * Wu’s 12 Wattle St, Bayswater.").
 */
export function possessive(
  client: MatchClient | undefined,
  what = '',
  { tag = true }: { tag?: boolean } = {},
): string {
  const thing = what === '' ? '' : ` ${what}`
  if (!client) return `another client’s${thing}`
  const tagged = tag ? matchName(client).slice(client.name.length) : ''
  return `${client.name}’s${thing}${tagged}`
}

/** "inactive" or "archived", as `matchName` tags the client, or null. */
function tagWord(client: MatchClient | undefined): string | null {
  if (!client) return null
  const tagged = matchName(client).slice(client.name.length).trim()
  return tagged === '' ? null : tagged.slice(1, -1)
}

/** "name, address and mobile". */
function join(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function siteText(site: Pick<MatchSite, 'addressLine' | 'suburb'>): string {
  return `${site.addressLine}, ${site.suburb}`
}

function sitesOf(index: MatchIndex, clientId: Id<'clients'>) {
  return index.sitesOf.get(clientId) ?? []
}

function siteOf(
  index: MatchIndex,
  clientId: Id<'clients'>,
  propertyId: Id<'properties'>,
): MatchSite | undefined {
  return sitesOf(index, clientId).find((s) => s._id === propertyId)
}

/** "Jane Nguyen, of Bayswater," or, with no site, "Jane Nguyen": who
 * a sentence is about, before its verb. */
function whoOf(index: MatchIndex, clientId: Id<'clients'>): string {
  const name = matchName(index.clients.get(clientId))
  const suburb = sitesOf(index, clientId)[0]?.suburb
  return suburb ? `${name}, of ${suburb},` : name
}

/** What a typed phone is called: "mobile" for an 04, else "number". */
export function numberNoun(
  phone: string | undefined,
  areaCode: string,
): string {
  const key = phoneKeys(phone, areaCode).at(0)
  return key !== undefined && phoneKind(key) === 'mobile' ? MOBILE : 'number'
}

/** The keys a candidate agreed on, in words: "mobile", "number", "email". */
function keyWords(evidence: ReadonlySet<Evidence>): Array<string> {
  const words: Array<string> = []
  if (evidence.has('mobile')) words.push(MOBILE)
  if (evidence.has('landline')) words.push('number')
  if (evidence.has('email')) words.push('email')
  return words
}

/** "the same name and mobile", "a similar name and the same mobile". */
function hasClause(evidence: ReadonlySet<Evidence>, address = false): string {
  const rest = [...(address ? ['address'] : []), ...keyWords(evidence)]
  if (evidence.has('name')) return `the same ${join(['name', ...rest])}`
  return rest.length > 0
    ? `a similar name and the same ${join(rest)}`
    : 'a similar name'
}

/** "Same name and address.", "Similar name, same mobile." */
function sameSentence(
  evidence: ReadonlySet<Evidence>,
  address = false,
): string {
  const rest = [...(address ? ['address'] : []), ...keyWords(evidence)]
  if (evidence.has('name')) return `Same ${join(['name', ...rest])}.`
  return rest.length > 0 ? `Similar name, same ${join(rest)}.` : 'Similar name.'
}

/** What was typed that a candidate holds none of, for "with a different
 * mobile and address": only what was typed. */
function differentWords(typed: TypedClient, areaCode: string): Array<string> {
  const words: Array<string> = []
  if (typed.phone?.trim()) words.push(numberNoun(typed.phone, areaCode))
  if (typed.email?.trim()) words.push('email')
  if (typed.site?.addressLine.trim()) words.push('address')
  return words
}

/** The query "Show them" opens the Property picker with: the number or
 * email typed, else the name. */
function showQuery(typed: TypedClient): string {
  return typed.phone?.trim() || typed.email?.trim() || typed.name?.trim() || ''
}

function show(query: string, label = 'Show them'): MatchFix {
  return { kind: 'show', label, query }
}

/**
 * Every fix as Clients → New client has it: "Open {client}". One fix a row:
 * there is nothing to choose between there. Whether their sheet opens on
 * Add property is decided as it is tapped, from what is typed then
 * (`openFromNewClient`), so a row and a line for one client open it alike;
 * never for a row or line that only shows who the caller may be (`shows`).
 */
function forVerb(
  ctx: MatchRowsContext,
  row: { fix?: MatchFix; fix2?: MatchFix },
  clientId: Id<'clients'> | undefined,
  shows = false,
): { fix?: MatchFix; fix2?: MatchFix } {
  if (ctx.verb === 'book') return row
  if (!clientId) return {}
  return {
    fix: {
      kind: 'open',
      label: `Open ${matchName(ctx.index.clients.get(clientId))}`,
      clientId,
      ...(shows ? { onDetails: true as const } : {}),
    },
  }
}

/** An address as a form holds it, for a client's Add property. */
export type SiteAddress = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
}

/**
 * What Open {client} opens Add property on, as it is tapped in Clients →
 * New client: the address typed then, unless no street is typed yet (an
 * empty Add property is nothing to open on) or it is one of their sites
 * already (their sheet lists it, and nothing is added). Undefined for
 * neither, so their sheet opens on Details as it is.
 */
export function openAddSite(
  index: MatchIndex,
  clientId: Id<'clients'>,
  typed: SiteAddress,
): SiteAddress | undefined {
  if (typed.addressLine.trim() === '') return undefined
  const key = siteKey(typed)
  const theirs = sitesOf(index, clientId).some(
    (s) => index.siteKeys.get(s._id) === key,
  )
  return theirs
    ? undefined
    : {
        addressLine: typed.addressLine,
        suburb: typed.suburb,
        state: typed.state,
        postcode: typed.postcode,
      }
}

/** What Clients → New client holds as Open {client} is tapped. */
export type TypedNewClient = SiteAddress & {
  name: string
  phone: string
  email: string
}

/** What Open {client} does (`openFromNewClient`). */
export type OpenedClient = {
  /** Add property opened on this, with the caller as a business's site
   * contact; else their sheet as it is, on Details. */
  addSite?: SiteAddress & { siteContactName: string; siteContactPhone: string }
  /** Something typed went nowhere: New client keeps it all, to be had back
   * by opening it again, rather than throwing it away unasked. */
  keepDraft: boolean
}

/**
 * Open {client} tapped in Clients → New client (the matching plan's §2.10):
 * their sheet, with Add property open on the address typed, unless none is
 * typed, it is theirs already (`openAddSite`), or the row only shows who
 * the caller may be (`onDetails`). A business's new site has the caller as
 * its site contact (`siteContactCarry`, §2.8), as New site for does in New
 * Job.
 *
 * What was typed is thrown away only where all of it went with the open or
 * is the client's already: the caller is them. Anything else (another
 * name, a number or an email not theirs, an address not carried) keeps New
 * client as it was typed, to be opened again: the caller may well be
 * someone else, and typing it all again while they wait is the cost.
 */
export function openFromNewClient(
  index: MatchIndex,
  contacts: ReadonlyArray<ContactOf>,
  fix: Extract<MatchFix, { kind: 'open' }>,
  typed: TypedNewClient,
): OpenedClient {
  const client = index.clients.get(fix.clientId)
  if (!client) return { keepDraft: true }
  const address = fix.onDetails
    ? undefined
    : openAddSite(index, fix.clientId, typed)
  // A business's new site takes the caller as its site contact.
  const asContact = address !== undefined && client.kind === 'business'
  const own = contactsOfClient(contacts, client._id)
  const name = typed.name.trim()
  const phone = typed.phone.trim()
  const email = typed.email.trim()
  const wentNowhere =
    (name !== '' && !asContact && !nameAgrees(name, client, own)) ||
    (phone !== '' &&
      !asContact &&
      !phoneHeld(
        phone,
        [client.phone, ...own.map((k) => k.phone)],
        index.areaCode,
      )) ||
    (email !== '' &&
      !emailHeld(email, [client.email, ...own.map((k) => k.email)])) ||
    // An address typed, neither carried nor theirs.
    (address === undefined &&
      openAddSite(index, client._id, typed) !== undefined)
  return {
    ...(address
      ? {
          addSite: {
            ...address,
            ...(asContact
              ? siteContactCarry(
                  { name, phone },
                  client,
                  contacts,
                  index.areaCode,
                )
              : { siteContactName: '', siteContactPhone: '' }),
          },
        }
      : {}),
    keepDraft: fix.onDetails === true || wentNowhere,
  }
}

/** A candidate's row at Book (§2.7). */
function candidateRow(
  ctx: MatchRowsContext,
  typed: TypedClient,
  c: Candidate,
): MatchRow {
  const { index } = ctx
  const ev = new Set(c.evidence)
  const them = index.clients.get(c.clientId)
  const name = matchName(them)
  const agrees = ev.has('name') || ev.has('nameNear')
  const typedName = typed.name?.trim() ?? ''
  const typedAddress = typed.site?.addressLine.trim() ?? ''
  const use: MatchFix = {
    kind: 'use',
    label: `Use ${name}`,
    clientId: c.clientId,
  }
  const base = { id: `match:${c.clientId}`, tier: c.tier }
  const done = (
    label: string,
    message: string,
    fixes: { fix?: MatchFix; fix2?: MatchFix },
    shows = false,
  ): MatchRow => ({
    ...base,
    label,
    message,
    ...forVerb(ctx, fixes, c.clientId, shows),
  })
  // Found through a contact person whose name agrees (Sarah Lee at Ray White
  // Bayswater): the name that agreed is the contact's, not the client's.
  const contact = c.contactId && ctx.contacts.find((k) => k._id === c.contactId)

  if (c.tier === 'maybe') {
    const different = differentWords(typed, index.areaCode)
    return done(
      'Same name',
      `${whoOf(index, c.clientId)} has the same name${
        different.length > 0 ? `, with a different ${join(different)}` : ''
      }.`,
      { fix: use },
    )
  }

  const atSite = c.siteIds[0] && siteOf(index, c.clientId, c.siteIds[0])
  if (atSite) {
    const bookAt: MatchFix = {
      kind: 'bookAt',
      label: agrees ? `Book at ${atSite.addressLine}` : `Book on ${name}`,
      clientId: c.clientId,
      propertyId: atSite._id,
    }
    return agrees
      ? done(
          'Already a client',
          `${siteText(atSite)} is ${possessive(them)}${
            contact ? `, and ${contact.name} is a contact there` : ''
          }. ${sameSentence(ev, true)}`,
          { fix: bookAt },
        )
      : done(
          'Already a site',
          `${siteText(atSite)} is ${possessive(them)}. Same address${
            typedName ? ', different name' : ''
          }.`,
          { fix: bookAt },
        )
  }

  const keys = keyWords(ev)
  // The name agrees with a key of theirs: Same, or Likely only because the
  // copy can't say who else holds a number (`complete: false`). Not a
  // landline whose name agrees only as an initial: that is anyone in the
  // house, and is shown, below.
  const nearLandline =
    ev.has('landline') &&
    !ev.has('name') &&
    !ev.has('mobile') &&
    !ev.has('email')
  const sameKey =
    agrees && keys.length > 0 && (c.tier === 'same' || !nearLandline)
  if (sameKey && contact) {
    const count = sitesOf(index, c.clientId).length
    return done(
      'Already a client',
      `${contact.name} is a contact at ${name}${
        count > 0 ? ` (${plural(count, 'site')})` : ''
      }. ${sameSentence(ev)}`,
      { fix: use },
    )
  }

  const likeId = c.nearSiteIds[0] ?? c.streetSiteIds[0]
  const like = likeId && siteOf(index, c.clientId, likeId)
  const likeFixes = (site: MatchSite) => ({
    fix: {
      kind: 'bookAt' as const,
      label: `Book at ${site.addressLine}`,
      clientId: c.clientId,
      propertyId: site._id,
    },
    fix2: {
      kind: 'add' as const,
      label: `Add ${typedAddress}`,
      clientId: c.clientId,
    },
  })

  if (sameKey) {
    if (like && typedAddress) {
      return done(
        'Already a client',
        `${name} has ${hasClause(ev)}. ${typedAddress} looks like ${possessive(them, siteText(like), { tag: false })}.`,
        likeFixes(like),
      )
    }
    return done(
      'Already a client',
      `${whoOf(index, c.clientId)} has ${hasClause(ev)}.`,
      { fix: use },
    )
  }

  if (!agrees && (ev.has('mobile') || ev.has('email'))) {
    const isMobile = ev.has('mobile')
    const shown = (isMobile ? typed.phone : typed.email)?.trim() ?? ''
    const suburb = sitesOf(index, c.clientId)[0]?.suburb
    const what = isMobile ? MOBILE : 'email'
    return done(
      `Same ${what}`,
      `${shown} is ${possessive(them)}${suburb ? `, of ${suburb}` : ''}. Same ${what}${
        typedName ? ', different name' : ''
      }.`,
      // Agency, strata and family numbers sit on one owner's record too:
      // with no name agreeing, the client is shown, never one tap away.
      { fix: show(shown) },
      true,
    )
  }

  if (agrees) {
    const sameName = ev.has('name') ? 'the same name' : 'a similar name'
    if (nearLandline) {
      return done(
        'Already a client',
        `${
          contact
            ? `${contact.name}, a contact at ${name},`
            : whoOf(index, c.clientId)
        } has a similar name and the same number.`,
        { fix: show(typed.phone?.trim() ?? '') },
        true,
      )
    }
    const street =
      c.streetSiteIds[0] && siteOf(index, c.clientId, c.streetSiteIds[0])
    if (street) {
      return done(
        'Already a client',
        `${name} has ${sameName}, and ${street.addressLine} in ${street.suburb}, the same postcode.`,
        {
          fix: {
            kind: 'bookAt',
            label: `Book at ${siteText(street)}`,
            clientId: c.clientId,
            propertyId: street._id,
          },
        },
      )
    }
    const near = c.nearSiteIds[0] && siteOf(index, c.clientId, c.nearSiteIds[0])
    if (near && typedAddress) {
      return done(
        'Already a client',
        `${name} has ${sameName}. ${typedAddress} looks like ${possessive(them, siteText(near), { tag: false })}.`,
        likeFixes(near),
      )
    }
    if (ev.has('shared') && c.shared.length > 0) {
      const key = c.shared[0]
      const shown = (key.field === 'phone' ? typed.phone : typed.email)?.trim()
      return done(
        'Already a client',
        `${whoOf(index, c.clientId)} has ${sameName}. ${shown} is ${
          key.holders > 1
            ? `on ${plural(key.holders, 'client')}`
            : 'a business’s line'
        }.`,
        { fix: use },
      )
    }
  }

  const contactSite =
    c.siteContactSiteIds[0] &&
    siteOf(index, c.clientId, c.siteContactSiteIds[0])
  if (contactSite) {
    return done(
      'Already a site',
      `${contactSite.siteContactName ?? typedName} is the site contact at ${siteText(contactSite)} (${possessive(them, '', { tag: false })}${
        tagWord(them) ? `, ${tagWord(them)}` : ''
      }). Same name and ${numberNoun(typed.phone, index.areaCode)}.`,
      {
        fix: {
          kind: 'bookAt',
          label: `Book at ${contactSite.addressLine}`,
          clientId: c.clientId,
          propertyId: contactSite._id,
        },
      },
    )
  }

  return done(
    'Already a client',
    `${whoOf(index, c.clientId)} may be the same customer.`,
    { fix: use },
  )
}

/** "08 9272 1234 is on 6 clients — Ray White Bayswater and 5 others." */
function sharedText(index: MatchIndex, row: SharedRow, shown: string): string {
  const n = row.clientIds.length
  const holder = index.clients.get(row.clientIds[0])
  const first = matchName(holder)
  if (n > 1) {
    return `${shown} is on ${plural(n, 'client')} — ${first} and ${plural(
      n - 1,
      'other',
    )}.`
  }
  const key = row.keys[0]
  if (key.reason === 'line') return `${shown} is ${possessive(holder, 'line')}.`
  if (key.reason === 'landline') {
    return `${shown} is ${possessive(holder, 'number')}.`
  }
  // One business holds it: an agency's office line, rentals@, or a contact
  // person's own number there.
  const holdings =
    (key.field === 'phone' ? index.phones : index.emails).get(key.key) ?? []
  const viaContact = holdings.find((h) => h.contactId !== undefined)
  if (viaContact)
    return `${shown} is ${viaContact.name}’s, a contact at ${first}.`
  const noun =
    key.field === 'email'
      ? 'email'
      : phoneKind(key.key) === 'mobile'
        ? MOBILE
        : 'number'
  return `${shown} is ${possessive(holder, noun)}.`
}

function typedFor(typed: TypedClient, field: 'phone' | 'email'): string {
  return (field === 'phone' ? typed.phone : typed.email)?.trim() ?? ''
}

/** A shared key's row in the panel: only ever beside other rows. */
function sharedRow(
  ctx: MatchRowsContext,
  typed: TypedClient,
  row: SharedRow,
): MatchRow {
  const field = row.keys[0].field
  const shown = typedFor(typed, field)
  const business = row.businessClientId
  const fixes: { fix?: MatchFix; fix2?: MatchFix } = {
    fix: show(shown),
    ...(business
      ? {
          fix2: {
            kind: 'use',
            label: `New site for ${matchName(ctx.index.clients.get(business))}`,
            clientId: business,
          },
        }
      : {}),
  }
  return {
    id: `match:shared:${field}:${row.keys[0].key}`,
    tier: 'shared',
    label: field === 'phone' ? 'Shared number' : 'Shared email',
    message: sharedText(ctx.index, row, shown),
    ...(ctx.verb === 'book' ? fixes : forVerb(ctx, {}, business)),
  }
}

/**
 * The rows at Book for a new client as typed: one per client, at most
 * MATCH_ROWS_MAX, then "And 2 more" with Show them; then the keys others
 * share, only beside those. A Shared result alone is no row at all, so
 * Book books at once (FW9): the agency's office number on six clients
 * proves nothing about who rang.
 */
export function newClientRows(
  ctx: MatchRowsContext,
  typed: TypedClient,
  result: MatchResult = matchNewClient(ctx.index, typed),
): Array<MatchRow> {
  if (result.candidates.length === 0) return []
  const shown = result.candidates.slice(0, MATCH_ROWS_MAX)
  const more = result.candidates.length - shown.length
  const rows = shown.map((c) => candidateRow(ctx, typed, c))
  if (more > 0) {
    rows.push({
      id: 'match:more',
      tier: 'more',
      label: `And ${more} more`,
      message:
        more === 1
          ? 'Another client matches part of what was typed.'
          : `${more} other clients match part of what was typed.`,
      ...(ctx.verb === 'book' ? { fix: show(showQuery(typed)) } : {}),
    })
  }
  for (const row of result.shared) rows.push(sharedRow(ctx, typed, row))
  return rows
}

/** "Add 12 Watle St" tapped for a client: that address is theirs to add,
 * and isn't asked about again. */
export type AddedAnyway = { clientId: Id<'clients'>; siteKey: string }

/**
 * New site for {client}: whether they have the address already, or one
 * like it. Another client holding it is no row: the person chose the
 * client, and a sold house or a managing agency is the usual reason.
 */
export function newSiteRows(
  ctx: MatchRowsContext,
  clientId: Id<'clients'>,
  typed: TypedAddress,
  added: AddedAnyway | null = null,
): Array<MatchRow> {
  const result = matchNewSite(ctx.index, clientId, typed)
  const c = result.candidates.at(0)
  if (!c) return []
  const chosen = ctx.index.clients.get(clientId)
  const name = matchName(chosen)
  const typedAddress = typed.addressLine.trim()
  const exact = c.siteIds[0] && siteOf(ctx.index, clientId, c.siteIds[0])
  if (exact) {
    return [
      {
        id: `match:${clientId}`,
        tier: c.tier,
        label: 'Already has this site',
        message: `${name} already has ${siteText(exact)}.`,
        fix: {
          kind: 'bookAt',
          label: 'Book at this site',
          clientId,
          propertyId: exact._id,
        },
      },
    ]
  }
  if (
    added &&
    added.clientId === clientId &&
    added.siteKey === siteKey(typed)
  ) {
    return []
  }
  const near = c.nearSiteIds[0] && siteOf(ctx.index, clientId, c.nearSiteIds[0])
  if (!near) return []
  return [
    {
      id: `match:${clientId}`,
      tier: c.tier,
      label: 'Already has this site',
      // The tag in a sentence of its own: after the address, it would read
      // as the site's.
      message: `${typedAddress} looks like ${possessive(chosen, siteText(near), { tag: false })}.${
        tagWord(chosen) ? ` ${chosen?.name} is ${tagWord(chosen)}.` : ''
      }`,
      fix: {
        kind: 'bookAt',
        label: `Book at ${near.addressLine}`,
        clientId,
        propertyId: near._id,
      },
      fix2: { kind: 'add', label: `Add ${typedAddress}`, clientId },
    },
  ]
}

/**
 * New Job's check at Book, by its client mode: a new client as typed, a new
 * site for the client chosen, and nothing at all for an existing site,
 * which was chosen from the book. Synchronous: the check answers in the
 * press, with no "Checking…".
 */
export function bookingMatchRows(
  ctx: MatchRowsContext,
  at:
    | { mode: 'existing' }
    | { mode: 'new'; typed: TypedClient }
    | {
        mode: 'site'
        clientId: Id<'clients'> | null
        site: TypedAddress
        added: AddedAnyway | null
      },
): Array<MatchRow> {
  if (at.mode === 'existing') return []
  if (at.mode === 'new') return newClientRows(ctx, at.typed)
  return at.clientId ? newSiteRows(ctx, at.clientId, at.site, at.added) : []
}

/** A site of the client's own, as Add property on their sheet has it. */
export type OwnSite = {
  _id: Id<'properties'>
  addressLine: string
  suburb: string
  postcode: string
}

/**
 * Add property on a client's sheet: "Already has this site" for an address
 * that is one of theirs, or like one ("12 Watle St"), with Use 12 Wattle St
 * where the form can open that site.
 */
export function ownSiteRows(
  clientName: string,
  sites: ReadonlyArray<OwnSite>,
  typed: TypedAddress,
): Array<{ id: string; label: string; message: string; site: OwnSite }> {
  const typedAddress = typed.addressLine.trim()
  if (typedAddress === '') return []
  const key = siteKey(typed)
  const exact = sites.find((s) => siteKey(s) === key)
  if (exact) {
    return [
      {
        id: 'match:own-site',
        label: 'Already has this site',
        message: `${clientName} already has ${siteText(exact)}.`,
        site: exact,
      },
    ]
  }
  const near = sites.find((s) => addressNear(typed, s))
  return near
    ? [
        {
          id: 'match:own-site',
          label: 'Already has this site',
          message: `${typedAddress} looks like ${clientName}’s ${siteText(near)}.`,
          site: near,
        },
      ]
    : []
}

/** What the fixes of a client found by a key do, by how many sites they
 * have: book at the one, choose among several, or a new site. */
function siteFixFor(
  ctx: MatchRowsContext,
  clientId: Id<'clients'>,
  query: string,
): MatchFix {
  const client = ctx.index.clients.get(clientId)
  const name = matchName(client)
  const sites = sitesOf(ctx.index, clientId)
  if (sites.length === 1) {
    return {
      kind: 'bookAt',
      label: `Book at ${sites[0].addressLine}`,
      clientId,
      propertyId: sites[0]._id,
    }
  }
  if (sites.length > 1)
    return show(query, `Choose ${possessive(client, 'site')}`)
  return { kind: 'use', label: `New site for ${name}`, clientId }
}

/**
 * The fix under Name for the one client with that name. The name says
 * nothing about where the caller is, so it never books one of their sites
 * outright, and it is left before the address in the form's order (C11):
 * with no address typed yet, **Choose {client}’s site** (the Property picker
 * with the name, listing their sites and ending in New site for them, so
 * the caller's own site is chosen, never typed again beside it); with one,
 * **Use {client}**, a new site for them there or booked at theirs if it is
 * one (`planMatchFix`), and the picker still, should the address be gone by
 * the tap (`choose`). A client with no site yet: **New site for {client}**.
 */
function nameLineFix(
  index: MatchIndex,
  clientId: Id<'clients'>,
  name: string,
  site: TypedAddress | undefined,
): MatchFix {
  const client = index.clients.get(clientId)
  const who = matchName(client)
  if (sitesOf(index, clientId).length === 0) {
    return { kind: 'use', label: `New site for ${who}`, clientId }
  }
  if ((site?.addressLine.trim() ?? '') === '') {
    return show(name, `Choose ${possessive(client, 'site')}`)
  }
  return { kind: 'use', label: `Use ${who}`, clientId, choose: name }
}

function lineFor(
  ctx: MatchRowsContext,
  text: string,
  fixes: { fix?: MatchFix; fix2?: MatchFix },
  clientId: Id<'clients'> | undefined,
  shows = false,
): MatchLine {
  return { text, ...forVerb(ctx, fixes, clientId, shows) }
}

/**
 * The line under Name, Phone or Email once focus moves on to another field
 * (§2.6), or null. Who already has what was typed:
 *
 * - Phone or Email held by one client whose name agrees: "Jane Nguyen, of
 *   Bayswater, has this mobile.", with Book at 12 Wattle St (one site),
 *   Choose Jane Nguyen’s site (several) or New site for Jane Nguyen (none).
 *   Their own mobile or email with no name agreeing says the same, with
 *   Show them: agency, strata and family numbers sit on one owner's record
 *   too.
 * - A landline on one client, name not agreeing: "08 9272 1234 is Tom Lee’s
 *   number.", Show them.
 * - Shared: "… is on 6 clients — Ray White Bayswater and 5 others.", Show
 *   them, and New site for the one business holding it.
 * - Name, exactly one client: "Jane Nguyen, of Bayswater, is already a
 *   client.", with Choose Jane Nguyen’s site while no address is typed (the
 *   usual case: the address comes last), else Use Jane Nguyen, which does
 *   what Use does at Book (`nameLineFix`). Two: "2 clients are called Jane
 *   Nguyen.", Show them. A placeholder, or a name more than two clients
 *   have, says nothing.
 */
export function blurLine(
  ctx: MatchRowsContext,
  field: 'clientName' | 'phone' | 'email',
  typed: TypedClient,
): MatchLine | null {
  const { index } = ctx
  if (field === 'clientName') {
    const name = typed.name?.trim() ?? ''
    if (name === '' || isPlaceholderName(name)) return null
    const holders = index.names.get(nameKey(name)) ?? []
    if (holders.length === 1) {
      const id = holders[0]
      return lineFor(
        ctx,
        `${whoOf(index, id)} is already a client.`,
        { fix: nameLineFix(index, id, name, typed.site) },
        id,
      )
    }
    if (holders.length === 2) {
      return ctx.verb === 'book'
        ? { text: `2 clients are called ${name}.`, fix: show(name) }
        : { text: `2 clients are called ${name}.` }
    }
    return null
  }

  const shown = typedFor(typed, field)
  if (shown === '') return null
  const result = matchNewClient(
    index,
    field === 'phone'
      ? { name: typed.name, phone: typed.phone }
      : { name: typed.name, email: typed.email },
  )
  const noun = field === 'phone' ? numberNoun(shown, index.areaCode) : 'email'
  const held = result.candidates.find((c) =>
    field === 'phone'
      ? c.evidence.includes('mobile') || c.evidence.includes('landline')
      : c.evidence.includes('email'),
  )
  if (held) {
    const name = matchName(index.clients.get(held.clientId))
    const contact =
      held.contactId && ctx.contacts.find((k) => k._id === held.contactId)
    const who = contact
      ? `${contact.name}, a contact at ${name},`
      : whoOf(index, held.clientId)
    const ev = new Set(held.evidence)
    const nearLandline =
      ev.has('landline') && !ev.has('name') && !ev.has('mobile')
    // The name agrees with a number or email of theirs: Same, or capped at
    // Likely by an old copy. Not a landline whose name agrees only as an
    // initial: that is anyone in the house.
    if (
      held.tier === 'same' ||
      ((ev.has('name') || ev.has('nameNear')) && !nearLandline)
    ) {
      return lineFor(
        ctx,
        `${who} has this ${noun}.`,
        { fix: siteFixFor(ctx, held.clientId, shown) },
        held.clientId,
      )
    }
    if (held.evidence.includes('landline')) {
      return lineFor(
        ctx,
        `${shown} is ${possessive(index.clients.get(held.clientId), 'number')}.`,
        { fix: show(shown) },
        held.clientId,
        true,
      )
    }
    return lineFor(
      ctx,
      `${who} has this ${noun}.`,
      { fix: show(shown) },
      held.clientId,
      true,
    )
  }
  const row = result.shared.find((s) => s.keys.some((k) => k.field === field))
  if (!row) return null
  const business = row.businessClientId
  return lineFor(
    ctx,
    sharedText(index, row, shown),
    {
      fix: show(shown),
      ...(business
        ? {
            fix2: {
              kind: 'use',
              label: `New site for ${matchName(index.clients.get(business))}`,
              clientId: business,
            },
          }
        : {}),
    },
    business,
  )
}

/** A row as the panel's foot reads it: what its fixes do. */
export type FootRow = {
  fix?: Pick<MatchFix, 'kind'>
  fix2?: Pick<MatchFix, 'kind'>
}

/**
 * The line at the foot of the panel when only match rows are in it, naming
 * the button that is there: "Use it, or press Book anyway to add a new
 * client." ("Use one, …" for several rows that can be used; "Open it, …"
 * where the fix opens the client). Where no row has a fix that takes the
 * booking (each only shows who it may be: a client's own mobile under
 * another name, a landline agreeing only by initial), "Check who it is, or
 * press Book anyway to add a new client."
 */
export function matchFooter(
  rows: ReadonlyArray<FootRow>,
  { anyway, adds }: { anyway: string; adds: 'client' | 'site' },
): string {
  const kinds = (row: FootRow) =>
    [row.fix?.kind, row.fix2?.kind].filter((k) => k !== undefined)
  const taking = rows.filter((row) => kinds(row).some((k) => k !== 'show'))
  const rest = `or press ${anyway} to add a new ${adds}.`
  if (taking.length === 0) return `Check who it is, ${rest}`
  const verb = rows.some((row) => kinds(row).includes('open')) ? 'Open' : 'Use'
  return `${verb} ${taking.length === 1 ? 'it' : 'one'}, ${rest}`
}

/** Every client the matcher returned, shown or counted in "And 2 more":
 * what Book anyway has booked past (`matchCheck.dismissed`, M7). */
export function dismissedOf(result: MatchResult): Array<Id<'clients'>> {
  return result.candidates.map((c) => c.clientId)
}

/** What the panel's match rows came to, counts only (`match-shown`). */
export function matchShownCounts(rows: ReadonlyArray<Pick<MatchRow, 'tier'>>): {
  same: number
  likely: number
  maybe: number
  shared: number
} {
  const count = (tier: MatchRow['tier']) =>
    rows.filter((r) => r.tier === tier).length
  return {
    same: count('same'),
    likely: count('likely'),
    maybe: count('maybe'),
    shared: count('shared'),
  }
}

/**
 * The lines at the end of the panel about where its rows were found: a copy
 * that may be behind never claims to be the whole book. Until the online
 * sheet sends its check with the booking (the matching plan's M7), this copy
 * is the only check there is.
 */
export function matchNotes(at: {
  /** The client list may be missing someone added since (`mayBeBehind`). */
  behind: boolean
  /** When it was last known right (`keeper.asOf`), or null. */
  asOf: number | null
  timezone: string
  today: string
  capped: boolean
  contactsCapped: boolean
}): Array<string> {
  const notes: Array<string> = []
  if (at.behind) {
    notes.push(
      at.asOf === null
        ? 'From the clients on this phone.'
        : `From the clients on this phone, updated ${formatUpdated(at.asOf, at.timezone, at.today)}.`,
    )
  }
  // The directory's limit (DIRECTORY_LIMIT in convex/clients.ts).
  if (at.capped) notes.push('Only the newest 8,000 clients are on this phone.')
  else if (at.contactsCapped) {
    notes.push('Not every contact person is on this phone.')
  }
  return notes
}

// ── What goes with the booking (§2.8) ────────────────────────────────────

/** Who rang, as typed in New client. */
export type TypedPerson = { name: string; phone: string }

type ContactOf = {
  clientId: string
  name: string
  phone?: string
  email?: string
}

function contactsOfClient(
  contacts: ReadonlyArray<ContactOf>,
  clientId: string,
): Array<ContactOf> {
  return contacts.filter((k) => k.clientId === clientId)
}

/** The typed name is the client's, or one of its contact people's. */
function nameAgrees(
  name: string,
  client: MatchClient,
  contacts: ReadonlyArray<ContactOf>,
): boolean {
  const key = nameKey(name)
  if (key === nameKey(client.name)) return true
  if (nameNear(name, client.name, client.kind)) return true
  return contacts.some(
    (k) => nameKey(k.name) === key || nameNear(name, k.name, 'person'),
  )
}

function emailHeld(
  email: string,
  emails: ReadonlyArray<string | undefined>,
): boolean {
  const held = new Set(emails.flatMap((e) => emailKeys(e)))
  return emailKeys(email).some((key) => held.has(key))
}

function phoneHeld(
  phone: string,
  numbers: ReadonlyArray<string | undefined>,
  areaCode: string,
): boolean {
  const held = new Set(numbers.flatMap((n) => phoneKeys(n, areaCode)))
  return phoneKeys(phone, areaCode).some((key) => held.has(key))
}

/**
 * The first line of the job's Notes when a booking moves onto an existing
 * client and what was typed isn't already theirs (C10): "Caller: Tom
 * Nguyen, 0499 888 777", or only what differs ("Caller’s number: 0499 888
 * 777" when the name agrees). Null when nothing differs. So Call on the day
 * rings the person who booked, and nobody rings the wrong one.
 */
export function callerLine(
  person: TypedPerson,
  client: MatchClient,
  contacts: ReadonlyArray<ContactOf>,
  areaCode: string,
): string | null {
  const name = person.name.trim()
  const phone = person.phone.trim()
  const own = contactsOfClient(contacts, client._id)
  const nameDiffers = name !== '' && !nameAgrees(name, client, own)
  const phoneDiffers =
    phone !== '' &&
    !phoneHeld(phone, [client.phone, ...own.map((k) => k.phone)], areaCode)
  if (nameDiffers && phoneDiffers) return `Caller: ${name}, ${phone}`
  if (nameDiffers) return `Caller: ${name}`
  if (phoneDiffers) return `Caller’s number: ${phone}`
  return null
}

/**
 * Notes with the caller's line first, where it fits: never past the notes'
 * limit (`MAX_JOB_NOTES_LENGTH`), so nothing claims a line was added that
 * wasn't, and never twice.
 */
export function withCallerLine(notes: string, line: string | null): string {
  if (!line) return notes
  if (notes.split('\n')[0].trim() === line) return notes
  const next = notes.trim() === '' ? line : `${line}\n${notes}`
  return next.length <= MAX_JOB_NOTES_LENGTH ? next : notes
}

/**
 * Notes with the caller's line a fix put first (`line`) taken off again,
 * while it is still there as it was put: another fix says who rang afresh,
 * and a booking taken back to the New client tab is the caller's own. A line
 * the person has since edited is theirs, and stays.
 */
export function withoutCallerLine(notes: string, line: string | null): string {
  if (!line) return notes
  const [first, ...rest] = notes.split('\n')
  return first.trim() === line ? rest.join('\n') : notes
}

/**
 * A new site for a business client: the typed person as its site contact,
 * so Call on the day rings them, not head office. Only what isn't the
 * business's own already, by the same test as the caller's line
 * (`callerLine`): not its name or one like it ("Ray White" for Ray White
 * Bayswater), nor a contact person's; not its main number, nor a contact
 * person's.
 */
export function siteContactCarry(
  person: TypedPerson,
  client: MatchClient,
  contacts: ReadonlyArray<ContactOf>,
  areaCode: string,
): { siteContactName: string; siteContactPhone: string } {
  const name = person.name.trim()
  const phone = person.phone.trim()
  const own = contactsOfClient(contacts, client._id)
  return {
    siteContactName: name !== '' && !nameAgrees(name, client, own) ? name : '',
    siteContactPhone:
      phone !== '' &&
      !phoneHeld(phone, [client.phone, ...own.map((k) => k.phone)], areaCode)
        ? phone
        : '',
  }
}

/** The address fields a new site is made of, as the form holds them. */
export type SiteDraft = {
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
  addressCheck: 'picked' | 'typed'
}

/**
 * What New Job keeps once a fix has taken the booking from New client, or
 * null: `line`, the caller's line that fix put first in Notes (taken off by
 * the next fix, or going back to New client); `pick`, a Show them's picker
 * is open, and the site or client chosen there carries the caller as the
 * fix it stands for would.
 */
export type Carried = { line: string | null; pick: boolean } | null

/** What happens to it (`carryAfter`). */
export type CarryEvent =
  /** A Show them opened a picker. */
  | { on: 'show' }
  /** A fix, or a choice in that picker standing for one, took the booking
   * there, putting `line` first in Notes (or none). */
  | { on: 'fix'; line: string | null }
  /** That picker shut with nothing chosen. */
  | { on: 'dismissed' }
  /** The client mode changed by hand: back to New client, or another;
   * `handOver` when it is the picker's own row handing over to another
   * picker (New site for one of several clients with no sites). */
  | { on: 'mode'; to: 'new' | 'other'; handOver?: boolean }

/**
 * `Carried` after `event`. A Show them waits on a choice only while the
 * picker it opened is open: shut with nothing chosen, or the mode changed by
 * hand, and a client chosen later is the person's own choice, made with the
 * fields as they have typed them, never overwritten by what was typed in New
 * client. Back to New client, nothing is carried: the booking is the
 * caller's own again.
 */
export function carryAfter(carried: Carried, event: CarryEvent): Carried {
  switch (event.on) {
    case 'show':
      return { line: carried?.line ?? null, pick: true }
    case 'fix':
      return { line: event.line, pick: false }
    case 'dismissed':
      return carried?.pick ? { ...carried, pick: false } : carried
    case 'mode':
      if (event.to === 'new') return null
      if (event.handOver) return carried
      return carried?.pick ? { ...carried, pick: false } : carried
  }
}

/** What New Job holds when a fix is tapped. */
export type FixState = {
  mode: 'new' | 'site'
  /** Who rang, as typed in New client: in New client, and wherever a fix
   * took the booking from there; nobody in a New site for chosen by hand. */
  person: TypedPerson | null
  /** The address typed: the new client's, or the new site's, with the site
   * contact typed where the form shows one (a business's), else blank. */
  site: SiteDraft
  notes: string
  /** The caller's line an earlier fix put first in `notes`, or null: this
   * fix takes it off before saying who rang afresh, so a change of course
   * never leaves two. */
  callerLine: string | null
  index: MatchIndex
  contacts: ReadonlyArray<ContactOf>
}

/** What a fix does to New Job: the setters it calls. `callerLine` is the
 * caller's line now first in `notes` by this fix's doing, or null. */
export type FixPlan =
  | {
      to: 'existing'
      propertyId: Id<'properties'>
      notes: string
      callerLine: string | null
    }
  | {
      to: 'site'
      clientId: Id<'clients'>
      site: SiteDraft
      notes: string
      callerLine: string | null
      added: AddedAnyway | null
    }
  | { to: 'picker'; query: string }

/**
 * What a fix tapped in New Job does (§2.7):
 * - Book at {site} / Book on {client}: that site chosen, the caller's line
 *   in Notes.
 * - Use {client} / New site for {client}: a new site for them at the address
 *   typed; or, if it is one of theirs, booked there. A business's new site
 *   gets the typed person as its site contact; anyone else's booking, the
 *   caller's line in Notes. Use from the line under Name (`choose`), with
 *   no address typed by the tap: the Property picker, as Show them.
 * - Add {address}: a new site for them at the address as typed, not asked
 *   about again.
 * - Show them: the Property picker opened with the key typed. What the
 *   person then chooses there is planned as Book at or New site for, so the
 *   caller goes with it too (NewJobSheet).
 * No fix changes the existing client's own phone or email, and the new
 * client as typed stays where it was, for the New client tab. A caller's
 * line an earlier fix put in Notes is taken off first (`at.callerLine`).
 */
export function planMatchFix(fix: MatchFix, at: FixState): FixPlan | null {
  if (fix.kind === 'show') return { to: 'picker', query: fix.query }
  // Already New site for this client: the address stays as typed.
  if (fix.kind === 'add' && at.mode === 'site') {
    const key = at.site.addressLine.trim() === '' ? null : siteKey(at.site)
    return {
      to: 'site',
      clientId: fix.clientId,
      site: at.site,
      notes: at.notes,
      callerLine: at.callerLine,
      added: key === null ? null : { clientId: fix.clientId, siteKey: key },
    }
  }
  if (fix.kind === 'open') return null
  const client = at.index.clients.get(fix.clientId)
  if (!client) return null
  // Use from the line under Name, with no address typed by the tap: one of
  // their sites is chosen, never a blank new one beside it.
  if (
    fix.kind === 'use' &&
    fix.choose !== undefined &&
    at.site.addressLine.trim() === '' &&
    sitesOf(at.index, fix.clientId).length > 0
  ) {
    return { to: 'picker', query: fix.choose }
  }
  const areaCode = at.index.areaCode
  const line = at.person
    ? callerLine(at.person, client, at.contacts, areaCode)
    : null
  const before = withoutCallerLine(at.notes, at.callerLine)
  const noted = (put: string | null) => {
    const notes = withCallerLine(before, put)
    return { notes, callerLine: notes === before ? null : put }
  }
  if (fix.kind === 'bookAt') {
    return { to: 'existing', propertyId: fix.propertyId, ...noted(line) }
  }
  const typedKey = at.site.addressLine.trim() === '' ? null : siteKey(at.site)
  if (fix.kind === 'use' && typedKey !== null) {
    const theirs = sitesOf(at.index, fix.clientId).find(
      (s) => at.index.siteKeys.get(s._id) === typedKey,
    )
    if (theirs) {
      return { to: 'existing', propertyId: theirs._id, ...noted(line) }
    }
  }
  const typedContact =
    at.site.siteContactName.trim() !== '' ||
    at.site.siteContactPhone.trim() !== ''
  const toBusiness = client.kind === 'business'
  const contact = typedContact
    ? {
        siteContactName: at.site.siteContactName,
        siteContactPhone: at.site.siteContactPhone,
      }
    : toBusiness && at.person
      ? siteContactCarry(at.person, client, at.contacts, areaCode)
      : { siteContactName: '', siteContactPhone: '' }
  return {
    to: 'site',
    clientId: fix.clientId,
    site: { ...at.site, ...contact },
    // A business's new site has the caller as its site contact instead.
    ...(toBusiness ? { notes: before, callerLine: null } : noted(line)),
    added:
      fix.kind === 'add' && typedKey !== null
        ? { clientId: fix.clientId, siteKey: typedKey }
        : null,
  }
}
