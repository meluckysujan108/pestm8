import { expect, test } from '@playwright/test'
import { api, expectRejected, setupBusinessWithSub, signInViaUi } from './fixtures'
import { builderReady, createReport, sectionUrl } from './fixtures/reportPayloads'

/**
 * Phrases: the sentences a business writes over and over.
 *
 * The three forms have fifty-one long-answer boxes between them, and the words
 * that go in are the same words visit after visit, typed with one thumb in
 * somebody's back garden. Saved once, they are one tap away for everyone.
 *
 * Deliberately not owner-gated, unlike the option libraries: a phrase is a
 * head start on an answer a technician could type anyway, not a controlled
 * vocabulary that prints as a chosen value.
 */

test('a technician saves what they wrote, and the next report offers it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('phrase-save')
  const reportId = await createReport(s.sub.client, s, 'serviceReport')

  await signInViaUi(page, s.sub.email)
  await page.goto(sectionUrl(s.slug, reportId, 'serviceReport', 'comments'))
  await builderReady(page)

  const box = page.getByRole('textbox', { name: "Technician's Comments" })
  await box.fill('Keep pets off the treated area for two hours.')

  // Nothing saved yet, so the button offers to keep what is written rather
  // than pretending there is a list.
  await page.getByRole('button', { name: 'Save as a phrase' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Save what’s written' }).click()
  await expect(
    sheet.getByRole('button', {
      name: 'Keep pets off the treated area for two hours.',
    }),
  ).toBeVisible()
  await sheet.getByRole('button', { name: 'Done' }).click()

  // The next report at the same business asks the same question, and the
  // answer is a tap.
  const second = await createReport(s.sub.client, s, 'serviceReport')
  await page.goto(sectionUrl(s.slug, second, 'serviceReport', 'comments'))
  await builderReady(page)
  await page.getByRole('button', { name: 'Phrases (1)' }).click()

  const again = page.getByRole('dialog')
  await again
    .getByRole('button', { name: 'Keep pets off the treated area for two hours.' })
    .click()
  await expect(
    page.getByRole('textbox', { name: "Technician's Comments" }),
  ).toHaveValue(
    'Keep pets off the treated area for two hours.',
  )
})

test('a phrase is added to the answer, never substituted for it', async ({ page }) => {
  const s = await setupBusinessWithSub('phrase-add')
  await s.owner.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'comments',
    text: 'Re-treat in 14 days if activity continues.',
  })

  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await signInViaUi(page, s.sub.email)
  await page.goto(sectionUrl(s.slug, reportId, 'serviceReport', 'comments'))
  await builderReady(page)

  const box = page.getByRole('textbox', { name: "Technician's Comments" })
  await box.fill('Wasp nest above the meter box.')
  await page.getByRole('button', { name: 'Phrases (1)' }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Re-treat in 14 days if activity continues.' })
    .click()

  // What happened today AND the standard wording — a technician wants both.
  await expect(box).toHaveValue(
    'Wasp nest above the meter box.\nRe-treat in 14 days if activity continues.',
  )
})

test('the owner writes the wording once and the whole team has it', async () => {
  const s = await setupBusinessWithSub('phrase-shared')
  await s.owner.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'limitations',
    text: 'No access to the subfloor — locked hatch.',
  })

  const theirs = await s.sub.client.query(api.snippets.list, {
    businessId: s.businessId,
  })
  expect(theirs.map((row) => row.text)).toContain(
    'No access to the subfloor — locked hatch.',
  )

  // And a technician may add one too: this is text they could type anyway.
  await s.sub.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'limitations',
    text: 'Roof void inspected from the access hatch only.',
  })
  expect(
    (await s.owner.client.query(api.snippets.list, { businessId: s.businessId })).length,
  ).toBe(2)
})

test('saving the same sentence twice keeps one of it', async () => {
  const s = await setupBusinessWithSub('phrase-dupe')
  const first = await s.sub.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'comments',
    text: 'Re-treat in 14 days.',
  })
  // Tapped again to be sure, and typed with a stray space and a capital.
  const again = await s.sub.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'comments',
    text: '  re-treat in 14 days. ',
  })
  expect(again).toBe(first)
  expect(
    (await s.sub.client.query(api.snippets.list, { businessId: s.businessId })).length,
  ).toBe(1)
})

test('a phrase belongs to its author and to the owner, and to nobody else', async () => {
  const s = await setupBusinessWithSub('phrase-remove')
  const ownersPhrase = await s.owner.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'comments',
    text: 'Standard wording the business issues.',
  })
  const subsPhrase = await s.sub.client.mutation(api.snippets.save, {
    businessId: s.businessId,
    fieldKey: 'comments',
    text: "Something this technician wrote.",
  })

  // A technician cannot drop the wording their business issues.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.snippets.remove, {
        businessId: s.businessId,
        snippetId: ownersPhrase,
      }),
    'NO_ACCESS',
  )
  // Their own, they can.
  await s.sub.client.mutation(api.snippets.remove, {
    businessId: s.businessId,
    snippetId: subsPhrase,
  })
  // And the owner is answerable for what the reports say, so anything.
  await s.owner.client.mutation(api.snippets.remove, {
    businessId: s.businessId,
    snippetId: ownersPhrase,
  })
  expect(
    (await s.owner.client.query(api.snippets.list, { businessId: s.businessId })).length,
  ).toBe(0)
})

test('a question holds as many phrases as anyone reads, and no more', async () => {
  const s = await setupBusinessWithSub('phrase-cap')
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      s.owner.client.mutation(api.snippets.save, {
        businessId: s.businessId,
        fieldKey: 'comments',
        text: `Standard paragraph number ${i + 1}.`,
      }),
    ),
  )

  await expectRejected(
    () =>
      s.owner.client.mutation(api.snippets.save, {
        businessId: s.businessId,
        fieldKey: 'comments',
        text: 'One more for luck.',
      }),
    'TOO_MANY_SNIPPETS',
  )
})
