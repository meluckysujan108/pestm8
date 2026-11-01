/**
 * Xero, as this deployment is set up for it. One definition, read by the
 * actions that call Xero, the mutations that queue work for them and the
 * queries that explain to the screen why nothing is happening — the same
 * reason `lib/emailConfig.ts` is one definition.
 *
 * Every variable is optional on purpose. A deployment without them (e2e,
 * local, unit tests) is "not set up for Xero": Connect is refused, the client
 * hooks do nothing, and Settings says so. Reading them at module load
 * (`requireEnv`) would stop such a deployment loading at all.
 *
 * See docs/xero.md for which Xero app each deployment uses.
 */

/** Client id, secret and the token key are all present. */
export function xeroConfigured(): boolean {
  return Boolean(
    process.env.XERO_CLIENT_ID &&
    process.env.XERO_CLIENT_SECRET &&
    process.env.XERO_TOKEN_KEYS,
  )
}

/** The kill switch: `XERO_SYNC_PAUSED=on` stops every write to Xero. Changes
 * still queue, so nothing is lost while it is on. */
export function xeroPaused(): boolean {
  return process.env.XERO_SYNC_PAUSED === 'on'
}

/**
 * Whether connecting Xero needs two-step sign-in on for whoever connects:
 * `XERO_TWO_STEP_REQUIRED=on`. Off by default (the owner's call, 1 Nov 2026),
 * as two-step sign-in is everywhere else in PestM8 (lib/mfa.ts,
 * `AUTH_MFA_REQUIRED`).
 *
 * Xero asks an app to put two-step sign-in on its own users only past 1,000
 * connected organisations, or for its Practice Manager, Tax and HQ APIs (its
 * security standard for API consumers) — PestM8 holds at most `maxOrgs()`.
 * Whoever approves a connection signs in to Xero itself, which asks for its
 * own two-step sign-in. What a password alone could do — copy the client
 * book into an organisation of its choosing — is told, instead of refused:
 * every connect emails the person whose account it was, and the owner when a
 * member connects their own (convex/xero.ts `finish`). Turn this on to
 * refuse it again, without a code change.
 */
export function xeroTwoStepRequired(): boolean {
  return process.env.XERO_TWO_STEP_REQUIRED === 'on'
}

/**
 * How many distinct Xero organisations this deployment may hold, across
 * every business. Xero's free Starter tier allows 5 for the whole app; Core
 * ($35 AUD a month) allows 50. Past the cap Xero itself refuses, but by then
 * the person has been through Xero's sign-in for nothing — so PestM8 says no
 * first, in words.
 */
export function maxOrgs(): number {
  const n = Number(process.env.XERO_MAX_ORGS)
  return Number.isInteger(n) && n > 0 ? n : 5
}

/** The app's own origin, for the redirect after Xero sends the browser
 * back. Built from SITE_URL, never a request header. */
export function siteUrl(): string {
  return (process.env.SITE_URL ?? '').replace(/\/+$/, '')
}

/**
 * Where Xero sends the browser back to. Must match one registered on the Xero
 * app exactly, and the token exchange must send the identical string. Each
 * Convex deployment has its own `.convex.site` origin; a local backend has
 * to be registered as `http://localhost:<port>` (Xero refuses 127.0.0.1),
 * which is what `XERO_REDIRECT_URI` overrides it to.
 */
export function redirectUri(): string {
  const override = process.env.XERO_REDIRECT_URI
  if (override) return override
  const site = (process.env.CONVEX_SITE_URL ?? '').replace(/\/+$/, '')
  return `${site}/xero/callback`
}

export function xeroClientId(): string {
  return process.env.XERO_CLIENT_ID ?? ''
}

export function xeroClientSecret(): string {
  return process.env.XERO_CLIENT_SECRET ?? ''
}

/**
 * What PestM8 asks Xero for. Contacts read and write, the organisation's
 * settings read (its short code, for "Open in Xero"), and `offline_access` for
 * a refresh token. `openid profile email` name the Xero user, which is how a
 * token set is keyed. Invoices (`accounting.invoices`) are a later phase and
 * mean one re-consent each then: Xero adds scopes only through its sign-in.
 */
export const XERO_SCOPES =
  'offline_access openid profile email accounting.contacts accounting.settings.read'

export const XERO_AUTHORIZE_URL =
  'https://login.xero.com/identity/connect/authorize'
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
export const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation'
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

/**
 * The terms and privacy text someone agrees to by connecting. Bump it when
 * either page changes what it says about Xero; each connection records the
 * version it was made under.
 */
export const XERO_TERMS_VERSION = '2026-11-01'

/** How long a Connect may sit at Xero's sign-in before it is refused. */
export const XERO_STATE_TTL_MS = 10 * 60 * 1000
/** How long the app has to finish once Xero has sent the browser back. */
export const XERO_FINISH_TTL_MS = 15 * 60 * 1000
