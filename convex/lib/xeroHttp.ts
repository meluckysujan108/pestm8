/**
 * Xero over plain `fetch`: the OAuth token endpoints, the connections list,
 * and the Accounting calls — `GET /Organisation` (Release 1), the paged
 * `GET /Contacts` the match reads (Release 2), and the contact reads and
 * writes the sync sends (Release 3: `putContacts`, `postContacts`,
 * `getContactsByIds`, `getContactByName`). Nothing here archives or deletes
 * a contact: PestM8 never does either in Xero.
 *
 * Plain `fetch` rather than `xero-node`, in the default Convex runtime: the
 * SDK needs Node, a `"use node"` file cannot hold the queries and mutations
 * the token lease is made of (convex/xeroTokens.ts), and these are a handful
 * of form posts and GETs. Pure apart from `fetch` itself; no `ctx`, no rows.
 *
 * Every call:
 * - gives up after 20 s, so a Xero that has stopped answering costs one
 *   action 20 s and a retry, not the action's whole budget;
 * - turns any answer that is not a 2xx into a `XeroError` carrying
 *   `classify`'s verdict, so each caller decides what to do from one table
 *   rather than from status codes;
 * - logs the status and Xero's own error text when it fails, and never a
 *   token, a code, a URL or a header. A successful answer is never logged:
 *   the token endpoint's carries the tokens.
 *
 * Every Accounting call names its organisation (`xero-tenant-id`), which is
 * never defaulted: a blank one is refused before anything is sent.
 */
import { base64UrlToBytes, bytesToBase64 } from './base64'
import {
  XERO_API_BASE,
  XERO_CONNECTIONS_URL,
  XERO_REVOKE_URL,
  XERO_TOKEN_URL,
  redirectUri,
  xeroClientId,
  xeroClientSecret,
} from './xeroConfig'
import type { XeroContactForMatch } from './xeroMatch'

/** How long any one call to Xero may take, answer and body together. */
const TIMEOUT_MS = 20_000
/** Xero did not answer (network, timeout): worth another go shortly. */
const NO_ANSWER_RETRY_MS = 5000
/** Too many calls in flight for this organisation (Xero allows 5 at once). */
const CONCURRENT_RETRY_MS = 1000
/** A 5xx with no word on when to come back. */
const SERVER_RETRY_MS = 5000

/** A token endpoint's answer, as PestM8 keeps it. `expiresIn` is in seconds,
 * as Xero gives it (1800 for an access token). */
export type XeroTokenSet = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: string[]
  idToken?: string
}

/**
 * One row of `GET /connections`: one organisation (or practice) this Xero
 * user has given PestM8. `id` is the connection's own id, which
 * `DELETE /connections/{id}` takes; `tenantId` is the organisation's, which
 * every Accounting call names. `updatedAt` (ms) is when Xero last touched the
 * connection; `listConnections` returns newest first.
 */
export type XeroTenant = {
  id: string
  authEventId: string
  tenantId: string
  tenantType: string
  tenantName: string
  updatedAt?: number
}

/**
 * What a Xero answer means for whoever made the call. Raw Xero text never
 * leaves this file except to `console.error`; rows store these codes, and the
 * screen words them (src/components/xero/xeroCopy.ts).
 *
 * - `refresh`: a 401. The access token has lapsed: refresh it and try once
 *   more. A second 401 straight after a refresh means the sign-in itself is
 *   gone — the caller treats it as `reconnect`.
 * - `reconnect`: Xero no longer accepts this sign-in, or this organisation
 *   through it. Nothing PestM8 can do; the person has to connect again.
 * - `pause`: a rate limit with a time to come back (`until`, ms). `why` says
 *   which: the organisation's minute or day allowance, or Xero itself being
 *   down for a stated time (a 5xx with Retry-After).
 * - `retry`: worth trying again soon — too many calls in flight, a 5xx, or no
 *   answer at all.
 * - `stop`: Xero refused this request as made (other 4xx). Trying it again
 *   unchanged gets the same answer.
 */
export type Classified =
  | { kind: 'ok' }
  | { kind: 'refresh' }
  | { kind: 'reconnect'; code: string }
  | { kind: 'pause'; until: number; why: 'minute' | 'day' | 'server' }
  | { kind: 'retry'; afterMs: number }
  | { kind: 'stop'; code: string; status: number }

/** A call to Xero that did not succeed, with what it means. Its message
 * names the call and the status, never anything that was sent. */
export class XeroError extends Error {
  constructor(
    public classified: Classified,
    message?: string,
  ) {
    super(message ?? `Xero: ${classified.kind}`)
    this.name = 'XeroError'
  }
}

/** Xero's words for "this sign-in, or this organisation through it, is not
 * accepted any more" (the 403 body's `Detail`, or `Type`/`Title`). */
const AUTH_PROBLEMS = [
  'AuthenticationUnsuccessful',
  'AuthorizationUnsuccessful',
] as const

/**
 * The verdict on one Xero answer. Pure: the status, headers and parsed body
 * (JSON, or the text when it was not JSON), and the time now, for turning a
 * Retry-After into a moment.
 */
export function classify(
  status: number,
  headers: Headers,
  body: unknown,
  now: number,
): Classified {
  if (status >= 200 && status < 300) return { kind: 'ok' }

  // The token endpoint refusing PestM8 itself — its client id or secret, or
  // the request as a whole — whatever the status: retrying or reconnecting
  // cannot fix the app's own keys (\`isAppSetupRefusal\`).
  if (isRecord(body) && isAppSetupCode(body.error)) {
    return { kind: 'stop', code: body.error, status }
  }

  if (status === 401) return { kind: 'refresh' }

  // The token endpoint's word for a refresh token that is dead: revoked,
  // superseded by a newer consent, or unused for 60 days.
  if (isRecord(body) && body.error === 'invalid_grant') {
    return { kind: 'reconnect', code: 'invalid_grant' }
  }

  if (status === 403) {
    const problem = authProblem(body)
    if (problem) return { kind: 'reconnect', code: problem }
    return { kind: 'stop', code: stopCode(body, status), status }
  }

  if (status === 429) {
    const problem = (headers.get('X-Rate-Limit-Problem') ?? '').toLowerCase()
    const wait = retryAfterMs(headers.get('Retry-After'), now)
    // Too many at once is over as soon as one of them finishes: never a
    // reason to stop sending to the organisation for a while.
    if (wait === null || problem === 'concurrent') {
      return {
        kind: 'retry',
        afterMs: Math.max(wait ?? 0, CONCURRENT_RETRY_MS),
      }
    }
    const why = problem === 'day' || problem === 'daily' ? 'day' : 'minute'
    return { kind: 'pause', until: now + wait, why }
  }

  if (status >= 500) {
    // Xero's planned outages (503) say when to come back; a crash does not.
    const wait = retryAfterMs(headers.get('Retry-After'), now)
    if (wait !== null)
      return { kind: 'pause', until: now + wait, why: 'server' }
    return { kind: 'retry', afterMs: SERVER_RETRY_MS }
  }

  return { kind: 'stop', code: stopCode(body, status), status }
}

/** Retry-After as milliseconds from now: seconds (what Xero sends) or an
 * HTTP date. Null when absent or unreadable. */
function retryAfterMs(value: string | null, now: number): number | null {
  const text = (value ?? '').trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

function authProblem(body: unknown): string | undefined {
  const texts =
    typeof body === 'string'
      ? [body]
      : isRecord(body)
        ? ['Detail', 'Type', 'Title', 'detail', 'type', 'title', 'error']
            .map((field) => body[field])
            .filter((text): text is string => typeof text === 'string')
        : []
  return AUTH_PROBLEMS.find((name) => texts.some((t) => t.includes(name)))
}

/** A short code for a refused request: the OAuth `error` or Xero's `Type`
 * when it gives a code-shaped one, else the status. Kept to a code's shape
 * because it is stored on a row and looked up in xeroCopy.ts. */
function stopCode(body: unknown, status: number): string {
  if (isRecord(body)) {
    for (const value of [body.error, body.Type, body.type]) {
      if (typeof value === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(value)) {
        return value
      }
    }
  }
  return `http_${status}`
}

/**
 * The token endpoint's words for "this is not a request from an app I know":
 * a wrong client id or secret (\`invalid_client\`), an app not allowed this
 * grant (\`unauthorized_client\`), or credentials Xero could not read at all
 * (\`invalid_request\` — Xero answers that for a secret over 100 characters,
 * which is how a secret pasted twice showed itself on 15 Oct 2026).
 */
const APP_SETUP_CODES = [
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
]

function isAppSetupCode(value: unknown): value is string {
  return typeof value === 'string' && APP_SETUP_CODES.includes(value)
}

/**
 * Whether a failed call to the token endpoint means the deployment's own
 * Xero app keys (XERO_CLIENT_ID / XERO_CLIENT_SECRET) are wrong — something
 * only whoever runs PestM8 can fix, not the person connecting.
 */
export function isAppSetupRefusal(error: unknown): boolean {
  return (
    error instanceof XeroError &&
    error.classified.kind === 'stop' &&
    isAppSetupCode(error.classified.code)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Answer = { status: number; headers: Headers; body: unknown }

/**
 * One call to Xero. `what` names it in logs and errors, in place of the URL
 * (which can carry ids nobody needs in a log line). `fine` lists statuses
 * besides 2xx that the caller treats as success.
 */
async function call(
  what: string,
  url: string,
  init: RequestInit,
  fine: number[] = [],
): Promise<Answer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let answer: { status: number; headers: Headers; text: string }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    // The body is read under the same 20 s: an answer whose headers arrive
    // and whose body never does is no answer.
    answer = {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    }
  } catch (error) {
    const why =
      error instanceof Error && error.name === 'AbortError'
        ? `no answer in ${TIMEOUT_MS / 1000} s`
        : 'could not reach Xero'
    console.error(`[xero] ${what}: ${why}`)
    throw new XeroError(
      { kind: 'retry', afterMs: NO_ANSWER_RETRY_MS },
      `Xero ${what}: ${why}`,
    )
  } finally {
    clearTimeout(timer)
  }

  const { status, headers, text } = answer
  const body = parseBody(text)
  if ((status >= 200 && status < 300) || fine.includes(status)) {
    return { status, headers, body }
  }
  console.error(`[xero] ${what}: HTTP ${status} ${errorText(body)}`.trim())
  throw new XeroError(
    classify(status, headers, body, Date.now()),
    `Xero ${what}: HTTP ${status}`,
  )
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Xero's own words from a refusal, for the log: the OAuth error and its
 * description, or the API's Title/Detail/Message. A refusal carries no
 * tokens; a success, which might, never comes here. */
function errorText(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300)
  if (!isRecord(body)) return ''
  const words = [
    'error',
    'error_description',
    'Type',
    'Title',
    'Detail',
    'Message',
    'title',
    'detail',
    'message',
  ]
    .map((field) => body[field])
    .filter((text): text is string => typeof text === 'string' && text !== '')
  return [...new Set(words)].join(' · ').slice(0, 300)
}

/** A 2xx whose body is not what Xero documents. Logged without the body,
 * which may hold tokens. */
function badAnswer(what: string, status: number): XeroError {
  console.error(`[xero] ${what}: HTTP ${status} with an unexpected body`)
  return new XeroError(
    { kind: 'stop', code: 'bad_response', status },
    `Xero ${what}: unexpected answer`,
  )
}

/** HTTP Basic with the app's client id and secret, which is how Xero's
 * identity server wants a confidential (Web) app to identify itself. */
function basicAuth(): string {
  const pair = `${xeroClientId()}:${xeroClientSecret()}`
  return `Basic ${bytesToBase64(new TextEncoder().encode(pair))}`
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
}

async function tokenRequest(
  what: string,
  form: Record<string, string>,
): Promise<XeroTokenSet> {
  const { status, body } = await call(what, XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
  })
  if (!isRecord(body)) throw badAnswer(what, status)
  const expiresIn = Number(body.expires_in)
  if (
    typeof body.access_token !== 'string' ||
    body.access_token === '' ||
    typeof body.refresh_token !== 'string' ||
    body.refresh_token === '' ||
    !(expiresIn > 0)
  ) {
    throw badAnswer(what, status)
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn,
    scopes:
      typeof body.scope === 'string'
        ? body.scope.split(/\s+/).filter((s) => s !== '')
        : [],
    ...(typeof body.id_token === 'string' && body.id_token !== ''
      ? { idToken: body.id_token }
      : {}),
  }
}

/**
 * Trades the code Xero sent the browser back with for a token set. The
 * `redirect_uri` must be the very string the authorize URL carried
 * (lib/xeroConfig.ts `redirectUri`), or Xero refuses the trade.
 */
/**
 * Whether Xero accepts this deployment's client id and secret, asked without
 * anybody's sign-in: a client-credentials request, which Xero answers with
 * an app-only token when the keys are right. The token is dropped unread —
 * it is never returned, stored or logged. For \`xero:checkApp\`, run straight
 * after setting the keys (docs/xero.md).
 */
export async function checkAppCredentials(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    await call('app check', XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
      }).toString(),
    })
    return { ok: true }
  } catch (error) {
    if (error instanceof XeroError) {
      const c = error.classified
      return { ok: false, error: 'code' in c ? c.code : c.kind }
    }
    throw error
  }
}

export async function exchangeCode(code: string): Promise<XeroTokenSet> {
  return await tokenRequest('token exchange', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  })
}

/**
 * A new token set for a refresh token. Xero rotates the refresh token on
 * every use, so the answer's must replace the stored one — which is why only
 * the holder of the refresh lease calls this (convex/xeroTokens.ts). A dead
 * refresh token (`invalid_grant`) throws `XeroError` with `reconnect`.
 */
export async function refreshTokens(
  refreshToken: string,
): Promise<XeroTokenSet> {
  return await tokenRequest('token refresh', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

/**
 * Revokes a refresh token, and with it every access token issued from it:
 * the whole sign-in, across every organisation it reached. Only once nothing
 * in any business still uses the grant (convex/xero.ts `releaseAtXero`).
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await call('revoke', XERO_REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  })
}

/**
 * The organisations this sign-in reaches, newest first. With `authEventId`,
 * only those the consent that issued the token added — which is how the
 * callback tells which organisation the person just chose.
 */
export async function listConnections(
  accessToken: string,
  authEventId?: string,
): Promise<XeroTenant[]> {
  const url = authEventId
    ? `${XERO_CONNECTIONS_URL}?authEventId=${encodeURIComponent(authEventId)}`
    : XERO_CONNECTIONS_URL
  const { status, body } = await call('connections', url, {
    method: 'GET',
    headers: bearer(accessToken),
  })
  if (!Array.isArray(body)) throw badAnswer('connections', status)
  return body
    .flatMap((row: unknown) => {
      const tenant = tenantFrom(row)
      return tenant ? [tenant] : []
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

function tenantFrom(row: unknown): XeroTenant | null {
  if (!isRecord(row)) return null
  const { id, tenantId } = row
  if (typeof id !== 'string' || typeof tenantId !== 'string') return null
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const updatedAt = xeroTime(row.updatedDateUtc)
  return {
    id,
    authEventId: text(row.authEventId),
    tenantId,
    tenantType: text(row.tenantType),
    tenantName: text(row.tenantName),
    ...(updatedAt === null ? {} : { updatedAt }),
  }
}

/** Xero's connection timestamps are UTC without saying so
 * (`2026-10-06T01:02:03.1234567`); read without a zone they would be taken
 * as local time. */
function xeroTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const zoned = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
  const at = Date.parse(zoned)
  return Number.isNaN(at) ? null : at
}

/**
 * Takes one organisation off this sign-in at Xero, which is what frees its
 * place under the app's organisation cap. Already gone (404) is success:
 * the person may have removed PestM8 in Xero first.
 */
export async function deleteConnection(
  accessToken: string,
  xeroConnectionId: string,
): Promise<void> {
  await call(
    'delete connection',
    `${XERO_CONNECTIONS_URL}/${encodeURIComponent(xeroConnectionId)}`,
    { method: 'DELETE', headers: bearer(accessToken) },
    [404],
  )
}

/** The organisation's name as Xero has it now, and its short code (what an
 * "Open in Xero" link needs). */
export async function getOrganisation(
  accessToken: string,
  tenantId: string,
): Promise<{ name: string; shortCode?: string }> {
  const { status, body } = await call(
    'organisation',
    `${XERO_API_BASE}/Organisation`,
    {
      method: 'GET',
      headers: { ...bearer(accessToken), 'xero-tenant-id': tenantId },
    },
  )
  const organisations = isRecord(body) ? body.Organisations : undefined
  const org = Array.isArray(organisations) ? organisations[0] : undefined
  if (!isRecord(org) || typeof org.Name !== 'string' || org.Name === '') {
    throw badAnswer('organisation', status)
  }
  return {
    name: org.Name,
    ...(typeof org.ShortCode === 'string' && org.ShortCode !== ''
      ? { shortCode: org.ShortCode }
      : {}),
  }
}

/** Contacts per page of `GET /Contacts`: Xero's largest. A page with fewer
 * is the last. */
export const CONTACTS_PAGE_SIZE = 1000

/** One Xero contact, as the match reads it (lib/xeroMatch.ts), with the
 * person's own names Xero keeps beside the contact's Name. */
export type XeroContactRow = XeroContactForMatch & {
  firstName?: string
  lastName?: string
}

/**
 * What Xero says is left of this organisation's allowance for the app, from
 * the answer's headers: calls today (5,000 a day) and this minute (60). Absent
 * when Xero did not say, or said something that is not a count.
 */
export type XeroRate = { dayRemaining?: number; minRemaining?: number }

/**
 * One page of an organisation's contacts, archived ones included (the match
 * needs to know a contact is archived to leave it alone, rather than take
 * its absence as "not in Xero"). Read-only: `GET` is the only contact call
 * before Release 3.
 *
 * Each contact is mapped to the fields the match compares and the review
 * page shows, trimmed, and an empty one left out. A row without a ContactID
 * is dropped — there would be nothing to link it by.
 */
export async function getContactsPage(
  accessToken: string,
  tenantId: string,
  page: number,
): Promise<{ contacts: Array<XeroContactRow>; rate: XeroRate }> {
  const search = `page=${page}&pageSize=${CONTACTS_PAGE_SIZE}&includeArchived=true`
  const { status, headers, body } = await call(
    'contacts',
    `${XERO_API_BASE}/Contacts?${search}`,
    {
      method: 'GET',
      headers: { ...bearer(accessToken), 'xero-tenant-id': tenantId },
    },
  )
  const rows = isRecord(body) ? body.Contacts : undefined
  if (!Array.isArray(rows)) throw badAnswer('contacts', status)
  return {
    contacts: rows.flatMap((row: unknown) => {
      const contact = contactFrom(row)
      return contact ? [contact] : []
    }),
    rate: rateFrom(headers),
  }
}

/** The allowance left, from `X-DayLimit-Remaining` and
 * `X-MinLimit-Remaining`. */
export function rateFrom(headers: Headers): XeroRate {
  const count = (name: string): number | undefined => {
    const text = (headers.get(name) ?? '').trim()
    return /^\d+$/.test(text) ? Number(text) : undefined
  }
  const dayRemaining = count('X-DayLimit-Remaining')
  const minRemaining = count('X-MinLimit-Remaining')
  return {
    ...(dayRemaining === undefined ? {} : { dayRemaining }),
    ...(minRemaining === undefined ? {} : { minRemaining }),
  }
}

/** A trimmed string, or undefined for anything else or nothing. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * Xero's ContactStatus. Absent reads as ACTIVE, which is what Xero gives a
 * contact unless someone archives it: taking a contact with no status as
 * "not a candidate" would have Release 3 create a second one. A status Xero
 * adds later is not one the match knows to be safe, so it reads as
 * ARCHIVED — never a candidate.
 */
function statusOf(value: unknown): XeroContactRow['status'] {
  if (value === undefined || value === null || value === '') return 'ACTIVE'
  if (value === 'ACTIVE' || value === 'GDPRREQUEST') return value
  return 'ARCHIVED'
}

/** Which of a contact's numbers the review page shows: its main line, then
 * mobile, then direct dial, then anything else but a fax. */
const PHONE_ORDER = ['DEFAULT', 'MOBILE', 'DDI']

/**
 * The first number Xero holds for the contact, as it holds it: area code and
 * number joined ("08 9123 4567"). Xero sends every phone type, mostly empty.
 */
function phoneOf(phones: unknown): string | undefined {
  if (!Array.isArray(phones)) return undefined
  const numbers = phones.flatMap((phone: unknown) => {
    if (!isRecord(phone)) return []
    const type = textOf(phone.PhoneType)?.toUpperCase() ?? ''
    if (type === 'FAX') return []
    const number = textOf(phone.PhoneNumber)
    if (!number) return []
    const area = textOf(phone.PhoneAreaCode)
    const rank = PHONE_ORDER.indexOf(type)
    return [
      {
        text: area ? `${area} ${number}` : number,
        rank: rank === -1 ? PHONE_ORDER.length : rank,
      },
    ]
  })
  // A stable sort: within a rank, Xero's own order.
  numbers.sort((a, b) => a.rank - b.rank)
  return numbers.at(0)?.text
}

/** The City of the contact's first address that has one: its suburb, for
 * an Australian contact. */
function placeOf(addresses: unknown): string | undefined {
  if (!Array.isArray(addresses)) return undefined
  for (const address of addresses) {
    if (!isRecord(address)) continue
    const city = textOf(address.City)
    if (city) return city
  }
  return undefined
}

function contactFrom(row: unknown): XeroContactRow | null {
  if (!isRecord(row)) return null
  const contactId = textOf(row.ContactID)
  if (!contactId) return null
  const optional = {
    email: textOf(row.EmailAddress),
    accountNumber: textOf(row.AccountNumber),
    phone: phoneOf(row.Phones),
    place: placeOf(row.Addresses),
    firstName: textOf(row.FirstName),
    lastName: textOf(row.LastName),
  }
  const contact: XeroContactRow = {
    contactId,
    name: textOf(row.Name) ?? '',
    status: statusOf(row.ContactStatus),
  }
  for (const [field, value] of Object.entries(optional)) {
    if (value !== undefined) {
      contact[field as keyof typeof optional] = value
    }
  }
  return contact
}

// ───────────────────────────────────────── contact reads and writes (R3)

/** One of a contact's phones, as Xero holds it. Xero lists all four types
 * (DEFAULT, DDI, MOBILE, FAX) on every contact, most of them empty. */
export type XeroContactPhone = {
  PhoneType: string
  PhoneNumber?: string
  PhoneAreaCode?: string
  PhoneCountryCode?: string
}

/** One of a contact's addresses, as Xero holds it: POBOX (what an invoice
 * prints) and STREET. */
export type XeroContactAddress = {
  AddressType: string
  AddressLine1?: string
  AddressLine2?: string
  AddressLine3?: string
  AddressLine4?: string
  City?: string
  Region?: string
  PostalCode?: string
  Country?: string
  AttentionTo?: string
}

/** One of a contact's people (at most five): names and an email, nothing
 * else — Xero keeps no phone or role for them. */
export type XeroContactPerson = {
  FirstName?: string
  LastName?: string
  EmailAddress?: string
  IncludeInEmails?: boolean
}

/**
 * One Xero contact as the sync reads and writes it, in Xero's own field
 * names. Strings are kept exactly as Xero sent them (blanks included), so a
 * merged update (lib/xeroContact.ts `toXeroUpdate`) sends back the phones,
 * addresses and people PestM8 did not change as Xero holds them, not a
 * tidied copy. Anything that is not a string is left out.
 *
 * `ContactStatus` reads as `getContactsPage` reads it: absent is ACTIVE, a
 * status Xero adds later is ARCHIVED — the sync stops rather than write
 * into a contact it does not understand. `MergedToContactID` is present only
 * when it names a contact (Xero sends all zeros for none).
 */
export type XeroContactFull = {
  ContactID: string
  Name: string
  FirstName?: string
  LastName?: string
  EmailAddress?: string
  AccountNumber?: string
  TaxNumber?: string
  ContactStatus: 'ACTIVE' | 'ARCHIVED' | 'GDPRREQUEST'
  MergedToContactID?: string
  Phones: Array<XeroContactPhone>
  Addresses: Array<XeroContactAddress>
  ContactPersons: Array<XeroContactPerson>
}

/**
 * What Xero did with one element of a `PUT` or `POST /Contacts`, in the
 * order they were sent: match back by position, and check by `name`.
 *
 * - `contact`: the contact as Xero now holds it (its normalised forms, which
 *   is what the sync's `seen` hashes are taken from). Present only when this
 *   element was written.
 * - `errors`: Xero's own words for why it was not (the element's
 *   `ValidationErrors`). For `isNameClash`, a code map and `console.error`
 *   only — never a row, a log of success, or the screen.
 * - `name`: the Name Xero echoed back for this element, written or not.
 */
export type ItemResult = {
  contact?: XeroContactFull
  errors: Array<string>
  name?: string
}

/** Xero's id for "no contact": what a failed element of a batch carries. */
const NO_CONTACT_ID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/

/** Ids per `GET /Contacts?IDs=`: a URL of 50 GUIDs stays well under any
 * proxy's limit, and it is the size of an update batch. */
export const CONTACT_IDS_PER_READ = 50

/** The most Xero keeps of an `Idempotency-Key`. */
const IDEMPOTENCY_KEY_MAX = 128

/**
 * A fresh `Idempotency-Key`: 64 random bytes as hex, 128 characters — Xero's
 * longest. Minted once per request in the action that sends it, and reused
 * ONLY when that same request is tried again (a timeout, a 5xx, too many at
 * once), so a create whose answer was lost is not made twice. Never derived
 * from the payload: two different clients with the same details are two
 * requests, and must not be taken for one.
 *
 * Xero keeps a key for 6 minutes, per app rather than per organisation, and
 * replays a cached error as well as a cached success.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(IDEMPOTENCY_KEY_MAX / 2)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether one element's error is Xero's name clash: Name must be unique
 * among an organisation's ACTIVE contacts, and a create (or a rename) that
 * takes one already held fails with "The contact name John Smith is already
 * assigned to another contact." The sync answers that with a suffix or a
 * question (convex/xeroSync.ts `resolveCreateClash`, `resolveRenameClash`),
 * never with a failure.
 */
export function isNameClash(message: string): boolean {
  return /\bname\b[\s\S]*\balready assigned to another contact\b/i.test(message)
}

/** The headers of an Accounting call. The organisation is never defaulted:
 * a blank tenant id is a bug in the caller, refused before anything is
 * sent, because Xero would answer for some other organisation or none. */
function tenantHeaders(
  accessToken: string,
  tenantId: string,
): Record<string, string> {
  if (tenantId.trim() === '') {
    throw new Error('Xero: an Accounting call needs its xero-tenant-id')
  }
  return { ...bearer(accessToken), 'xero-tenant-id': tenantId }
}

/**
 * Creates contacts: `PUT /Contacts`, which only ever creates — unlike a
 * POST without a ContactID, which may quietly update whichever contact has
 * the same Name. `summarizeErrors=false`, so one bad element fails alone
 * and the answer says, element by element, what happened (`ItemResult`, in
 * request order).
 *
 * An empty list sends nothing. A whole-request refusal (rate limit, 5xx,
 * reconnect, a 400 for the request itself) throws `XeroError`, as every
 * call here does; per-element validation errors do not.
 */
export async function putContacts(
  accessToken: string,
  tenantId: string,
  contacts: Array<object>,
  idempotencyKey: string,
): Promise<{ results: Array<ItemResult>; rate: XeroRate }> {
  return await writeContacts(
    'PUT',
    accessToken,
    tenantId,
    contacts,
    idempotencyKey,
  )
}

/**
 * Updates contacts: `POST /Contacts` with every element naming its
 * `ContactID` (lib/xeroContact.ts `buildUpdateBatch`). An element without
 * one is refused here before anything is sent: Xero would take it as
 * "create, or update whoever has this Name", which is how a stranger's
 * contact gets this client's details. `summarizeErrors=false`, results in
 * request order, as `putContacts`.
 */
export async function postContacts(
  accessToken: string,
  tenantId: string,
  contacts: Array<object>,
  idempotencyKey: string,
): Promise<{ results: Array<ItemResult>; rate: XeroRate }> {
  for (const contact of contacts) {
    const id = (contact as { ContactID?: unknown }).ContactID
    if (typeof id !== 'string' || id.trim() === '' || NO_CONTACT_ID.test(id)) {
      throw new Error('Xero: every contact in an update needs its ContactID')
    }
  }
  return await writeContacts(
    'POST',
    accessToken,
    tenantId,
    contacts,
    idempotencyKey,
  )
}

async function writeContacts(
  method: 'PUT' | 'POST',
  accessToken: string,
  tenantId: string,
  contacts: Array<object>,
  idempotencyKey: string,
): Promise<{ results: Array<ItemResult>; rate: XeroRate }> {
  const headers = tenantHeaders(accessToken, tenantId)
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX
  ) {
    throw new Error('Xero: an Idempotency-Key is 1 to 128 characters')
  }
  if (contacts.length === 0) return { results: [], rate: {} }

  const what = method === 'PUT' ? 'create contacts' : 'update contacts'
  const {
    status,
    headers: answered,
    body,
  } = await call(what, `${XERO_API_BASE}/Contacts?summarizeErrors=false`, {
    method,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ Contacts: contacts }),
  })
  const rows = isRecord(body) ? body.Contacts : undefined
  // Results are matched back by position, so an answer that does not have
  // one per element sent cannot be read at all.
  if (!Array.isArray(rows) || rows.length !== contacts.length) {
    throw badAnswer(what, status)
  }
  return { results: rows.map(itemFrom), rate: rateFrom(answered) }
}

/** One element of a write's answer. Written means no validation errors and
 * a real ContactID; Xero gives a failed element all zeros. */
function itemFrom(row: unknown): ItemResult {
  if (!isRecord(row))
    return { errors: ['Xero sent no result for this contact'] }
  const name = typeof row.Name === 'string' ? row.Name : undefined
  const named = name === undefined ? {} : { name }
  const errors = messagesOf(row.ValidationErrors)
  if (errors.length === 0 && row.StatusAttributeString === 'ERROR') {
    errors.push('Xero refused this contact without saying why')
  }
  if (errors.length > 0) return { errors, ...named }
  const contact = fullContactFrom(row)
  if (!contact) {
    return { errors: ['Xero returned no ContactID for this contact'], ...named }
  }
  return { contact, errors: [], ...named }
}

/** The `Message` of each of Xero's `ValidationErrors`. */
function messagesOf(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value.flatMap((error: unknown) => {
    const message = isRecord(error) ? textOf(error.Message) : undefined
    return message === undefined ? [] : [message]
  })
}

/**
 * The contacts with these ids, as Xero holds them now: what an update is
 * compared against (lib/xeroContact.ts `diff`), and how a merge, an archive
 * or a GDPR request in Xero is noticed. Archived contacts included — a
 * contact that has gone missing from the answer is not one that was
 * archived.
 *
 * At most 50 ids. None sends nothing: `GET /Contacts` with no ids is every
 * contact in the organisation. `page=1` asks for each contact in full
 * (people and addresses included), as a paged read gives it.
 */
export async function getContactsByIds(
  accessToken: string,
  tenantId: string,
  ids: Array<string>,
): Promise<{ contacts: Array<XeroContactFull>; rate: XeroRate }> {
  const headers = tenantHeaders(accessToken, tenantId)
  if (ids.length > CONTACT_IDS_PER_READ) {
    throw new Error(`Xero: at most ${CONTACT_IDS_PER_READ} ids per read`)
  }
  const wanted = ids.filter((id) => id.trim() !== '')
  if (wanted.length === 0) return { contacts: [], rate: {} }

  const search = [
    `IDs=${wanted.map(encodeURIComponent).join(',')}`,
    'includeArchived=true',
    'page=1',
  ].join('&')
  const {
    status,
    headers: answered,
    body,
  } = await call('contacts by id', `${XERO_API_BASE}/Contacts?${search}`, {
    method: 'GET',
    headers,
  })
  const rows = isRecord(body) ? body.Contacts : undefined
  if (!Array.isArray(rows)) throw badAnswer('contacts by id', status)
  return {
    contacts: rows.flatMap((row: unknown) => {
      const contact = fullContactFrom(row)
      return contact ? [contact] : []
    }),
    rate: rateFrom(answered),
  }
}

/** A name as Xero's uniqueness compares it, near enough: trimmed, spaces
 * collapsed, any case. */
function nameFold(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The contact holding this Name, if any: who a create clashed with
 * (convex/xeroSync.ts `resolveCreateClash`). An ACTIVE contact first — Name
 * is unique only among those — else whatever else holds it (a contact
 * frozen by a GDPR request).
 *
 * `where=Name=="…"`, the name as PestM8 sent it, with `"` and `\` escaped
 * by a backslash. Only an exact match is returned, compared trimmed and in
 * any case, so a filter that matches more loosely than Xero's uniqueness
 * check never hands back the wrong contact. Two things only the Demo
 * Company can settle (docs/xero.md, gate l): whether Xero's filter wants
 * quotes escaped this way, and whether it ignores case as its uniqueness
 * check may — a name that clashed but is not found comes back null.
 */
export async function getContactByName(
  accessToken: string,
  tenantId: string,
  name: string,
): Promise<XeroContactFull | null> {
  const headers = tenantHeaders(accessToken, tenantId)
  const wanted = name.trim()
  if (wanted === '') return null

  const where = `Name=="${wanted.replace(/["\\]/g, (ch) => `\\${ch}`)}"`
  const { status, body } = await call(
    'contact by name',
    `${XERO_API_BASE}/Contacts?where=${encodeURIComponent(where)}&page=1`,
    { method: 'GET', headers },
  )
  const rows = isRecord(body) ? body.Contacts : undefined
  if (!Array.isArray(rows)) throw badAnswer('contact by name', status)
  const holders = rows.flatMap((row: unknown) => {
    const contact = fullContactFrom(row)
    return contact && nameFold(contact.Name) === nameFold(wanted)
      ? [contact]
      : []
  })
  return (
    holders.find((contact) => contact.ContactStatus === 'ACTIVE') ??
    holders.at(0) ??
    null
  )
}

/** A string Xero sent, as it sent it; anything else is left out. */
function rawText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Only the string fields of a record Xero sent, as `T`, always with its
 * `key` (a phone's type, an address's type). */
function stringFields<T>(
  row: unknown,
  fields: ReadonlyArray<string>,
  key: string,
): T | null {
  if (!isRecord(row) || typeof row[key] !== 'string') return null
  const picked: Record<string, string> = {}
  for (const field of fields) {
    const value = rawText(row[field])
    if (value !== undefined) picked[field] = value
  }
  return picked as T
}

const PHONE_FIELDS = [
  'PhoneType',
  'PhoneNumber',
  'PhoneAreaCode',
  'PhoneCountryCode',
] as const

const ADDRESS_FIELDS = [
  'AddressType',
  'AddressLine1',
  'AddressLine2',
  'AddressLine3',
  'AddressLine4',
  'City',
  'Region',
  'PostalCode',
  'Country',
  'AttentionTo',
] as const

function personFrom(row: unknown): XeroContactPerson | null {
  if (!isRecord(row)) return null
  const person: XeroContactPerson = {}
  for (const field of ['FirstName', 'LastName', 'EmailAddress'] as const) {
    const value = rawText(row[field])
    if (value !== undefined) person[field] = value
  }
  if (typeof row.IncludeInEmails === 'boolean') {
    person.IncludeInEmails = row.IncludeInEmails
  }
  return person
}

/** A contact from any of Xero's answers, in full, or null when it has no
 * real ContactID — there would be nothing to link or update it by. */
function fullContactFrom(row: unknown): XeroContactFull | null {
  if (!isRecord(row)) return null
  const contactId = textOf(row.ContactID)
  if (!contactId || NO_CONTACT_ID.test(contactId)) return null
  const list = <T>(value: unknown, read: (item: unknown) => T | null) =>
    Array.isArray(value)
      ? value.flatMap((item: unknown) => {
          const one = read(item)
          return one === null ? [] : [one]
        })
      : []
  const merged = textOf(row.MergedToContactID)
  const contact: XeroContactFull = {
    ContactID: contactId,
    Name: rawText(row.Name) ?? '',
    ContactStatus: statusOf(row.ContactStatus),
    Phones: list(row.Phones, (item) =>
      stringFields<XeroContactPhone>(item, PHONE_FIELDS, 'PhoneType'),
    ),
    Addresses: list(row.Addresses, (item) =>
      stringFields<XeroContactAddress>(item, ADDRESS_FIELDS, 'AddressType'),
    ),
    ContactPersons: list(row.ContactPersons, personFrom),
  }
  for (const field of [
    'FirstName',
    'LastName',
    'EmailAddress',
    'AccountNumber',
    'TaxNumber',
  ] as const) {
    const value = rawText(row[field])
    if (value !== undefined) contact[field] = value
  }
  if (merged && !NO_CONTACT_ID.test(merged)) {
    contact.MergedToContactID = merged
  }
  return contact
}

/**
 * A JWT's claims, read without checking its signature.
 *
 * Only for a token this same action has just been handed by Xero's token
 * endpoint, over TLS, in exchange for PestM8's own client secret: nothing
 * stood between Xero and here to alter it, so there is nothing a signature
 * check would add. A token from anywhere else — a browser, a request
 * parameter, a row — must never be read this way.
 *
 * Throws on anything that is not three dot-separated segments with a JSON
 * object in the middle. The error never contains the token.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Not a JWT')
  let payload: unknown
  try {
    payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        base64UrlToBytes(parts[1]),
      ),
    )
  } catch {
    throw new Error('Not a JWT')
  }
  if (!isRecord(payload)) throw new Error('Not a JWT')
  return payload
}
