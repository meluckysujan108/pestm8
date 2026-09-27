import { withoutSite } from '#/lib/clientImport/build'
import type { ReviewClient } from '#/lib/clientImport/types'

/**
 * The edit sheet's working copy of a client (EditClientSheet): every field
 * as the text in its box, so a blank is '' while it is being typed, and
 * "none" only once it is saved.
 */

export type SiteDraft = {
  /** Stable for as long as the sheet is open, so a site's boxes stay with
   * that site when one above it is removed. */
  id: string
  /** Where the site was when the sheet opened — what the review said about
   * it is filed under that. Absent for a site added in the sheet. */
  from?: number
  addressLine: string
  suburb: string
  state: string
  postcode: string
  siteContactName: string
  siteContactPhone: string
  note: string
  duplicate: boolean
}

export type Draft = {
  kind: 'person' | 'business'
  name: string
  contactPerson: string
  phone: string
  email: string
  abn: string
  sites: Array<SiteDraft>
}

export function draftOf(client: ReviewClient): Draft {
  return {
    kind: client.kind,
    name: client.name,
    contactPerson: client.contactPerson ?? '',
    phone: client.phone ?? '',
    email: client.email ?? '',
    abn: client.abn ?? '',
    sites: client.sites.map((site, i) => ({
      id: `site-${i}`,
      from: i,
      addressLine: site.addressLine,
      suburb: site.suburb,
      state: site.state,
      postcode: site.postcode,
      siteContactName: site.siteContactName ?? '',
      siteContactPhone: site.siteContactPhone ?? '',
      note: site.note ?? '',
      duplicate: site.duplicate === true,
    })),
  }
}

/** A new, empty site, in the business's own state — most clients are. */
export function blankSite(id: string, state: string): SiteDraft {
  return {
    id,
    addressLine: '',
    suburb: '',
    state,
    postcode: '',
    siteContactName: '',
    siteContactPhone: '',
    note: '',
    duplicate: false,
  }
}

/** Blank is "none": left off rather than kept as '', as the import sends it. */
function given<TKey extends string>(key: TKey, value: string) {
  const trimmed = value.trim()
  return (trimmed ? { [key]: trimmed } : {}) as Partial<Record<TKey, string>>
}

/**
 * The draft as the client it makes. Only the fields are changed: the issues
 * are the old ones, for `recheckClient` to judge again — which keeps what
 * was put right on the way in only while it still holds.
 *
 * A site removed takes what was said about it with it, first, and moves
 * what was said about each later site up with that site (`withoutSite`,
 * once per site removed, the last first). What the review says about a
 * site is filed by its place in the list, and much of it can't be worked
 * out again from the fields — “Westen Aust” isn't a state — used WA; a
 * one-tap "Use X, Y" — so it has to move, not go: dropped, a site that
 * needs a look would quietly read as ready.
 *
 * The sheet only removes sites and adds them at the end, so the sites kept
 * are still in their first order, ahead of any new ones — which is the
 * order `withoutSite` leaves them in.
 */
export function applyDraft(client: ReviewClient, draft: Draft): ReviewClient {
  const kept = new Set<number>()
  for (const site of draft.sites) {
    if (site.from !== undefined) kept.add(site.from)
  }
  let base = client
  for (let i = client.sites.length - 1; i >= 0; i--) {
    if (!kept.has(i)) base = withoutSite(base, i)
  }
  const {
    contactPerson: _contactPerson,
    phone: _phone,
    email: _email,
    abn: _abn,
    ...rest
  } = base
  return {
    ...rest,
    kind: draft.kind,
    name: draft.name.replace(/\s+/g, ' ').trim(),
    ...given('contactPerson', draft.contactPerson),
    ...given('phone', draft.phone),
    ...given('email', draft.email),
    ...given('abn', draft.abn),
    sites: draft.sites.map((site) => ({
      addressLine: site.addressLine.replace(/\s+/g, ' ').trim(),
      suburb: site.suburb.replace(/\s+/g, ' ').trim(),
      state: site.state,
      postcode: site.postcode.trim(),
      ...given('siteContactName', site.siteContactName),
      ...given('siteContactPhone', site.siteContactPhone),
      ...given('note', site.note),
      // `recheckClient` works out afresh whether it is already here, and
      // whose it is.
      ...(site.duplicate ? { duplicate: true } : {}),
    })),
  }
}
