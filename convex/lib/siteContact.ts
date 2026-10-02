import { sameName } from './contactNames'

/**
 * Who a technician rings about a visit (Prompt 6.3), and who they ask for.
 *
 * A business client's property can carry its own site contact — the store
 * manager, the caretaker, the tenant who lets them in. On the day that is who
 * "ten minutes away" is for; head office is for the invoice. So when the site
 * has a number, Call and Text reach the site, and the name on the button is
 * the site contact's. Without a number the site contact is only a name to ask
 * for, and the client's own line is dialled, under the client's name: the
 * name and the number always move together, so a button never names someone
 * it is not calling.
 *
 * Next comes the client's contact person — the one "who do we deal with
 * here" (lib/contactPerson.ts). With a number of their own they are rung
 * directly, under their name. Without one the business's line is rung, under
 * its name, and the card says who to ask for when it answers: the request
 * that added this, from a technician ringing "Turbo Sushi" with no idea who
 * to talk to.
 *
 * Only for a business client. A client switched from business to person keeps
 * its site contacts and contacts (hidden, not deleted — like its head-office
 * address), and must not keep silently dialling someone nobody can see.
 *
 * Pure, and the one place this rule lives: the job card reads flattened
 * fields from `jobs.decorate`, the job sheet the embedded property and client.
 */
export type CallTarget = {
  /** For the button's name: "Call Jan". */
  name: string
  phone: string | undefined
  /** True when this is the site's own contact, not the client's line. */
  atSite: boolean
  /** Who to ask for, for the card's Contact line: the person Call reaches,
   * or the contact person when Call rings the business's own line. Undefined
   * for a person client — the card's heading is them already — and so for a
   * sole trader whose contact person is the business's own name; and when
   * nobody is named, as for a site number saved without a name: the card
   * never names someone its Call does not reach. */
  askFor: string | undefined
}

export function contactToCall(input: {
  clientKind: 'person' | 'business' | undefined
  clientName: string
  clientPhone?: string
  siteContactName?: string
  siteContactPhone?: string
  contactPersonName?: string
  contactPersonPhone?: string
}): CallTarget {
  const business = input.clientKind === 'business'
  // Nobody to ask for who is already the card's heading.
  const named = (who: string | undefined) =>
    who !== undefined && !sameName(who, input.clientName) ? who : undefined
  const sitePhone = input.siteContactPhone?.trim()
  if (business && sitePhone) {
    const siteName = input.siteContactName?.trim() || undefined
    return {
      name: siteName ?? input.clientName,
      phone: sitePhone,
      atSite: true,
      askFor: named(siteName),
    }
  }
  const contactName = business
    ? input.contactPersonName?.trim() || undefined
    : undefined
  const contactPhone = contactName
    ? input.contactPersonPhone?.trim() || undefined
    : undefined
  if (contactName && contactPhone) {
    return {
      name: contactName,
      phone: contactPhone,
      atSite: false,
      askFor: named(contactName),
    }
  }
  return {
    name: input.clientName,
    phone: input.clientPhone?.trim() || undefined,
    atSite: false,
    askFor: named(contactName),
  }
}

/**
 * The site contact to show on a business client's property, or null — for
 * the job sheet and the client sheet, which show the site contact beside the
 * client's own line rather than instead of it.
 */
export function siteContactOf(input: {
  clientKind: 'person' | 'business' | undefined
  siteContactName?: string
  siteContactPhone?: string
}): { name: string | undefined; phone: string | undefined } | null {
  if (input.clientKind !== 'business') return null
  const name = input.siteContactName?.trim() || undefined
  const phone = input.siteContactPhone?.trim() || undefined
  return name || phone ? { name, phone } : null
}
