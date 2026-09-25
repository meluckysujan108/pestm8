import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'

/**
 * Check the suite is pointed at a server that actually works, before 119 tests
 * discover it one confusing failure at a time.
 *
 * The failure this exists for: `vite preview` prints "Port 3000 is in use,
 * trying another one" and quietly moves to 3001, leaving a stale dev server on
 * the port the suite targets. That server answers the HTML fine and returns 500
 * for every built asset, so nothing hydrates, and every test fails on whatever
 * control it touched first — 35 of them, all reading like an application
 * regression rather than a wrong port.
 *
 * `assertSafeTarget` in fixtures.ts already does this for the Convex
 * deployment. Same idea, other half: the deployment guard stops the suite
 * writing to the wrong place, this one stops it reading from the wrong place.
 */
export default async function globalSetup() {
  await assertTwoStepOff()

  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

  let html: string
  try {
    const res = await fetch(`${baseURL}/login`)
    if (!res.ok) {
      throw new Error(`${baseURL}/login returned ${res.status}`)
    }
    html = await res.text()
  } catch (cause) {
    throw new Error(
      `Nothing is serving ${baseURL}. Build and start the preview first:\n` +
        `  pnpm build && npx vite preview --port 3000\n` +
        `and check it did not fall back to another port.\n` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  // A production build references hashed assets; a dev server references
  // /@vite/client and compiles on demand. The suite needs the former — the
  // service worker and __Secure- cookies only exist there.
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  if (!asset) {
    throw new Error(
      `${baseURL} is not serving a production build — no hashed asset in the ` +
        `HTML. The suite needs one (the service worker and __Secure- cookies ` +
        `only exist there):\n  pnpm build && npx vite preview --port 3000`,
    )
  }

  const assetRes = await fetch(`${baseURL}${asset}`)
  if (!assetRes.ok) {
    throw new Error(
      `${baseURL} serves HTML but returns ${assetRes.status} for ${asset}.\n` +
        `That is usually a DIFFERENT server on this port than the one you just ` +
        `started — vite preview prints "Port 3000 is in use, trying another ` +
        `one" and moves to 3001 without failing.\n` +
        `Nothing will hydrate, so every test fails on whatever control it ` +
        `touches first. Free the port, or set E2E_BASE_URL to the port the ` +
        `preview actually bound.`,
    )
  }
}

/**
 * Two-step sign-in is optional unless a deployment sets
 * `AUTH_MFA_REQUIRED=on` (convex/lib/mfa.ts), and every account this suite
 * makes signs up with a password and nothing else — it cannot read an
 * authenticator app. Where it is compulsory, the first app call of every spec
 * is refused and the whole run fails with errors that look like anything but
 * this.
 *
 * `auth.twoFactorStatus` answers a signed-out caller, so asking costs no
 * account. Skipped when there is no VITE_CONVEX_URL: fixtures.ts refuses that
 * on its own, with its own message.
 */
async function assertTwoStepOff() {
  const url = process.env.VITE_CONVEX_URL
  if (!url) return
  const status = await new ConvexHttpClient(url).query(
    api.auth.twoFactorStatus,
    {},
  )
  if (status.required) {
    throw new Error(
      `Two-step sign-in is compulsory on the e2e deployment (${url}), and the ` +
        `suite's accounts cannot use an authenticator app, so every spec ` +
        `would fail. Make it optional on THAT deployment — never prod:\n` +
        `  npx convex env remove AUTH_MFA_REQUIRED   (against the e2e deployment)`,
    )
  }
}
