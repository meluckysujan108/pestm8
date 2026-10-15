import { httpAction } from './_generated/server'
import { internal } from './_generated/api'
import { hashInviteToken, newInviteToken } from './lib/inviteTokens'
import { siteUrl, xeroConfigured } from './lib/xeroConfig'
import { accessAad, encryptToken, refreshAad } from './lib/xeroCrypto'
import {
  decodeJwtPayload,
  deleteConnection,
  exchangeCode,
  isAppSetupRefusal,
  listConnections,
  revokeRefreshToken,
} from './lib/xeroHttp'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import type { XeroTenant, XeroTokenSet } from './lib/xeroHttp'

/**
 * `GET /xero/callback` — where Xero's sign-in sends the browser back
 * (convex/xero.ts has the whole connect).
 *
 * Unauthenticated by nature: it is a browser arriving from Xero with a code
 * and our `state`, and nothing else. So it trusts nothing but the state —
 * spent here, once — and it never connects anything: it stores what Xero
 * gave as `pending` and hands the browser a one-time finish token, which only
 * the person who pressed Connect, signed in, can redeem. Every answer is a
 * 302 back into the app, to the page the connect started from, with a code
 * that page words (`?xero=…`) or the finish token (`?finish=…`).
 *
 * Nothing about the request reaches a log: its URL carries the code and the
 * state, and the tokens Xero returns are encrypted before they leave this
 * function.
 */
export const xeroCallback = httpAction(async (ctx, request) => {
  // 404, not an error page: a deployment without Xero should not confirm
  // the route exists to whoever is probing for it.
  if (!xeroConfigured()) return new Response(null, { status: 404 })

  const params = new URL(request.url).searchParams
  const state = params.get('state')
  const home = `${siteUrl()}/`
  if (!state) return redirect(home)

  let page: string | null = null
  try {
    const taken = await ctx.runMutation(internal.xero.takeState, {
      stateHash: await hashInviteToken(state),
    })
    if (taken.outcome === 'unknown') return redirect(home)
    page = settingsPage(taken.slug, taken.kind)
    if (taken.outcome === 'expired') return redirect(`${page}?xero=expired`)

    // They pressed Cancel at Xero (`access_denied`), or Xero could not go on.
    const error = params.get('error')
    if (error) {
      return redirect(
        `${page}?xero=${error === 'access_denied' ? 'cancelled' : 'failed'}`,
      )
    }

    const code = params.get('code')
    if (!code) return redirect(`${page}?xero=failed`)

    let tokens: XeroTokenSet
    try {
      tokens = await exchangeCode(code)
    } catch (exchangeError) {
      // Xero refusing PestM8's own keys is not the person's to fix, and
      // "try again" would only fail again: the page says so, and the log
      // says what to check.
      const appSetup = isAppSetupRefusal(exchangeError)
      console.error(
        `xero callback: code exchange failed: ${describe(exchangeError)}` +
          (appSetup
            ? ' — Xero refused this deployment’s XERO_CLIENT_ID / XERO_CLIENT_SECRET (or its redirect URI); check with `npx convex run xero:checkApp`'
            : ''),
      )
      return redirect(`${page}?xero=${appSetup ? 'app_setup' : 'failed'}`)
    }

    return await connect(ctx, taken, tokens, page)
  } catch (unexpected) {
    console.error(`xero callback: ${describe(unexpected)}`)
    return redirect(page ? `${page}?xero=failed` : home)
  }
})

type Taken = {
  stateId: Id<'xeroOAuthStates'>
  slug: string
  kind: 'business' | 'member'
  reconnectTenantId?: string
}

/** From Xero's tokens to a `pending` connection, or a refusal. */
async function connect(
  ctx: ActionCtx,
  taken: Taken,
  tokens: XeroTokenSet,
  page: string,
): Promise<Response> {
  // Not verified, and it need not be: these tokens came straight from Xero's
  // token endpoint over TLS, in answer to our own client secret, moments ago.
  // The claims only say which Xero user and which sign-in they belong to.
  const claims = decodeJwtPayload(tokens.accessToken)
  const xeroUserId =
    typeof claims.xero_userid === 'string' ? claims.xero_userid : ''
  if (!xeroUserId) throw new Error('access token has no xero_userid')
  const authEventId =
    typeof claims.authentication_event_id === 'string'
      ? claims.authentication_event_id
      : undefined

  const grant = {
    xeroUserId,
    accessCipher: await encryptToken(tokens.accessToken, accessAad(xeroUserId)),
    accessExpiresAt: Date.now() + tokens.expiresIn * 1000,
    refreshCipher: await encryptToken(
      tokens.refreshToken,
      refreshAad(xeroUserId),
    ),
    scopes: tokens.scopes,
  }

  let tenants: Array<XeroTenant>
  try {
    tenants = await tenantsOf(tokens.accessToken, authEventId)
  } catch (error) {
    // This consent replaced the user's earlier tokens at Xero whatever
    // happens next; keep them for the connections that use them.
    await ctx.runMutation(internal.xero.keepGrant, grant)
    throw error
  }

  const choice = choose(tenants, authEventId, taken.reconnectTenantId)
  if ('none' in choice) {
    // A practice (Xero HQ) or nothing at all — PestM8 copies clients into an
    // organisation's contacts, which a practice does not have — or no way
    // to tell which organisation they chose.
    const grantId = await ctx.runMutation(internal.xero.keepGrant, grant)
    await tidy(ctx, tokens.accessToken, tenants, authEventId, null)
    await releaseIfUnused(ctx, grantId, tokens.refreshToken)
    return redirect(`${page}?xero=${choice.none}`)
  }
  const chosen = choice.tenant

  const finishToken = newInviteToken()
  const stored = await ctx.runMutation(internal.xero.storeCallback, {
    stateId: taken.stateId,
    ...grant,
    tenantId: chosen.tenantId,
    tenantName: chosen.tenantName,
    xeroConnectionId: chosen.id,
    finishHash: await hashInviteToken(finishToken),
  })

  if (stored.outcome === 'refused') {
    // Xero connected the organisation when they chose it; PestM8 will not
    // use it, so it comes back out — unless someone here, or in another
    // business, holds that very connection.
    await deleteIfUnheld(ctx, tokens.accessToken, chosen.id)
    await tidy(ctx, tokens.accessToken, tenants, authEventId, chosen.id)
    await releaseIfUnused(ctx, stored.grantId, tokens.refreshToken)
    return redirect(`${page}?xero=${stored.reason}`)
  }

  await tidy(ctx, tokens.accessToken, tenants, authEventId, chosen.id)
  return redirect(
    `${settingsPage(stored.slug, stored.kind)}?finish=${encodeURIComponent(finishToken)}`,
  )
}

/**
 * The organisations this sign-in connected: those of this sign-in event
 * first, and — when Xero lists none for it, which happens when the person
 * chose one that was already connected — every one this Xero user has, for
 * `choose` to pick from only when that leaves no doubt.
 */
async function tenantsOf(
  accessToken: string,
  authEventId: string | undefined,
): Promise<Array<XeroTenant>> {
  if (authEventId) {
    const forEvent = await listConnections(accessToken, authEventId)
    if (forEvent.length > 0) return forEvent
  }
  return listConnections(accessToken)
}

/**
 * Which organisation this connect is for, or why there is none. Only
 * organisations: a practice has no contacts to keep.
 *
 * A reconnect takes back its own. Otherwise the one Xero stamped with this
 * sign-in. Failing that — Xero listing nothing for this sign-in, as when
 * the organisation chosen was connected already — the only organisation
 * this Xero login has, if it has only one. With two or more, which one they
 * ticked cannot be told (the date Xero last touched each need not be this
 * sign-in's), and a guess would copy a whole client book into an
 * organisation nobody chose: `ambiguous_org`, and they try again.
 */
function choose(
  tenants: Array<XeroTenant>,
  authEventId: string | undefined,
  reconnectTenantId: string | undefined,
): { tenant: XeroTenant } | { none: 'no_org' | 'ambiguous_org' } {
  const organisations = tenants.filter(
    (tenant) => tenant.tenantType === 'ORGANISATION',
  )
  if (reconnectTenantId) {
    const own = organisations.find((t) => t.tenantId === reconnectTenantId)
    if (own) return { tenant: own }
  }
  if (authEventId) {
    const chosenNow = organisations.find((t) => t.authEventId === authEventId)
    if (chosenNow) return { tenant: chosenNow }
  }
  if (organisations.length === 1) return { tenant: organisations[0] }
  return { none: organisations.length === 0 ? 'no_org' : 'ambiguous_org' }
}

/**
 * Takes out what this sign-in connected and PestM8 is not keeping — a second
 * organisation ticked on Xero's screen, a practice — so none of it sits in
 * the person's Connected apps, or counts against the app's organisation
 * limit. Only this sign-in's (`authEventId`), never one held by a live
 * connection anywhere, and best-effort: the page's answer does not wait on it.
 */
async function tidy(
  ctx: ActionCtx,
  accessToken: string,
  tenants: Array<XeroTenant>,
  authEventId: string | undefined,
  keep: string | null,
): Promise<void> {
  if (!authEventId) return
  for (const tenant of tenants) {
    if (tenant.authEventId !== authEventId || tenant.id === keep) continue
    await deleteIfUnheld(ctx, accessToken, tenant.id)
  }
}

async function deleteIfUnheld(
  ctx: ActionCtx,
  accessToken: string,
  xeroConnectionId: string,
): Promise<void> {
  try {
    const held = await ctx.runQuery(internal.xero.liveOnXeroConnection, {
      xeroConnectionId,
    })
    if (held === 0) await deleteConnection(accessToken, xeroConnectionId)
  } catch (error) {
    console.error(
      `xero callback: removing connection ${xeroConnectionId} failed: ${describe(error)}`,
    )
  }
}

/**
 * Revokes this sign-in when nothing PestM8 keeps uses it — a refusal or no
 * organisation, from someone with no other connection — so it does not sit
 * at Xero, or on a row the nightly refresh would keep alive for nothing.
 * Best-effort, like `tidy`.
 */
async function releaseIfUnused(
  ctx: ActionCtx,
  grantId: Id<'xeroGrants'> | null,
  refreshToken: string,
): Promise<void> {
  try {
    if (grantId) {
      // Checks and forgets in one transaction (`dropGrant`): a grant some
      // live connection uses stays, and is not revoked.
      const { dropped } = await ctx.runMutation(internal.xero.dropGrant, {
        grantId,
      })
      if (!dropped) return
    }
    await revokeRefreshToken(refreshToken)
  } catch (error) {
    console.error(
      `xero callback: revoking the sign-in failed: ${describe(error)}`,
    )
  }
}

/** The page a connect started from: Business → Xero, or My Xero. */
function settingsPage(slug: string, kind: 'business' | 'member'): string {
  return `${siteUrl()}/${slug}/settings/${kind === 'business' ? 'xero' : 'my-xero'}`
}

/**
 * Never cached, and no referrer: the address this answers carries the code
 * and the state, and the one it sends the browser to carries a finish token.
 */
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/** An error as a log line may carry it: never a token, code or header. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
