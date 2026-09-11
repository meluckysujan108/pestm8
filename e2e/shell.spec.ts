import { expect, test } from '@playwright/test'
import { FIXTURE_PASSWORD, api, signInViaUi, signUpActor, uniqueEmail } from './fixtures'

/**
 * The shell's structural contract, which is load-bearing for every other spec
 * that navigates: two `nav` landmarks, always in the DOM, sidebar first, with
 * the reflow done in CSS rather than by mounting one and unmounting the other.
 *
 * The sidebar collapses to icons, and that is the case worth guarding: when a
 * label is hidden rather than clipped, the link keeps working with a mouse and
 * silently loses its accessible name — so it stops existing for a keyboard, a
 * screen reader, and every `getByRole('link', { name })` in this suite.
 */

async function setup(label: string) {
  const owner = await signUpActor(uniqueEmail(label), FIXTURE_PASSWORD, 'Terence')
  const { slug } = await owner.client.mutation(api.businesses.create, {
    name: `${label} ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  return { owner, slug }
}

test('both navigation landmarks exist at every width, sidebar first', async ({ page }) => {
  const s = await setup('shell-navs')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  // Both navs are in the DOM at every width, but the hidden one is
  // `display:none` and so absent from the accessibility tree. That is the
  // property the suite actually leans on: `getByRole('navigation')` resolves
  // to exactly one nav — the one for this width — which is why addressing it
  // as .first() or .last() works at all.
  for (const [size, label] of [
    [{ width: 390, height: 844 }, 'Tabs'],
    [{ width: 768, height: 1024 }, 'Tabs'],
    [{ width: 1280, height: 900 }, 'Primary'],
  ] as const) {
    await page.setViewportSize(size)
    const navs = page.getByRole('navigation')
    await expect(navs).toHaveCount(1)
    await expect(navs.first()).toHaveAttribute('aria-label', label)
  }

  // Both are nonetheless present in the markup — the reflow is CSS, not a
  // mount/unmount, so neither nav can drift out of sync with the other.
  await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(1)
  await expect(page.locator('nav[aria-label="Tabs"]')).toHaveCount(1)
})

test('collapsing the sidebar to icons keeps every link findable by name', async ({ page }) => {
  const s = await setup('shell-collapse')
  await signInViaUi(page, s.owner.email)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/${s.slug}/schedule`)

  const sidebar = page.getByRole('navigation').first()
  await expect(sidebar.getByRole('link', { name: 'Settings' })).toBeVisible()

  const panel = page.locator('[data-slot="sidebar-inner"]')
  const widthOf = async () => (await panel.boundingBox())?.width ?? 0
  // The panel is `fixed` and width-transitioned, so it can still measure 0 on
  // the frame the link first reports visible.
  await expect.poll(widthOf).toBeGreaterThan(0)
  const expandedWidth = await widthOf()

  await page.getByRole('button', { name: 'Toggle sidebar' }).first().click()

  // It really collapsed — otherwise the assertions below prove nothing. Both
  // the state attribute (the mechanism) and the width (the result), because
  // the attribute flipping without the width following would be the bug.
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
    'data-state',
    'collapsed',
  )
  await expect.poll(widthOf).toBeLessThan(expandedWidth)

  for (const name of ['Schedule', 'Clients', 'Reports', 'Notes', 'Analytics', 'Settings']) {
    await expect(sidebar.getByRole('link', { name })).toBeVisible()
  }

  // And it still navigates while collapsed.
  await sidebar.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(new RegExp(`/${s.slug}/settings$`))
})

test('the mobile dock gives every destination an equal, thumb-sized target', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone layout only')

  const s = await setup('shell-dock')
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  const dock = page.getByRole('navigation').last()
  const links = dock.getByRole('link')
  await expect(links).toHaveCount(6)

  const boxes = await links.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()),
  )
  const widths = boxes.map((b) => Math.round(b.width))
  // An even grid, not flex-1 on labels of different lengths: uneven targets on
  // a phone are how "Analytics" ends up twice the tap area of "Notes".
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
  // Apple's minimum touch target. Below this the dock is decorative.
  for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44)

  await testInfo.attach('mobile-dock.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})
