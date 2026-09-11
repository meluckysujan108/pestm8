import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'

/**
 * Guards a failure that produced no error and no test failure: `text-secondary`
 * resolved against Tailwind's *colour* namespace rather than font-size, because
 * shadcn's contract defines --color-secondary. Every caption in the app was
 * painted #F2F2F7 on a near-white canvas — invisible, silently.
 *
 * Font-size tokens must not share a name with a colour token. This asserts the
 * rendered result rather than the CSS, so any future collision surfaces here.
 */
test('caption text renders muted and small, not as a background colour', async ({
  page,
}) => {
  const email = uniqueEmail('tokens')
  const owner = await signUpActor(email, FIXTURE_PASSWORD, 'Terence')
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `Tokens ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })

  await signInViaUi(page, email)
  await page.goto(`/${slug}/settings?seg=prefs`)

  // Rendered straight from route context (no query, no lazy chunk), so it's
  // present on first paint — unlike a loading skeleton, which can finish and
  // unmount between the visibility check and the computed-style read below.
  const caption = page.getByText(/State determines your timezone/)
  await expect(caption).toBeVisible()

  const { color, fontSize } = await caption.evaluate((node) => {
    const cs = getComputedStyle(node as Element)
    return { color: cs.color, fontSize: cs.fontSize }
  })

  expect(fontSize).toBe('13px')

  const [r, g, b] = color.match(/\d+/g)!.map(Number)
  // Anything this pale is a surface colour that has leaked into a text
  // utility; real body text on this palette sits around #8E8E93.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  expect(luminance).toBeLessThan(0.75)
})
