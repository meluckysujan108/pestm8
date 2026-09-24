import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub, signInViaUi } from './fixtures'
import { customTemplateArgs } from './fixtures/reportPayloads'

/**
 * The editor an owner builds their own form in.
 *
 * Two things make it usable rather than merely present: every field kind the
 * engine can render is offerable, and the form can be looked at before it is
 * issued. Authoring a compliance document blind is how a section ends up with
 * a heading and nothing under it.
 */

async function openEditor(
  page: Parameters<typeof signInViaUi>[0],
  label: string,
) {
  const s = await setupBusinessWithSub(label)
  const templateId = await s.owner.client.mutation(api.customTemplates.create, {
    businessId: s.businessId,
    ...customTemplateArgs({ name: 'Site Walkthrough' }),
  })
  await signInViaUi(page, s.owner.email)
  await page.goto(`/${s.slug}/reports/templates/${templateId}`)

  // The editor is server-rendered with its data, so "Add field" is on screen
  // before React has attached a handler to it, and a click that lands there is
  // swallowed with no error — the sheet just never opens. The Edit/Preview
  // switch is disabled until hydrated (src/lib/useHydrated.ts) and belongs to
  // the same component as the sections, so once it enables, every control in
  // the editor is live.
  await expect(page.getByRole('tab', { name: 'Edit' })).toBeEnabled()

  return { ...s, templateId }
}

test('every kind the engine can render can be added', async ({ page }) => {
  await openEditor(page, 'editor-kinds')

  await page.getByRole('button', { name: 'Add field' }).first().click()
  const sheet = page.getByRole('dialog')

  // The four that used to be withheld because the plumbing behind them was a
  // promise: a client record, the team roster, the front page, the delivery.
  for (const kind of [
    'Record detail',
    'Team member',
    'Front page photo',
    'Email recipients',
  ]) {
    await expect(sheet.getByRole('button', { name: kind })).toBeVisible()
  }
})

test('a record detail is configured by choosing which detail', async ({
  page,
}) => {
  const s = await openEditor(page, 'editor-derived')

  await page.getByRole('button', { name: 'Add field' }).first().click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Record detail' }).click()

  // It must be configurable, not merely addable — a field an owner can add
  // and cannot set up is worse than one that is not offered.
  await sheet.getByLabel('Which detail').selectOption('property.address')
  await sheet.getByRole('button', { name: /^(Add field|Save field)$/ }).click()

  // Saved to the draft, which is where an unissued edit belongs.
  await expect
    .poll(async () => {
      const t = await s.owner.client.query(api.customTemplates.get, {
        businessId: s.businessId,
        templateId: s.templateId,
      })
      const sections = (t!.draft?.sections ?? []) as Array<{
        fields: Array<{ kind: string; source?: string }>
      }>
      return sections.flatMap((x) => x.fields).find((f) => f.kind === 'derived')
        ?.source
    })
    .toBe('property.address')
})

test('the form can be read before it is issued', async ({ page }) => {
  await openEditor(page, 'editor-preview')

  await page.getByRole('tab', { name: 'Preview' }).click()

  // The questions in the order a technician meets them, built from the same
  // model the finished document is painted from.
  await expect(
    page.getByText(/questions as a technician will meet them/),
  ).toBeVisible()
  await expect(page.getByText('Areas inspected')).toBeVisible()

  await page.getByRole('tab', { name: 'Edit' }).click()
  await expect(
    page.getByRole('textbox', { name: 'Name', exact: true }),
  ).toBeVisible()
})

test('the editor says what is issued and what is not', async ({ page }) => {
  const s = await openEditor(page, 'editor-state')

  // Nothing unissued yet.
  await expect(
    page.getByText(/Issued\. Your team fills in version 1\./),
  ).toBeVisible()

  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Site Walkthrough (revised)')
  await expect(page.getByText(/Not yet issued/)).toBeVisible()

  await page.getByRole('button', { name: 'Issue to my team' }).click()
  await expect(
    page.getByText(/Issued\. Your team fills in version 2\./),
  ).toBeVisible()

  // And the published form moved, which is the only thing that matters.
  await expect
    .poll(async () => {
      const t = await s.owner.client.query(api.customTemplates.get, {
        businessId: s.businessId,
        templateId: s.templateId,
      })
      return t!.name
    })
    .toBe('Site Walkthrough (revised)')
})
