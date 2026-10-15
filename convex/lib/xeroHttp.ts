/**
 * Xero over plain `fetch`: the OAuth token endpoints, the connections list,
 * and the Accounting calls — `GET /Organisation` (Release 1) and the paged
 * `GET /Contacts` the match reads (Release 2). Nothing here writes a contact.
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
 * Release 3 adds the contact writes here (per-item validation errors). Every
 * Accounting call names its organisation (`xero-tenant-id`).
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
