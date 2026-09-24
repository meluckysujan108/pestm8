/**
 * Who a technician rings about a visit (Prompt 6.3).
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
 * Only for a business client. A client switched from business to person keeps
 * its site contacts (hidden, not deleted — like its contacts and head-office
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
}

export function contactToCall(input: {
  clientKind: 'person' | 'business' | undefined
  clientName: string
  clientPhone?: string
  siteContactName?: string
  siteContactPhone?: string
}): CallTarget {
  const sitePhone = input.siteContactPhone?.trim()
  if (input.clientKind === 'business' && sitePhone) {
    return {
      name: input.siteContactName?.trim() || input.clientName,
      phone: sitePhone,
      atSite: true,
    }
  }
  return {
    name: input.clientName,
    phone: input.clientPhone?.trim() || undefined,
    atSite: false,
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
