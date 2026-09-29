import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Page, TestInfo } from '@playwright/test'

/**
 * Putting PestM8 on a device (src/components/install/): Settings → Install
 * app for everyone, and — on a phone using PestM8 in its browser — a link on
 * the sign-in screen and a card on the schedule. Someone who deleted the Home
 * Screen app once could not find the way back; these hold every way there.
 *
 * Both projects run it. The desktop one is a computer, which gets the steps
 * in Settings and nothing else; the mobile one is Playwright's iPhone 13,
 * which reads as Safari on an iPhone.
 */

async function setup(label: string) {
  const owner = await signUpActor(
    uniqueEmail(label),
    FIXTURE_PASSWORD,
    'Terence',
  )
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  return { owner, slug }
}

const onPhone = (info: TestInfo) => info.project.name === 'mobile'

/** The dock on a phone, the sidebar on a desktop (navigation.spec.ts). */
const tab = (page: Page, name: string) =>
  page.getByRole('navigation').getByRole('link', { name, exact: true })

/** Somewhere else in the app and back to the schedule, without a page load. */
async function awayAndBack(page: Page) {
  await tab(page, 'Clients').click()
  await expect(
    page.getByRole('heading', { name: 'Clients', level: 1 }),
  ).toBeVisible()
  await tab(page, 'Schedule').click()
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
}

const CARD = 'Put PestM8 on your Home Screen'

test('Settings → Install app shows this device’s steps', async ({
  page,
}, info) => {
  const s = await setup('install-settings')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/settings`)

  await page.getByRole('link', { name: /Install app/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Install app', level: 1 }),
  ).toBeVisible()
  const steps = page.getByRole('listitem')
  if (onPhone(info)) {
    await expect(steps.filter({ hasText: 'Open as Web App' })).toBeVisible()
  } else {
    await expect(steps.filter({ hasText: 'address bar' })).toBeVisible()
  }
})

test('where Chrome offers to install, one tap does it', async ({
  page,
}, info) => {
  test.skip(onPhone(info), 'Chrome makes no offer on an iPhone')
  const s = await setup('install-prompt')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/settings/install`)
  // The steps are drawn once the page knows the device, after hydration.
  await expect(
    page.getByRole('listitem').filter({ hasText: 'address bar' }),
  ).toBeVisible()

  // Chrome's offer, as Chrome makes it: an event holding the prompt.
  await page.evaluate(() => {
    const offer = Object.assign(new Event('beforeinstallprompt'), {
      prompt: () => {
        ;(window as unknown as { prompted: boolean }).prompted = true
        return Promise.resolve()
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    })
    window.dispatchEvent(offer)
  })
  await page.getByRole('button', { name: 'Install PestM8' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { prompted?: boolean }).prompted,
      ),
    )
    .toBe(true)
  // Accepted, and the app is still arriving: not the steps again.
  await expect(page.getByText('Installing PestM8…')).toBeVisible()

  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(
    page.getByText('Installed. Open PestM8 from your apps.'),
  ).toBeVisible()
})

test('the sign-in screen offers the Home Screen on a phone, and only there', async ({
  page,
}, info) => {
  await page.goto('/login')
  // Hydrated: the link is decided then, so before this its absence proves
  // nothing.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  const link = page.getByRole('button', { name: CARD })

  if (!onPhone(info)) {
    await expect(link).toHaveCount(0)
    return
  }
  await link.click()
  const sheet = page.getByRole('dialog', { name: 'Install PestM8' })
  await expect(
    sheet.getByRole('listitem').filter({ hasText: 'Open as Web App' }),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()
  await expect(link).toBeFocused()
})

test('the schedule card: never on a page load, there on coming back, and put away with ✕', async ({
  page,
}, info) => {
  const s = await setup('install-card')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  const card = page.getByText(CARD, { exact: true })

  // A full page load: arriving during hydration, it would push the day
  // under a thumb, so it never does.
  await expect(card).toHaveCount(0)

  await awayAndBack(page)
  if (!onPhone(info)) {
    await expect(card).toHaveCount(0)
    return
  }
  await expect(card).toBeVisible()

  // Back puts the schedule's scroll where it was, so no card is slipped in
  // above it; tapping Schedule again is a new visit, and it asks.
  await tab(page, 'Clients').click()
  await expect(
    page.getByRole('heading', { name: 'Clients', level: 1 }),
  ).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await expect(card).toHaveCount(0)
  await awayAndBack(page)
  await expect(card).toBeVisible()

  // Its steps, in the same sheet as the sign-in screen's.
  await page.getByRole('button', { name: 'Show me how' }).click()
  const sheet = page.getByRole('dialog', { name: 'Install PestM8' })
  await expect(
    sheet.getByRole('listitem').filter({ hasText: 'Open as Web App' }),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()

  await page.getByRole('button', { name: `Dismiss: ${CARD}` }).click()
  await expect(card).toHaveCount(0)
  await awayAndBack(page)
  await expect(card).toHaveCount(0)

  // Thirty days on, it asks again.
  await page.evaluate(() =>
    localStorage.setItem(
      'pestm8-install-card-hidden-until',
      String(Date.now() - 1),
    ),
  )
  await awayAndBack(page)
  await expect(card).toBeVisible()
})

test('inside the installed app, it says so and offers nothing', async ({
  page,
}, info) => {
  test.skip(!onPhone(info), 'the Home Screen app is a phone’s')
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  )
  const s = await setup('install-standalone')

  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  await expect(page.getByRole('button', { name: CARD })).toHaveCount(0)

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('button', { name: 'New job' })).toBeEnabled()
  await awayAndBack(page)
  await expect(page.getByText(CARD, { exact: true })).toHaveCount(0)

  await page.goto(`/${s.slug}/settings`)
  await expect(page.getByRole('link', { name: /Install app/ })).toContainText(
    'Installed',
  )
})
