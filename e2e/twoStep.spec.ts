import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import { secretOf, totp } from '../test/authBrowser'
import type { Page } from '@playwright/test'

/**
 * Two-step sign-in, set up and used the way a technician does it on a phone.
 *
 * The production bug this guards: every code at set-up was "did not match".
 * Each Start on /two-step made a new key, and an iPhone home-screen app
 * reloads when it comes back from the authenticator it just handed the key
 * to — so the person pressed Start again and was left holding an entry for a
 * key that no longer existed. The set-up screen now carries on with the key
 * this session made (src/routes/two-step.tsx), and only makes a new one when
 * asked to, with the warning to delete the old entry first.
 *
 * Codes come from `totp` in test/authBrowser.ts — the same RFC 6238 helper
 * the convex-test flow tests check against the real endpoints — reading the
 * key off the page, as an authenticator app would.
 */

/** A TOTP step. The server accepts the step either side of now as well. */
const STEP_MS = 30_000

/** Someone who has signed up with the fixture password and owns a business,
 * so finishing set-up lands on a real page of the app, not onboarding. */
async function ownerWithBusiness(label: string) {
  const owner = await signUpActor(uniqueEmail(label), FIXTURE_PASSWORD, 'Sujan')
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  return { email: owner.email, slug }
}

/**
 * The code an authenticator app shows for `uri` right now. Computed just
 * before it is typed, and never in the last `margin` of its step: a code
 * that turns over between here and the server is the next step's problem,
 * so wait for that step to begin instead.
 */
async function codeNow(uri: string, margin = 3_000): Promise<string> {
  const left = STEP_MS - (Date.now() % STEP_MS)
  if (left < margin) await new Promise((r) => setTimeout(r, left + 250))
  return totp(uri)
}

/** The right code with one digit slipped — and never one the server would
 * accept anyway, from the steps either side. */
async function slippedCode(uri: string): Promise<string> {
  const now = Date.now()
  const near = new Set(
    await Promise.all(
      [-2, -1, 0, 1, 2].map((k) => totp(uri, now + k * STEP_MS)),
    ),
  )
  let code = await totp(uri, now)
  while (near.has(code)) {
    const last = (Number(code[5]) + 1) % 10
    code = `${code.slice(0, 5)}${last}`
  }
  return code
}

/**
 * The password step, and its button — "Start", "Continue setting up" or
 * "Start again with a new key", which is the assertion that the page chose
 * the right thing to do with the password. Disabled until the page has
 * hydrated and the live status has said how far set-up has got.
 */
async function confirmPassword(page: Page, button: string) {
  const submit = page.getByRole('button', { name: button, exact: true })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Your password').fill(FIXTURE_PASSWORD)
  await submit.click()
}

/**
 * The key on the scan step, as the otpauth:// URI "Add to authenticator app"
 * hands over — and the setup key typed by hand must be the same secret, or
 * the two ways of adding it would disagree.
 */
async function shownKey(page: Page): Promise<string> {
  const link = page.getByRole('link', { name: 'Add to authenticator app' })
  await expect(link).toBeVisible()
  const uri = await link.getAttribute('href')
  if (uri === null) throw new Error('"Add to authenticator app" has no link')
  expect(uri).toMatch(/^otpauth:\/\/totp\//)
  // Filed under PestM8 in the authenticator, however the key was fetched.
  expect(new URL(uri).searchParams.get('issuer')).toBe('PestM8')
  const typed = await page.getByRole('code').textContent()
  expect(typed?.replace(/\s/g, '')).toBe(secretOf(uri))
  return uri
}

/**
 * Typed into the scan step, which checks it at the sixth digit — the moment
 * the key shows, with no pause for a human to find their phone, and that is
 * deliberate. The page's own reads (the Convex token it fetches again after
 * each auth call) are then still going out on the cookie the code replaces,
 * and a late "signed out" from one of them used to clear the new session's
 * cookie, so finishing landed on the sign-in screen (`passesOn` in
 * src/lib/authCookies.ts). iOS AutoFill of a verification code is as quick.
 */
async function enterSetupCode(page: Page, code: string) {
  await page.getByLabel('Enter the 6-digit code it shows').fill(code)
}

/**
 * The recovery codes after a right code, saved, and on into the app. Made
 * after the code (never enable's), so these are the ones stored.
 */
async function saveRecoveryCodes(
  page: Page,
  slug: string,
): Promise<Array<string>> {
  await expect(
    page.getByRole('heading', { name: 'Save your recovery codes' }),
  ).toBeVisible()
  const items = page.getByRole('listitem')
  await expect(items).toHaveCount(10)
  const codes = (await items.allTextContents()).map((c) => c.trim())
  for (const code of codes) {
    // The server's alphabet (convex/auth.ts): no 0/o, 1/l/i.
    expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/)
  }
  expect(new Set(codes).size).toBe(10)

  const done = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(done).toBeDisabled()
  await page
    .getByLabel("I've saved these somewhere other than this phone")
    .check()
  await done.click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule$`))
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  return codes
}

/** Set-up from Start to the app, with nothing in the way. */
async function turnOnThroughScreen(page: Page, email: string, slug: string) {
  await signInViaUi(page, email)
  await page.goto('/two-step')
  await confirmPassword(page, 'Start')
  const uri = await shownKey(page)
  await enterSetupCode(page, await codeNow(uri))
  const codes = await saveRecoveryCodes(page, slug)
  return { uri, codes }
}

/** Settings → Sign out, which reloads to the sign-in screen. The button is
 * not held back until hydration, so the click is retried until it lands. */
async function signOut(page: Page, slug: string) {
  await page.goto(`/${slug}/settings`)
  await clickUntil(page.getByRole('button', { name: 'Sign out' }), () =>
    expect(page).toHaveURL(/\/login/, { timeout: 5_000 }),
  )
}

/** Email and the right password, which on an account with two-step sign-in
 * on brings the code step in place of the form — and signs nobody in yet. */
async function passwordThenCodeStep(page: Page, email: string) {
  await page.goto('/login')
  const submit = page.getByRole('button', { name: 'Sign in' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(FIXTURE_PASSWORD)
  await submit.click()
  await expect(
    page.getByRole('heading', { name: 'Two-step sign-in' }),
  ).toBeVisible()
  await expect(
    page.getByText(
      'Open your authenticator app and enter the 6-digit code for PestM8.',
    ),
  ).toBeVisible()
  expect(await signedInAs(page)).toBeNull()
}

/** Whose session this browser holds, asked of the auth server itself rather
 * than read off the screen: a code step that looked refused but had signed
 * someone in would pass any check of the page alone. */
async function signedInAs(page: Page): Promise<string | null> {
  const res = await page.request.get('/api/auth/get-session')
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { user?: { email?: string } } | null
  return body?.user?.email ?? null
}

test('the key survives the reload an iPhone does after the authenticator hand-off', async ({
  page,
}) => {
  const { email, slug } = await ownerWithBusiness('two-step-reload')
  await signInViaUi(page, email)
  await page.goto('/two-step')
  await confirmPassword(page, 'Start')
  const first = await shownKey(page)

  // Back from the authenticator app: iOS reloads the home-screen app it had
  // put away, and the page starts again from the password step.
  await page.reload()

  // It offers to carry on, never to start: a Start here was the bug.
  const carryOn = page.getByRole('button', {
    name: 'Continue setting up',
    exact: true,
  })
  await expect(carryOn).toBeEnabled()
  await expect(
    page.getByText(
      'You started setting this up before. Enter your password to carry on with the same key.',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Start', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Start again with a new key' }),
  ).toHaveCount(0)

  await confirmPassword(page, 'Continue setting up')
  await expect(
    page.getByText('This is the same key as before.', { exact: false }),
  ).toBeVisible()
  const again = await shownKey(page)
  // The same key — the whole URI, so an entry added from either showing is
  // one entry, filed under the same name.
  expect(secretOf(again)).toBe(secretOf(first))
  expect(again).toBe(first)

  // What the entry added before the reload shows now is accepted.
  await enterSetupCode(page, await codeNow(first))
  await saveRecoveryCodes(page, slug)
})

test('signing in again asks for the code: a slipped digit is refused, the code showing now signs in', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const { email, slug } = await ownerWithBusiness('two-step-sign-in')
  const { uri } = await turnOnThroughScreen(page, email, slug)
  await signOut(page, slug)

  await passwordThenCodeStep(page, email)
  const code = page.getByLabel('Code', { exact: true })
  await code.fill(await slippedCode(uri))
  await expect(page.getByRole('alert')).toHaveText(
    'That code did not match. Codes change every 30 seconds — use the one showing now.',
  )
  await expect(page).toHaveURL(/\/login$/)
  await expect(
    page.getByRole('heading', { name: 'Two-step sign-in' }),
  ).toBeVisible()
  expect(await signedInAs(page)).toBeNull()

  // Cleared for the next try, which is checked at the sixth digit too.
  await expect(code).toHaveValue('')
  await code.fill(await codeNow(uri))
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule$`))
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
  expect(await signedInAs(page)).toBe(email)
})

test('a double tap on Start makes one key, and that key works', async ({
  page,
}, testInfo) => {
  const { email, slug } = await ownerWithBusiness('two-step-double')
  await signInViaUi(page, email)

  const enables: Array<string> = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/auth/two-factor/enable'
    ) {
      enables.push(request.url())
    }
  })

  await page.goto('/two-step')
  const start = page.getByRole('button', { name: 'Start', exact: true })
  await expect(start).toBeEnabled()
  await page.getByLabel('Your password').fill(FIXTURE_PASSWORD)

  // Two taps as a thumb makes them: the second follows the first at once,
  // without waiting to see what the first did.
  if (testInfo.project.name === 'mobile') {
    const box = await start.boundingBox()
    if (!box) throw new Error('Start is not on screen')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)
  } else {
    await start.dblclick()
  }

  const uri = await shownKey(page)
  expect(enables).toHaveLength(1)
  // And no second Start refused by the server behind the key, either.
  await expect(page.getByRole('alert')).toHaveCount(0)

  // The key on screen is the account's key: its code turns two-step on.
  await enterSetupCode(page, await codeNow(uri))
  await saveRecoveryCodes(page, slug)
  expect(enables).toHaveLength(1)
})

test('"Start over with a new key" warns how to delete the old entry, and only the new key works after', async ({
  page,
}) => {
  const { email, slug } = await ownerWithBusiness('two-step-new-key')
  await signInViaUi(page, email)
  await page.goto('/two-step')
  await confirmPassword(page, 'Start')
  const old = await shownKey(page)

  await page.reload()
  await confirmPassword(page, 'Continue setting up')
  expect(await shownKey(page)).toBe(old)

  // Asked first, with the warning in amber and where the old entry lives.
  await page.getByRole('button', { name: 'Start over with a new key' }).click()
  const warning = page.getByText(
    'A new key stops the one you have now from working. Delete every PestM8 entry in your authenticator app first, then add the new one.',
    { exact: false },
  )
  await expect(warning).toBeVisible()
  await expect(warning).toHaveClass(/\bbg-amber-bg\b/)
  // Named by the login the phone's Passwords app lists — this site's host.
  const host = new URL(page.url()).hostname
  await expect(warning).toContainText(
    `On an iPhone: Passwords app → the ${host} login → Edit → Delete Verification Code. In Google or Microsoft Authenticator: delete the PestM8 entry.`,
  )
  await expect(
    page.getByRole('button', { name: 'Keep this key' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Make a new key' }).click()

  // A new key, said so in amber at the top of the step.
  const notice = page.getByText(
    'This is a new key. Delete every PestM8 entry already in your authenticator app first — only the one you add now will work.',
    { exact: false },
  )
  await expect(notice).toBeVisible()
  await expect(notice).toHaveClass(/\bbg-amber-bg\b/)
  await expect(notice).toContainText(
    `On an iPhone: Passwords app → the ${host} login → Edit → Delete Verification Code.`,
  )
  const fresh = await shownKey(page)
  expect(secretOf(fresh)).not.toBe(secretOf(old))

  // The entry from the old key is dead…
  await enterSetupCode(page, await codeNow(old))
  await expect(page.getByRole('alert')).toContainText(
    'That code did not match.',
  )
  const field = page.getByLabel('Enter the 6-digit code it shows')
  await expect(field).toHaveValue('')

  // …and the one from the new key turns two-step sign-in on.
  await enterSetupCode(page, await codeNow(fresh))
  await saveRecoveryCodes(page, slug)
})

test('set-up started on another device starts again here with a new key, and never shows the first', async ({
  page,
  browser,
  baseURL,
}) => {
  const { email, slug } = await ownerWithBusiness('two-step-elsewhere')
  await signInViaUi(page, email)
  await page.goto('/two-step')
  await confirmPassword(page, 'Start')
  const first = await shownKey(page)

  // A desk browser, signed in separately: another session, which the first
  // key was never shown to and is not given now.
  const desk = await browser.newContext({ baseURL, colorScheme: 'light' })
  try {
    const other = await desk.newPage()
    await signInViaUi(other, email)
    await other.goto('/two-step')
    await expect(
      other.getByText(
        'Setting this up was started somewhere this page cannot carry on from',
        { exact: false },
      ),
    ).toBeVisible()
    await expect(
      other.getByRole('button', { name: 'Continue setting up' }),
    ).toHaveCount(0)
    await confirmPassword(other, 'Start again with a new key')

    await expect(
      other.getByText('This is a new key.', { exact: false }),
    ).toHaveClass(/\bbg-amber-bg\b/)
    const fresh = await shownKey(other)
    expect(secretOf(fresh)).not.toBe(secretOf(first))

    await enterSetupCode(other, await codeNow(first))
    await expect(other.getByRole('alert')).toContainText(
      'That code did not match.',
    )
    await enterSetupCode(other, await codeNow(fresh))
    await saveRecoveryCodes(other, slug)
  } finally {
    await desk.close()
  }
})

test('a recovery code signs in once, and only once', async ({ page }) => {
  test.setTimeout(120_000)
  const { email, slug } = await ownerWithBusiness('two-step-recovery')
  const { codes } = await turnOnThroughScreen(page, email, slug)
  await signOut(page, slug)

  const useRecovery = async () => {
    await passwordThenCodeStep(page, email)
    await page
      .getByRole('button', { name: 'Use a recovery code instead' })
      .click()
    await page.getByLabel('Recovery code').fill(codes[0])
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }

  await useRecovery()
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule$`))
  expect(await signedInAs(page)).toBe(email)
  await signOut(page, slug)

  await useRecovery()
  await expect(page.getByRole('alert')).toHaveText(
    'That recovery code did not match, or it has already been used. Each one works once.',
  )
  await expect(page).toHaveURL(/\/login$/)
  expect(await signedInAs(page)).toBeNull()
})
