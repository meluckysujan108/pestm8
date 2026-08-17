import { ConvexHttpClient } from 'convex/browser'
import { createAuthClient } from 'better-auth/react'
import { api } from '../convex/_generated/api'

/**
 * Fixture contract for the access-control matrix (ARCHITECTURE.md §6.5).
 *
 * Every negative case is asserted twice: once through the UI, and once by
 * calling the Convex function directly with that actor's token. The direct
 * call is the assertion that matters — a hidden button is not access control.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL!
const SITE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export type Actor = {
  email: string
  password: string
  token: string
  /** Convex client authenticated as this actor — used for function-level checks. */
  client: ConvexHttpClient
}

export async function signUpActor(
  email: string,
  password: string,
  name: string,
): Promise<Actor> {
  const authClient = createAuthClient({ baseURL: SITE_URL })

  await authClient.signUp.email({ email, password, name })
  const session = await authClient.signIn.email({ email, password })

  const token = session.data?.token
  if (!token) throw new Error(`could not authenticate fixture actor ${email}`)

  const client = new ConvexHttpClient(CONVEX_URL)
  client.setAuth(token)

  return { email, password, token, client }
}

export function uniqueEmail(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@pestm8.test`
}

/** Asserts a Convex call is rejected server-side, not merely hidden in the UI. */
export async function expectRejected(
  call: () => Promise<unknown>,
  expected: 'NO_ACCESS' | 'UNAUTHENTICATED' | 'NOT_FOUND',
) {
  let threw = false
  try {
    await call()
  } catch (error) {
    threw = true
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(expected)) {
      throw new Error(`expected ${expected}, got: ${message}`)
    }
  }
  if (!threw) throw new Error(`expected ${expected}, but the call succeeded`)
}

export { api }
