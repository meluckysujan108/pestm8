import { expect } from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'
import type { Page } from '@playwright/test'

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

  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  const subUser = await sub.client.query(api.auth.getCurrentUser, {})
  const subMembershipId = await owner.client.mutation(api.memberships.invite, {
    businessId,
    userId: subUser!._id,
    role: 'subcontractor',
  })
  // invite() leaves the member "invited"; they activate themselves.
  await sub.client.mutation(api.memberships.accept, { businessId })

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
  | 'EMAIL_NOT_CONFIGURED'
  | 'LAST_OWNER'
  | 'ALREADY_MEMBER'
  | 'TEMPLATE_IN_USE'
  | 'TEMPLATE_ARCHIVED'
  | 'INVALID_TEMPLATE'

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
