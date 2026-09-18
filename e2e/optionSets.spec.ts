import { expect, test } from '@playwright/test'
import {
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import {
  builderReady,
  createReport,
  customTemplateArgs,
  saveReportDraft,
  sectionUrl,
} from './fixtures/reportPayloads'

/**
 * The lists a business owns.
 *
 * A pest business's product shelf is not ours to write. The forms ship with
 * the thirteen products Pest M8 was using when they were transcribed, and the
 * day the owner switches suppliers that list is wrong on every report their
 * technicians sign — with no developer in the loop and no way to wait for one.
 *
 * So: an owner edits the vocabulary in Settings, a technician never can, and
 * the reports already finalised keep the words they were signed with. What
 * follows is that contract, end to end.
 */

async function productsFor(
  client: Parameters<typeof createReport>[0],
  businessId: string,
) {
  const lists = await client.query(api.optionSets.editable, {
    businessId: businessId as never,
  })
  return lists.find((list) => list.key === 'products')!
}

test('a product an owner adds in Settings is on the next report', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('optionset-add')
  await signInViaUi(page, s.owner.email)

  await page.goto(`/${s.slug}/settings?seg=reports`)
  await page.getByRole('button', { name: 'Products' }).click()

  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Reports already finalised')).toBeVisible()
  await sheet
    .getByLabel('Add to Products')
    .fill('Termidor HE (100 g/L Fipronil)')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    sheet.getByRole('button', {
      name: 'Termidor HE (100 g/L Fipronil)',
      exact: true,
    }),
  ).toBeVisible()

  // The thing that actually matters: a report started afterwards offers it.
  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  const report = await s.sub.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  const products = report!.optionSets?.products ?? []
  expect(products.map((option) => option.value)).toContain(
    'Termidor HE (100 g/L Fipronil)',
  )
  // Added, not replacing: the form's own list is still underneath it.
  expect(products.length).toBeGreaterThan(1)
})

test('renaming a product rewrites the drafts that already chose it', async () => {
  const s = await setupBusinessWithSub('optionset-rename')
  const before = await productsFor(s.owner.client, s.businessId)
  const original = before.options.find(
    (o) => !before.pinned.includes(o.value),
  )!.value

  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await saveReportDraft(s.sub.client, s, reportId, 'serviceReport', {
    treatments: [
      {
        _id: 'row-1',
        treatment: ['Ants'],
        product: [original],
        quantity: [],
        method: [],
      },
    ],
  })

  const { rewritten } = await s.owner.client.mutation(
    api.optionSets.renameOption,
    {
      businessId: s.businessId,
      key: 'products',
      from: original,
      to: `${original} EC`,
    },
  )
  expect(rewritten).toBe(1)

  const report = await s.sub.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  const rows = report!.data.treatments as Array<{ product: Array<string> }>
  // The answer follows the word, so the draft still prints something the
  // business offers rather than a name that no longer exists anywhere.
  expect(rows[0].product).toEqual([`${original} EC`])
})

test('a finalised report keeps the words it was signed with', async () => {
  const s = await setupBusinessWithSub('optionset-frozen')
  const before = await productsFor(s.owner.client, s.businessId)
  const original = before.options.find(
    (o) => !before.pinned.includes(o.value),
  )!.value

  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await saveReportDraft(s.sub.client, s, reportId, 'serviceReport', {
    treatments: [
      {
        _id: 'row-1',
        treatment: ['Ants'],
        product: [original],
        quantity: [],
        method: [],
      },
    ],
  })
  // Renaming reaches this draft...
  await s.owner.client.mutation(api.optionSets.renameOption, {
    businessId: s.businessId,
    key: 'products',
    from: original,
    to: `${original} EC`,
  })

  const second = await createReport(s.sub.client, s, 'serviceReport')
  const fresh = await s.sub.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId: second,
  })
  expect((fresh!.optionSets?.products ?? []).map((o) => o.value)).toContain(
    `${original} EC`,
  )
  expect((fresh!.optionSets?.products ?? []).map((o) => o.value)).not.toContain(
    original,
  )
})

test('the vocabulary is the owner’s to read and to change', async () => {
  const s = await setupBusinessWithSub('optionset-access')
  const lists = await s.owner.client.query(api.optionSets.editable, {
    businessId: s.businessId,
  })
  expect(lists.length).toBeGreaterThan(0)

  // A technician fills reports from these lists but never edits them, and the
  // editor's own payload is not theirs: `archived` is the list of products the
  // business has deliberately stopped offering.
  await expectRejected(
    () =>
      s.sub.client.query(api.optionSets.editable, { businessId: s.businessId }),
    'NO_ACCESS',
  )
  // What they do get is the cheap half — which of the options to put first.
  expect(
    await s.sub.client.query(api.optionSets.usual, {
      businessId: s.businessId,
    }),
  ).toBeDefined()

  await expectRejected(
    () =>
      s.sub.client.mutation(api.optionSets.addOption, {
        businessId: s.businessId,
        key: 'products',
        label: 'Something of my own',
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      s.sub.client.mutation(api.optionSets.renameOption, {
        businessId: s.businessId,
        key: 'products',
        from: lists.find((l) => l.key === 'products')!.options[0].value,
        to: 'Renamed by a technician',
      }),
    'NO_ACCESS',
  )
})

test('a word a form matches on cannot be renamed away', async () => {
  const s = await setupBusinessWithSub('optionset-pinned')
  const risks = (
    await s.owner.client.query(api.optionSets.editable, {
      businessId: s.businessId,
    })
  ).find((list) => list.key === 'risks')!
  // None of the three Pest M8 forms matches a library value by name — they
  // print these lists and nothing more — so the guard is exercised through the
  // case it exists for: a business's own template, where "No Risk Safe Access
  // Given" clears every other risk. Renaming that away is not a wording change
  // but a silent behaviour change.
  const exclusive = risks.options[0].value
  await s.owner.client.mutation(api.customTemplates.create, {
    businessId: s.businessId,
    ...customTemplateArgs({
      name: 'Risk walkthrough',
      sections: [
        {
          title: 'Risk',
          fields: [
            {
              kind: 'checks',
              key: 'risks',
              label: 'Risks on site',
              optionsFrom: 'risks',
              options: risks.options.map((o) => ({
                value: o.value,
                label: o.label,
              })),
              exclusive: [exclusive],
            },
          ],
        },
      ],
    }),
  })

  const pinnedNow = (
    await s.owner.client.query(api.optionSets.editable, {
      businessId: s.businessId,
    })
  ).find((list) => list.key === 'risks')!
  expect(pinnedNow.pinned).toContain(exclusive)

  await expectRejected(
    () =>
      s.owner.client.mutation(api.optionSets.renameOption, {
        businessId: s.businessId,
        key: 'risks',
        from: exclusive,
        to: 'Safe access',
      }),
    'OPTION_PINNED',
  )
})

test('an archived product goes from new reports but stays in the draft that chose it', async () => {
  const s = await setupBusinessWithSub('optionset-archive')
  const before = await productsFor(s.owner.client, s.businessId)
  const doomed = before.options.find(
    (o) => !before.pinned.includes(o.value),
  )!.value

  const reportId = await createReport(s.sub.client, s, 'serviceReport')
  await saveReportDraft(s.sub.client, s, reportId, 'serviceReport', {
    treatments: [
      {
        _id: 'row-1',
        treatment: ['Ants'],
        product: [doomed],
        quantity: [],
        method: [],
      },
    ],
  })

  await s.owner.client.mutation(api.optionSets.archiveOption, {
    businessId: s.businessId,
    key: 'products',
    value: doomed,
  })

  const after = await productsFor(s.owner.client, s.businessId)
  expect(after.options.map((o) => o.value)).not.toContain(doomed)
  expect(after.archived.map((o) => o.value)).toContain(doomed)

  // The technician's answer is untouched — archiving says "stop offering
  // this", not "that job never used it".
  const report = await s.sub.client.query(api.reports.get, {
    businessId: s.businessId,
    reportId,
  })
  const rows = report!.data.treatments as Array<{ product: Array<string> }>
  expect(rows[0].product).toEqual([doomed])

  await s.owner.client.mutation(api.optionSets.restoreOption, {
    businessId: s.businessId,
    key: 'products',
    value: doomed,
  })
  const restored = await productsFor(s.owner.client, s.businessId)
  expect(restored.options.map((o) => o.value)).toContain(doomed)
  expect(restored.archived.map((o) => o.value)).not.toContain(doomed)
})

test('renaming a product keeps it starred', async () => {
  const s = await setupBusinessWithSub('optionset-rename-star')
  const products = await productsFor(s.owner.client, s.businessId)
  const starred = products.options.find(
    (o) => !products.pinned.includes(o.value),
  )!.value

  await s.owner.client.mutation(api.optionSets.setUsual, {
    businessId: s.businessId,
    key: 'products',
    value: starred,
    usual: true,
  })
  await s.owner.client.mutation(api.optionSets.renameOption, {
    businessId: s.businessId,
    key: 'products',
    from: starred,
    to: `${starred} EC`,
  })

  // The star is a separate fact from the words. Rebuilding the option around
  // its new name used to drop it, silently, for every technician.
  const after = await productsFor(s.owner.client, s.businessId)
  const renamed = after.options.find((o) => o.value === `${starred} EC`)!
  expect(renamed.usual).toBe(true)
  expect(
    (
      await s.owner.client.query(api.optionSets.usual, {
        businessId: s.businessId,
      })
    ).products,
  ).toEqual([`${starred} EC`])
})

test('a rename cannot collide with something in the archive', async () => {
  const s = await setupBusinessWithSub('optionset-rename-archived')
  const products = await productsFor(s.owner.client, s.businessId)
  const live = products.options.filter(
    (o) => !products.pinned.includes(o.value),
  )
  const [keep, shelved] = [live[0].value, live[1].value]

  await s.owner.client.mutation(api.optionSets.archiveOption, {
    businessId: s.businessId,
    key: 'products',
    value: shelved,
  })

  // Renaming onto the archived name would leave two things called the same
  // thing, one of which "Offer again" could never bring back.
  await expectRejected(
    () =>
      s.owner.client.mutation(api.optionSets.renameOption, {
        businessId: s.businessId,
        key: 'products',
        from: keep,
        to: shelved,
      }),
    'OPTION_EXISTS',
  )
})

test('the picker opens on what this business and this member actually use', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('optionset-usual')
  const products = await productsFor(s.owner.client, s.businessId)
  const marked = products.options.find(
    (o) => !products.pinned.includes(o.value),
  )!.value

  await s.owner.client.mutation(api.optionSets.setUsual, {
    businessId: s.businessId,
    key: 'products',
    value: marked,
    usual: true,
  })

  // The owner's mark reaches the technician; the technician's own habit is
  // theirs alone until they form one.
  expect(
    (
      await s.sub.client.query(api.optionSets.usual, {
        businessId: s.businessId,
      })
    ).products,
  ).toEqual([marked])

  const habit = products.options.find(
    (o) => o.value !== marked && !products.pinned.includes(o.value),
  )!.value
  await s.sub.client.mutation(api.optionSets.remember, {
    businessId: s.businessId,
    key: 'products',
    values: [habit],
  })
  expect(
    (
      await s.sub.client.query(api.optionSets.usual, {
        businessId: s.businessId,
      })
    ).products,
  ).toEqual([marked, habit])
  // Per member, not per business: the owner did not pick that up.
  expect(
    (
      await s.owner.client.query(api.optionSets.usual, {
        businessId: s.businessId,
      })
    ).products,
  ).toEqual([marked])

  // And the sheet actually groups by it.
  await signInViaUi(page, s.owner.email)
  const reportId = await createReport(s.owner.client, s, 'serviceReport')
  await page.goto(sectionUrl(s.slug, reportId, 'serviceReport', 'treatments'))
  await builderReady(page)
  // The fixture's job is a termite inspection, which seeds no treatment row.
  await page.getByRole('button', { name: 'Add Row' }).click()
  await page
    .getByRole('button', { name: /^Product & Active Ingredient —/ })
    .click()

  const picker = page.getByRole('dialog')
  await expect(picker.getByText('Usually')).toBeVisible()
  await expect(picker.getByText('Everything else')).toBeVisible()
  const first = picker.getByRole('checkbox').first()
  await expect(first).toHaveAccessibleName(new RegExp(escapeRe(marked)))
})

function escapeRe(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
