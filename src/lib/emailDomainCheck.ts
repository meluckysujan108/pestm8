import { getJsonWithin } from './addressLookup'

/**
 * Whether an email address's domain accepts mail at all, asked of a public
 * DNS resolver from the browser (DNS-over-HTTPS). It catches what a spelling
 * check cannot: "bob@smithpestcontrol.com.au" when the business is
 * smithpest.com.au, or a domain that lapsed years ago. A report emailed there
 * is gone without anyone knowing.
 *
 * Only the domain is ever sent — never the part before the @ — and nothing is
 * emailed to the person. The answer is only ever a warning: a DNS reply says
 * whether a domain *can* receive mail, not whether this mailbox exists.
 *
 * - 'receives': it has a mail server, or at least an address (mail falls back
 *   to the A record when there is no MX).
 * - 'no-mail': the domain does not exist, publishes a "null MX" (RFC 7505,
 *   "0 ." — it says outright that it takes no mail), or has neither record.
 * - 'unknown': any failure at all, so the form says nothing. One bar of signal
 *   is never a reason to doubt an address.
 */
export type DomainMail = 'receives' | 'no-mail' | 'unknown'

/** Google answers without any custom header, so the browser sends it with no
 * CORS preflight: one round trip, not two. */
export const GOOGLE_DOH = 'https://dns.google/resolve'
/** Cloudflare needs `accept: application/dns-json`, which costs a preflight,
 * so it is only the fallback. */
export const CLOUDFLARE_DOH = 'https://cloudflare-dns.com/dns-query'

/** Per request. Two of these, plus the A-record follow-up, still fit the
 * 3 s the save allows every check, and the save's own limit ends the rest. */
const REQUEST_TIMEOUT_MS = 1400

const MX = 15
const A = 1

type RecordType = typeof MX | typeof A

/** What one DNS reply says about a record type. */
export type DnsReading = 'found' | 'none' | 'nxdomain' | 'null-mx' | 'unknown'

/**
 * Reads a resolver's JSON reply (the shape Google and Cloudflare share).
 * `Status` is the DNS RCODE: 0 answered, 3 the name does not exist; anything
 * else (2, server failure) says nothing either way.
 */
export function readDnsReply(json: unknown, type: RecordType): DnsReading {
  if (typeof json !== 'object' || json === null) return 'unknown'
  const reply = json as { Status?: unknown; Answer?: unknown }
  if (reply.Status === 3) return 'nxdomain'
  if (reply.Status !== 0) return 'unknown'
  const answers = Array.isArray(reply.Answer) ? reply.Answer : []
  const records = answers.filter(
    (a): a is { type: number; data: string } =>
      typeof a === 'object' &&
      a !== null &&
      (a as { type?: unknown }).type === type &&
      typeof (a as { data?: unknown }).data === 'string',
  )
  if (records.length === 0) return 'none'
  if (type === MX) {
    // A null MX is "0 ." — the target is the root, with or without the dot.
    const real = records.filter((r) => {
      const target = r.data.trim().split(/\s+/)[1] ?? ''
      return target !== '.' && target !== ''
    })
    return real.length === 0 ? 'null-mx' : 'found'
  }
  return 'found'
}

const TYPE_NAME: Record<RecordType, string> = { [MX]: 'MX', [A]: 'A' }

async function ask(domain: string, type: RecordType): Promise<DnsReading> {
  const query = `?name=${encodeURIComponent(domain)}&type=${TYPE_NAME[type]}`
  const google = await getJsonWithin(`${GOOGLE_DOH}${query}`, {
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  if (google.ok) {
    const reading = readDnsReply(google.json, type)
    if (reading !== 'unknown') return reading
  }
  const cloudflare = await getJsonWithin(`${CLOUDFLARE_DOH}${query}`, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: { accept: 'application/dns-json' },
  })
  return cloudflare.ok ? readDnsReply(cloudflare.json, type) : 'unknown'
}

async function lookUp(domain: string): Promise<DomainMail> {
  const mx = await ask(domain, MX)
  if (mx === 'found') return 'receives'
  if (mx === 'nxdomain' || mx === 'null-mx') return 'no-mail'
  if (mx === 'unknown') return 'unknown'
  // No MX: mail is delivered to the domain's own address, if it has one.
  const a = await ask(domain, A)
  if (a === 'found') return 'receives'
  return a === 'none' || a === 'nxdomain' ? 'no-mail' : 'unknown'
}

/**
 * Settled answers, for this page's lifetime. A domain's mail setup does not
 * change between one client and the next, and a form checked on blur then
 * again at save asks once. 'unknown' is never kept, so a check that failed on
 * no signal is tried again.
 */
const settled = new Map<string, Exclude<DomainMail, 'unknown'>>()
const inFlight = new Map<string, Promise<DomainMail>>()

/** The answer already known for a domain, without asking. */
export function knownDomainMail(domain: string): DomainMail | undefined {
  return settled.get(domain.toLowerCase())
}

/** For tests. */
export function forgetDomainMail(): void {
  settled.clear()
  inFlight.clear()
}

/**
 * Asks whether `domain` receives email. Never throws; any failure is
 * 'unknown', and so is `signal` aborting first. Callers gate on
 * `networkLookupsAllowed()` and `isOffline()` first — this does not, so the
 * tests can drive it.
 *
 * The question itself is shared and not cancelled by `signal`: a blur that
 * started it and a Save pressed a moment later wait on the same request, and
 * each request gives up on its own time limit anyway.
 */
export function checkEmailDomain(
  rawDomain: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DomainMail> {
  const domain = rawDomain.trim().toLowerCase()
  const known = settled.get(domain)
  if (known) return Promise.resolve(known)

  const run =
    inFlight.get(domain) ??
    lookUp(domain).then((answer) => {
      if (answer !== 'unknown') settled.set(domain, answer)
      inFlight.delete(domain)
      return answer
    })
  inFlight.set(domain, run)

  const { signal } = opts
  if (!signal) return run
  if (signal.aborted) return Promise.resolve('unknown')
  return new Promise<DomainMail>((resolve) => {
    const giveUp = () => resolve('unknown')
    signal.addEventListener('abort', giveUp, { once: true })
    void run.then((answer) => {
      signal.removeEventListener('abort', giveUp)
      resolve(answer)
    })
  })
}
