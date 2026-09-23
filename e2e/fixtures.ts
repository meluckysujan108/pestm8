import { expect } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'
import type { Locator, Page } from '@playwright/test'
import type { Id } from '../convex/_generated/dataModel'

/**
 * Fixture contract for the access-control matrix (ARCHITECTURE.md §6.5).
 *
 * Every negative case is asserted twice: once through the UI, and once by
 * calling the Convex function directly with that actor's token. The direct
 * call is the assertion that matters — a hidden button is not access control.
 *
 * These drive the Better Auth HTTP endpoints with raw fetch rather than the
 * React client: the client assumes a browser cookie jar, which a Node test
 * process does not have. Convex authenticates with the JWT minted by the
 * convex plugin at /api/auth/convex/token, not the Better Auth session token.
 */

export const FIXTURE_PASSWORD = 'fixture-password-8823'

const CONVEX_URL = process.env.VITE_CONVEX_URL!
const SITE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const AUTH_BASE = `${SITE_URL}/api/auth`

/**
 * A run creates about 150 real accounts and 100 businesses, and never cleans
 * up. Nothing stopped that being pointed at production: the target comes from
 * whichever .env.local happens to be present, and CLAUDE.md records that this
 * checkout has pointed at the wrong project before.
 *
 * Production deployment names are refused by name, and anything that isn't a
 * dev deployment is refused by shape.
 */
const FORBIDDEN_DEPLOYMENTS = ['rare-retriever-156', 'joyous-otter-223']

function assertSafeTarget() {
  const deployment = process.env.CONVEX_DEPLOYMENT ?? ''
  const target = `${deployment} ${CONVEX_URL}`

  for (const name of FORBIDDEN_DEPLOYMENTS) {
    if (target.includes(name)) {
      throw new Error(
        `Refusing to run the e2e suite against ${name}. This suite creates ` +
          `real accounts and businesses and never removes them.`,
      )
    }
  }
  if (deployment && !deployment.startsWith('dev:')) {
    throw new Error(
      `Refusing to run the e2e suite against "${deployment}" — it is not a ` +
        `dev deployment. Point .env.local at the e2e deployment first.`,
    )
  }
  if (!CONVEX_URL) {
    throw new Error(
      'VITE_CONVEX_URL is not set — is the e2e deployment configured?',
    )
  }
}

assertSafeTarget()

export type Actor = {
  email: string
  /** Convex client authenticated as this actor — used for function-level checks. */
  client: ConvexHttpClient
}

/**
 * Convex authenticates with the JWT minted by the convex plugin, not the
 * Better Auth session token returned in the sign-up body. The session cookie
 * is what /convex/token trades for that JWT.
 */
async function convexJwtFor(cookie: string): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/convex/token`, {
    headers: { cookie, origin: SITE_URL },
  })
  if (!res.ok) {
    throw new Error(`convex/token failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new Error('convex/token returned no token')
  return body.token
}

export async function signUpActor(
  email: string,
  password: string,
  name: string,
): Promise<Actor> {
  const res = await fetch(`${AUTH_BASE}/sign-up/email`, {
    method: 'POST',
    // Better Auth rejects origin-less requests as CSRF; fetch sends no Origin
    // header of its own, so the fixture supplies the app's own origin.
    headers: { 'content-type': 'application/json', origin: SITE_URL },
    body: JSON.stringify({ email, password, name }),
  })
  if (!res.ok) {
    throw new Error(
      `sign-up failed for ${email}: ${res.status} ${await res.text()}`,
    )
  }

  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  if (!cookie) throw new Error(`sign-up set no session cookie for ${email}`)

  const client = new ConvexHttpClient(CONVEX_URL)
  client.setAuth(await convexJwtFor(cookie))

  return { email, client }
}

export function anonClient() {
  return new ConvexHttpClient(CONVEX_URL)
}

/**
 * The real way someone joins: the owner mints a single-use link, the invitee
 * redeems it. Nothing else creates a membership any more.
 *
 * Tests used to call `inviteByEmail` and then `claimInvitations`, which is the
 * flow that let whoever registered an invited address walk in — so exercising
 * it here would have been testing the hole rather than the product.
 */
export async function inviteAndJoin(
  owner: Actor,
  invitee: Actor,
  businessId: Id<'businesses'>,
  role: 'subcontractor' = 'subcontractor',
) {
  const { url } = await owner.client.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role,
  })
  const token = url.split('/join/')[1]
  if (!token) throw new Error(`invite url had no token: ${url}`)
  return invitee.client.action(api.invitations.redeem, { token })
}

/**
 * A business with an owner and an active subcontractor, one property, and one
 * job assigned to the owner — the shape every job-visibility row in §6.5 needs.
 */
export async function setupBusinessWithSub(label: string) {
  const owner = await signUpActor(
    uniqueEmail(`owner-${label}`),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const sub = await signUpActor(
    uniqueEmail(`sub-${label}`),
    FIXTURE_PASSWORD,
    'Kevin',
  )

  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    {
      name: `${label} ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    },
  )

  // Through the real link flow, so every spec that builds on this fixture is
  // standing on the path production actually uses.
  await inviteAndJoin(owner, sub, businessId)

  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })

  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id
  const subMembershipId = members.find((m) => m.email === sub.email)!._id

  // Both licensed, because both are in a pest business and a regulated report
  // cannot be signed without a licence on file — the rule `canFinaliseReport`
  // enforces. `scripts/seed.mjs` has always set these; the fixtures did not,
  // which made them a less realistic business than the seed.
  await owner.client.mutation(api.memberships.setLicence, {
    businessId,
    membershipId: ownerMembershipId,
    licenceNumber: 'PMT-4471',
  })
  await owner.client.mutation(api.memberships.setLicence, {
    businessId,
    membershipId: subMembershipId,
    licenceNumber: 'TECH-8821',
  })

  const ownerJobId = await owner.client.mutation(api.jobs.create, {
    businessId,
    propertyId,
    assignedMembershipId: ownerMembershipId,
    jobType: 'Termite Inspection',
    price: 38000,
    scheduledAt: Date.now(),
    durationMinutes: 90,
  })

  return {
    owner,
    sub,
    businessId,
    // Every URL in the app is slug-addressed, so a fixture that omits it makes
    // each caller re-derive it — or, quietly, navigate to /undefined.
    slug,
    propertyId,
    ownerMembershipId,
    subMembershipId,
    ownerJobId,
  }
}

/**
 * Signs in through the real form. The submit button is disabled until the page
 * hydrates, so waiting for it to enable is the readiness signal — clicking
 * earlier lands on markup React is still replacing and is silently swallowed.
 */
export async function signInViaUi(
  page: Page,
  email: string,
  password = FIXTURE_PASSWORD,
) {
  await page.goto('/login')
  const submit = page.getByRole('button', { name: 'Sign in' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await submit.click()

  // Returning before the redirect lands would let a caller's goto() race the
  // sign-in and bounce straight back to /login.
  await expect(page).not.toHaveURL(/\/login/)
}

/**
 * Clicks something and waits for what the click should cause, retrying the
 * CLICK rather than just the assertion.
 *
 * Under a full-suite run a click can land after the server-rendered markup is
 * on screen but before React has attached its handler, and that click is
 * swallowed with no error. Waiting longer on the assertion never recovers it —
 * the click has to happen again. This is the same hydration race the sign-in
 * helper avoids by waiting for the submit button to enable; elsewhere there is
 * no such readiness signal to wait on.
 */
export async function clickUntil(
  locator: Locator,
  settled: () => Promise<unknown>,
  timeout = 30_000,
) {
  await expect(async () => {
    await locator.click()
    await settled()
  }).toPass({ timeout })
}

export function uniqueEmail(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@pestm8.test`
}

/** Asserts a Convex call is rejected server-side, not merely hidden in the UI. */
export type RejectionCode =
  | 'NO_ACCESS'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'REPORT_FINALISED'
  | 'REPORT_NOT_FINALISED'
  | 'REPORT_INCOMPLETE'
  | 'EMAIL_NOT_CONFIGURED'
  | 'LAST_OWNER'
  | 'ALREADY_MEMBER'
  | 'TEMPLATE_IN_USE'
  | 'TEMPLATE_ARCHIVED'
  | 'INVALID_TEMPLATE'
  | 'TEMPLATE_RETIRED'
  | 'TEMPLATE_VERSION_MISMATCH'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_INVALID'
  | 'INVITE_EMAIL_MISMATCH'
  | 'OWNER_INVITE_FORBIDDEN'
  | 'APP_UPDATE_REQUIRED'
  // A permanent delete that skipped Recently Deleted — the 30-day safety net
  // is not optional.
  | 'NOT_IN_TRASH'
  // Too many sends from one person in an hour.
  | 'SEND_RATE_LIMITED'
  // A word the form itself matches on — renaming it would change behaviour,
  // not wording.
  | 'OPTION_PINNED'
  | 'OPTION_EXISTS'
  | 'INVALID_OPTION'
  | 'TOO_MANY_SNIPPETS'
  | 'INVALID_SNIPPET'
  // The business asks for a finalised report before a job is complete.
  | 'REPORT_REQUIRED'
  // Publishing a form when nothing has changed since it was last issued.
  | 'NOTHING_TO_PUBLISH'
  // Amending a report that has already been superseded would fork its number.
  | 'ALREADY_SUPERSEDED'
  // A second correction of a document while the first is still a draft.
  | 'AMENDMENT_IN_PROGRESS'
  | 'AMENDMENT_REASON_REQUIRED'
  // Applying someone else's saved signature.
  | 'NOT_YOUR_SIGNATURE'
  // A custom form's wording could not be frozen with the report it locks.
  | 'TEMPLATE_NOT_FROZEN'

export async function expectRejected(
  call: () => Promise<unknown>,
  expected: RejectionCode,
) {
  let threw = false
  try {
    await call()
  } catch (error) {
    threw = true
    const message = error instanceof Error ? error.message : String(error)
    // The Better Auth component rejects an anonymous caller inside getAuthUser
    // before requireMembership can throw its own code, so match case-insensitively
    // — the guarantee under test is the rejection, not the exact literal.
    if (!message.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(`expected ${expected}, got: ${message}`)
    }
  }
  if (!threw) throw new Error(`expected ${expected}, but the call succeeded`)
}

export { api }

/**
 * Gives an actor a licence number on their own membership.
 *
 * A regulated report cannot be signed without one — `canFinaliseReport`
 * refuses `HOLDER_LICENCE_MISSING` — and a pest business's people all have
 * one. Specs that create a business inline start with an owner who does not,
 * which is a realistic first minute of the product and an unrealistic state
 * to be finalising an AS 4349.3 inspection from.
 */
export async function licenceSelf(
  actor: Actor,
  businessId: Id<'businesses'>,
  licenceNumber = 'PMT-4471',
): Promise<void> {
  const members = await actor.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const mine = members.find((m) => m.email === actor.email)
  if (!mine) throw new Error(`${actor.email} is not a member of ${businessId}`)
  await actor.client.mutation(api.memberships.setLicence, {
    businessId,
    membershipId: mine._id,
    licenceNumber,
  })
}

/**
 * A finger held on `locator` for `ms`, then lifted — a real touch, sent
 * through the Chrome DevTools Protocol. The hold buttons (HoldButton) hold
 * only a touch or a pen: `page.mouse` would arrive as a mouse and act at once,
 * and Playwright's own touchscreen can only tap. Both projects are Chromium.
 */
export async function touchHold(page: Page, locator: Locator, ms: number) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('touchHold: the element is not on screen')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    })
    await page.waitForTimeout(ms)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
  } finally {
    await cdp.detach()
  }
}

/**
 * Stands in for `window.open` and records each call, with whether the
 * browser counted it as the user's own gesture at that moment. Playwright
 * runs Chromium with popups unblocked, so a blocked Map would pass here
 * unnoticed; `userActivation.isActive` is what a real phone decides by.
 * Read back with `openedTabs(page)`.
 */
export async function recordOpenedTabs(page: Page) {
  await page.addInitScript(() => {
    const record: Array<{ url: string; active: boolean | null }> = []
    Object.assign(window, { __openedTabs: record })
    window.open = (url?: string | URL) => {
      record.push({
        url: String(url),
        // The suite runs Chromium, which has userActivation.
        active: navigator.userActivation.isActive,
      })
      // A stand-in tab, so the card does not fall back to its link.
      return { opener: window } as unknown as Window
    }
  })
}

export function openedTabs(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __openedTabs?: Array<{ url: string; active: boolean | null }>
        }
      ).__openedTabs ?? [],
  )
}
