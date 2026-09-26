import { ConvexError } from 'convex/values'
import { editDistance } from './contactNames'

/**
 * Email addresses typed into the app (clients, contacts, the business, report
 * recipients, invitations). Pure, so a form can check an address as it is
 * typed with exactly the rule the server enforces.
 *
 * Two kinds of check, kept apart on purpose:
 * - `emailProblem` is the hard rule: an address that can never be delivered
 *   to (no domain, a space, no dot in the domain). The browser's own
 *   `type="email"` check lets `bob@gmail` through; this does not.
 * - `emailTypoFix` is only a suggestion: "bob@gmial.com" is a real address
 *   shape, and occasionally a real address, so it is offered, never forced.
 *
 * A compliance report emailed to a typo is simply gone — which is why these
 * exist, and why the server refuses what `emailProblem` refuses.
 */

/** RFC 5321's limit on a whole address. */
export const MAX_EMAIL_LENGTH = 254

// Letters in any script: "münchen.de" is a real domain as typed, not only
// in its xn-- form.
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u

/**
 * Why an address can never be delivered to, in words for the person typing,
 * or null when it can. Blank is not a problem here: whether a field may be
 * empty is the form's business.
 */
export function emailProblem(raw: string): string | null {
  const email = raw.trim()
  if (email === '') return null
  if (/\s/.test(email)) return 'An email address has no spaces in it.'
  if (email.length > MAX_EMAIL_LENGTH) return 'That email address is too long.'
  const at = email.split('@')
  if (at.length !== 2) return 'An email address has exactly one @ in it.'
  const [local, domain] = at
  if (local === '') return 'Add the part before the @.'
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return 'The part before the @ cannot start or end with a dot, or have two in a row.'
  }
  if (domain === '') return 'Add the part after the @, such as gmail.com.'
  const labels = domain.split('.')
  if (labels.length < 2) {
    return `Add the rest of the address after "${domain}", such as .com or .com.au.`
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return 'The part after the @ is not a real domain.'
  }
  const tld = labels[labels.length - 1]
  if (!/^(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu.test(tld)) {
    return `".${tld}" is not a real ending for an email address.`
  }
  return null
}

export function isValidEmail(raw: string): boolean {
  return raw.trim() !== '' && emailProblem(raw) === null
}

/**
 * An address as stored: trimmed, the domain lower-cased (domains are not
 * case-sensitive; the part before the @ is left as typed), and absent when
 * blank. `undefined` in means "not given"; a blank string means "none",
 * which the edit forms send to clear one. Anything else must pass
 * `emailProblem`.
 */
export function normaliseEmail(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (emailProblem(raw) !== null) throw new ConvexError('INVALID_EMAIL')
  const [local, domain] = raw.trim().split('@')
  return `${local}@${domain.toLowerCase()}`
}

export function emailDomain(raw: string): string | null {
  const email = raw.trim()
  if (emailProblem(email) !== null || email === '') return null
  return email.split('@')[1].toLowerCase()
}

/**
 * The providers an Australian business's customers actually use, for typo
 * suggestions. Kept short and local on purpose: a long international list
 * turns rare real domains into "did you mean".
 */
export const COMMON_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.com.au',
  'hotmail.com',
  'hotmail.com.au',
  'live.com',
  'live.com.au',
  'msn.com',
  'icloud.com',
  'me.com',
  'yahoo.com',
  'yahoo.com.au',
  'bigpond.com',
  'bigpond.net.au',
  'bigpond.com.au',
  'optusnet.com.au',
  'iinet.net.au',
  'westnet.com.au',
  'tpg.com.au',
  'internode.on.net',
  'dodo.com.au',
  'aapt.net.au',
  'ozemail.com.au',
  'protonmail.com',
  'proton.me',
] as const

/**
 * Real providers a letter or two from a common one, which must never be
 * "corrected": mail.com is not a slip of gmail.com, and y7mail.com (Yahoo7),
 * exemail.com.au (Exetel), tpgi.com.au (TPG) and amnet.net.au (Amnet, Perth)
 * are Australian addresses in use, not slips of gmail, ozemail, tpg and
 * iinet.
 */
const REAL_LOOKALIKES = new Set([
  'mail.com',
  'email.com',
  'ymail.com',
  'y7mail.com',
  'aol.com',
  'gmx.com',
  'gmx.net',
  'live.net',
  'outlook.net',
  'iinet.com.au',
  'exemail.com.au',
  'tpgi.com.au',
  'amnet.net.au',
  'protonmail.ch',
  'fastmail.com',
  'zoho.com',
])

/** Endings typed a slip away from the real one. (Not "om": that is Oman.) */
const TLD_SLIPS: Record<string, string> = {
  con: 'com',
  cmo: 'com',
  cpm: 'com',
  comm: 'com',
  vom: 'com',
  xom: 'com',
  'com.u': 'com.au',
  'com.aus': 'com.au',
  'con.au': 'com.au',
  'cmo.au': 'com.au',
  'net.u': 'net.au',
}

/**
 * The address the person most likely meant, or null. "bob@gmial.com" →
 * "bob@gmail.com", "bob@hotmail.con" → "bob@hotmail.com". Only near misses
 * of a well-known provider, and slips in the ending: a small business's own
 * domain is never "corrected" into a big one.
 */
export function emailTypoFix(raw: string): string | null {
  const email = raw.trim()
  const at = email.lastIndexOf('@')
  if (at <= 0 || /\s/.test(email)) return null
  const local = email.slice(0, at)
  const domain = email.slice(at + 1).toLowerCase()
  if (
    domain === '' ||
    (COMMON_EMAIL_DOMAINS as ReadonlyArray<string>).includes(domain) ||
    REAL_LOOKALIKES.has(domain)
  ) {
    return null
  }

  // A slipped ending first: "gmail.con" is gmail.com however far "gmail" is
  // from anything.
  for (const [slip, fixed] of Object.entries(TLD_SLIPS)) {
    if (domain.endsWith(`.${slip}`)) {
      const candidate = `${domain.slice(0, -slip.length)}${fixed}`
      if (candidate !== domain) return `${local}@${candidate}`
    }
  }

  // "gmail" with no ending at all.
  const bare = COMMON_EMAIL_DOMAINS.find((d) => d.split('.')[0] === domain)
  if (bare) return `${local}@${bare}`

  let best: { domain: string; distance: number } | null = null
  for (const known of COMMON_EMAIL_DOMAINS) {
    const distance = editDistance(domain, known)
    const allowed = known.length <= 8 ? 1 : 2
    if (distance > 0 && distance <= allowed) {
      if (!best || distance < best.distance) best = { domain: known, distance }
    }
  }
  return best ? `${local}@${best.domain}` : null
}
