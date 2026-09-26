import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Setting up a business, the way a new owner does it on a phone: four short
 * steps with the report's header filling in above them, then the first job.
 *
 * The e2e deployment is not invitation-only, so any account with no business
 * is offered set-up — the start-a-business link and the invitation-only gate
 * are covered where they are enforced, in convex/businessInvites.test.ts.
 *
 * The part most worth guarding is the resume: an iPhone Home Screen app that
 * reloads (after the trip to Photos for a logo, say) opens at `/`, and `/`
 * must bring the owner back to the step they were on, not drop them on an
 * empty schedule with half a letterhead.
 */

/** "Continue", or "Save anyway" once the field checks have had their say —
 * the fixture addresses are on a domain that takes no mail. */
const continueButton = (page: Page) =>
  page.getByRole('button', { name: /^(Continue|Save anyway)$/ })

/** A step whose fields can be typed in: the fields are controlled, so text
 * typed into the server's markup is wiped by hydration. Continue is enabled
 * once it is done — the readiness signal, as the sign-in helper uses. */
async function stepReady(page: Page) {
  await expect(continueButton(page)).toBeEnabled()
}

async function continueStep(page: Page, next: RegExp) {
  await clickUntil(continueButton(page), () =>
    expect(page).toHaveURL(next, { timeout: 3_000 }),
  )
}

test('a new owner sets up their business, and a reload resumes it', async ({
  page,
}) => {
  const owner = await signUpActor(uniqueEmail('setup'), FIXTURE_PASSWORD, 'Jo')
  await signInViaUi(page, owner.email)

  // No business yet: straight to set-up, step 1.
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(
    page.getByRole('heading', { name: 'What’s your business called?' }),
  ).toBeVisible()

  await stepReady(page)
  const name = `Swan River Pest ${Date.now()}`
  const preview = page.getByRole('figure', {
    name: 'How the top of your reports will look',
  })
  await page.getByLabel('Business name').fill(name)
  // The preview is the report's own header, filling in as it is typed.
  await expect(preview).toContainText(name)
  await page.getByRole('radio', { name: 'New South Wales' }).click()
  await expect(
    page.getByRole('radio', { name: 'New South Wales' }),
  ).toHaveAttribute('aria-checked', 'true')

  await continueStep(page, /step=brand/)
  const slug = new URL(page.url()).searchParams.get('business')!
  expect(slug).toBeTruthy()

  // Step 2, then a reload of the kind an iPhone does: back to `/`.
  await expect(
    page.getByRole('heading', { name: 'Make your reports yours' }),
  ).toBeVisible()
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`business=${slug}.*step=brand`))
  await stepReady(page)

  // The email starts as the account's own — after a full reload too.
  await expect(page.getByLabel('Email')).toHaveValue(owner.email)
  await page.getByLabel('Phone').fill('0412 345 678')
  await expect(preview).toContainText('0412 345 678')
  await continueStep(page, /step=licence/)

  // Step 3: the owner's own licence number, on their membership.
  await stepReady(page)
  await page.getByLabel('Pest management technician licence').fill('PMT 004512')
  await expect(preview).toContainText('PMT 004512')
  await continueStep(page, /step=team/)

  const business = await owner.client.query(api.businesses.getBySlug, {
    slug,
  })
  expect(business?.state).toBe('NSW')
  expect(business?.phone).toBeTruthy()
  expect(business?.membership.licenceNumber).toBe('PMT 004512')

  // Step 4: nobody else yet.
  await page.getByRole('radio', { name: /Just me/ }).click()
  await continueStep(page, /step=ready/)
  await expect(
    page.getByRole('heading', { name: `${name} is ready` }),
  ).toBeVisible()

  // Finished: `/` is the schedule from now on. Written as the finish shows,
  // without holding it up, so it lands a moment later.
  await expect
    .poll(
      async () =>
        (await owner.client.query(api.businesses.listForUser, {})).find(
          (row) => row.slug === slug,
        )?.setupStep,
    )
    .toBeNull()

  // The first job, straight from the finish.
  await page.getByRole('button', { name: 'Book your first job' }).click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule$`))
  await expect(page.getByRole('heading', { name: 'New job' })).toBeVisible()

  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule`))
})

test('every step after the name can be left for later', async ({ page }) => {
  const owner = await signUpActor(uniqueEmail('later'), FIXTURE_PASSWORD, 'Kim')
  await signInViaUi(page, owner.email)
  await expect(page).toHaveURL(/\/onboarding$/)

  await stepReady(page)
  await page.getByLabel('Business name').fill(`Later Pest ${Date.now()}`)
  await continueStep(page, /step=brand/)

  await clickUntil(page.getByRole('button', { name: 'Add later' }), () =>
    expect(page).toHaveURL(/step=licence/, { timeout: 3_000 }),
  )
  await clickUntil(page.getByRole('button', { name: 'Add later' }), () =>
    expect(page).toHaveURL(/step=team/, { timeout: 3_000 }),
  )
  await clickUntil(page.getByRole('button', { name: 'Skip' }), () =>
    expect(page).toHaveURL(/step=ready/, { timeout: 3_000 }),
  )

  // Nothing was asked of the letterhead, and set-up is still over.
  await expect(
    page.getByRole('button', { name: 'Go to the schedule' }),
  ).toBeVisible()
  await expect
    .poll(
      async () =>
        (await owner.client.query(api.businesses.listForUser, {}))[0]
          ?.setupStep,
    )
    .toBeNull()
})

test('finishing later leaves set-up for good', async ({ page }) => {
  const owner = await signUpActor(uniqueEmail('exit'), FIXTURE_PASSWORD, 'Lee')
  await signInViaUi(page, owner.email)
  await expect(page).toHaveURL(/\/onboarding$/)

  await stepReady(page)
  await page.getByLabel('Business name').fill(`Exit Pest ${Date.now()}`)
  await continueStep(page, /step=brand/)
  const slug = new URL(page.url()).searchParams.get('business')!

  await clickUntil(
    page.getByRole('button', { name: 'Finish setting up later' }),
    () =>
      expect(page).toHaveURL(new RegExp(`/${slug}/schedule`), {
        timeout: 3_000,
      }),
  )
  // Not sent back into set-up at the next launch.
  await expect
    .poll(
      async () =>
        (await owner.client.query(api.businesses.listForUser, {}))[0]
          ?.setupStep,
    )
    .toBeNull()
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule`))
})
