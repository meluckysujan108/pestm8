import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  clickUntil,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * The team relay: someone joins through a link, is welcomed (their licence,
 * the Home Screen, their jobs), and the owner hears about it on the schedule
 * with the one thing to do next — give them a job.
 */

test('a joiner is welcomed, and the owner hears and gives them a job', async ({
  page,
  browser,
}) => {
  const owner = await signUpActor(
    uniqueEmail('relay-owner'),
    FIXTURE_PASSWORD,
    'Jo',
  )
  const name = `Relay Pest ${Date.now()}`
  const { businessId, slug } = await owner.client.mutation(
    api.businesses.create,
    { name, state: 'WA', timezone: 'Australia/Perth' },
  )
  const email = uniqueEmail('relay-kevin')
  const { url } = await owner.client.action(api.invitations.create, {
    businessId,
    email,
    role: 'subcontractor',
  })

  // Kevin opens his link, signs up, and is welcomed.
  await page.goto(`/join/${url.split('/join/')[1]}`)
  const submit = page.getByRole('button', { name: 'Create account & join' })
  await expect(submit).toBeEnabled()
  await page.getByLabel('Your name').fill('Kevin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(FIXTURE_PASSWORD)
  await submit.click()

  await expect(
    page.getByRole('heading', { name: `Welcome to ${name}` }),
  ).toBeVisible()
  await expect(page.getByText('as a subcontractor')).toBeVisible()
  const continueButton = page.getByRole('button', { name: 'Continue' })
  await expect(continueButton).toBeEnabled()
  await page.getByLabel('Pest management technician licence').fill('PMT-7702')
  await continueButton.click()
  // No Home Screen to offer a desktop browser: straight to his jobs. (On an
  // iPhone the Share steps come first, with "Go to my jobs".)
  await expect(page).toHaveURL(new RegExp(`/${slug}/schedule`))

  const members = await owner.client.query(api.memberships.listForBusiness, {
    businessId,
  })
  const kevin = members.find((m) => m.email === email)!
  expect(kevin.licenceNumber).toBe('PMT-7702')

  // The owner, on their own phone, hears about it.
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await signInViaUi(ownerPage, owner.email)
  await expect(ownerPage).toHaveURL(new RegExp(`/${slug}/schedule`))
  await expect(ownerPage.getByText('Kevin joined the team')).toBeVisible()

  // …and gives him a job: New Job opens with Kevin already chosen.
  const notice = ownerPage.getByText('Kevin joined the team')
  await clickUntil(
    ownerPage.getByRole('button', { name: 'Give Kevin a job' }),
    () =>
      expect(ownerPage.getByRole('heading', { name: 'New job' })).toBeVisible({
        timeout: 3_000,
      }),
  )
  await expect(ownerPage.getByLabel('Assigned to')).toHaveValue(kevin._id)

  // Not booked after all: the notice is still there to come back to.
  await ownerPage.getByRole('button', { name: 'Close' }).click()
  await expect(ownerPage.getByRole('heading', { name: 'New job' })).toBeHidden()
  await expect(notice).toBeVisible()

  // Put away, it is gone — on every device, so after a reload too.
  await ownerPage.getByRole('button', { name: 'Dismiss: Kevin joined' }).click()
  await expect(notice).toHaveCount(0)
  await ownerPage.reload()
  await expect(
    ownerPage.getByRole('button', { name: /^Set-up guide|New job/ }).first(),
  ).toBeVisible()
  await expect(notice).toHaveCount(0)
  await ownerContext.close()
})

test('an owner can invite a contractor, and the link says so', async ({
  page,
}) => {
  const owner = await signUpActor(
    uniqueEmail('relay-cont'),
    FIXTURE_PASSWORD,
    'Jo',
  )
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Contractor Pest ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  await signInViaUi(page, owner.email)

  // Straight to the invite sheet, as the set-up guide's item opens it.
  await page.goto(`/${slug}/settings/team?invite=true`)
  const sheet = page.getByRole('dialog', { name: 'Invite someone' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('radio', { name: 'Contractor', exact: true }).click()
  await expect(sheet.getByText('Runs a team of their own')).toBeVisible()
  await sheet.getByLabel('Email address').fill(uniqueEmail('relay-dana'))
  await clickUntil(
    sheet.getByRole('button', { name: /^(Create link|Save anyway)$/ }),
    () => expect(sheet.getByText(/\/join\//)).toBeVisible({ timeout: 5_000 }),
  )
  const url = (await sheet.getByText(/\/join\//).innerText()).trim()

  // Whoever opens it is told what they are joining as.
  const invitee = await page.context().browser()!.newContext()
  const invitePage = await invitee.newPage()
  await invitePage.goto(`/join/${url.split('/join/')[1]}`)
  await expect(invitePage.getByText('invited as a contractor')).toBeVisible()
  await invitee.close()
})
