import { expect, test } from '@playwright/test'
import { api, setupBusinessWithSub } from './fixtures'
import { createReport, finaliseReport } from './fixtures/reportPayloads'
import { getTemplate, sectionsOf } from '../src/lib/reportTemplates'
import type { TemplateId } from './fixtures/reportPayloads'

/**
 * The guarantee the verbatim rewrite rests on.
 *
 * `e2e/customTemplates.spec.ts` already proves a finalised report survives an
 * edit to the custom template it was built from — "the single most important
 * assertion in the whole feature", in that file's own words. It proved nothing
 * about the four built-ins, because those were exempt: their `.ts` files never
 * changed, so there was nothing to survive.
 *
 * The word-for-word rewrite changes three of them. These tests say the same
 * thing now holds for built-ins: a signed document carries its own copy of the
 * wording AND of the records it printed, and reads from those copies rather
 * than from whatever the modules or the client record say today.
 *
 * Proving that a v1 report still prints v1 after the rewrite needs a v1 row,
 * which no public API can create any more — that lives in
 * `convex/reportSnapshots.test.ts` and `src/lib/reportTemplates/seam.test.ts`,
 * against the frozen legacy modules and the snapshot hashes already on dev.
 */

const BUILT_INS: Array<TemplateId> = [
  'serviceReport',
  'timberPestInspection',
  'termiteManagementCert',
]

test.describe('built-in template snapshots', () => {
  test('finalising a built-in report freezes the wording it was signed against', async () => {
    const s = await setupBusinessWithSub('snapshot-builtin')

    for (const template of BUILT_INS) {
      const reportId = await createReport(s.owner.client, s, template)
      await finaliseReport(s.owner.client, s, reportId, template)

      const report = await s.owner.client.query(api.reports.get, {
        businessId: s.businessId,
        reportId,
      })

      expect(report?.templateSnapshotId, `${template} has no snapshot`).toBeTruthy()

      // Not merely present — the same wording, section for section, as the
      // revision it was written against, including the printed content that
      // lives outside the sections.
      const live = getTemplate(template)
      expect(live.version).toBe(2)
      expect(report?.templateVersion).toBe(2)
      expect(report?.templateSnapshot?.version).toBe(2)
      expect(report?.templateSnapshot?.name).toBe(live.name)
      expect(report?.templateSnapshot?.sections).toEqual(sectionsOf(live))
      expect(report?.templateSnapshot?.terms).toEqual(live.terms)
      expect(report?.templateSnapshot?.print).toEqual(live.print)
      expect(report?.templateSnapshot?.features).toBeUndefined()
      // And the records it printed, frozen with it.
      expect(report?.contextSnapshot?.property?.addressLine).toBeTruthy()
    }
  })

  test('a draft carries a version but no snapshot — nothing is frozen until it is signed', async () => {
    const s = await setupBusinessWithSub('snapshot-draft')

    const reportId = await createReport(s.owner.client, s, 'serviceReport')
    const draft = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })

    // A draft resolves live on purpose: nothing is legally binding yet, so
    // picking up a correction to the template is the behaviour you want.
    expect(draft?.templateSnapshot).toBeNull()
    expect(draft?.contextSnapshot).toBeUndefined()
    expect(draft?.templateVersion).toBe(2)
    // A new draft is on the current form, so there is nothing to switch to.
    expect(draft?.upgrade).toBeNull()
  })

  test('reports sharing a template share one snapshot row', async () => {
    const s = await setupBusinessWithSub('snapshot-dedupe')

    const ids = await Promise.all(
      [0, 1, 2].map(async () => {
        // The largest template, with its warranty pages as structured prose —
        // the hardest content to serialise identically twice.
        const reportId = await createReport(s.owner.client, s, 'serviceReport')
        await finaliseReport(s.owner.client, s, reportId, 'serviceReport')
        const report = await s.owner.client.query(api.reports.get, {
          businessId: s.businessId,
          reportId,
        })
        return report?.templateSnapshotId
      }),
    )

    // Content-addressed. If the canonical serialisation ever stops being
    // stable, this is where it shows up: three rows instead of one, and a
    // table that grows with every finalise.
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBeTruthy()
  })

  test('the document a client receives is built from the snapshot, not the live module', async () => {
    const s = await setupBusinessWithSub('snapshot-pdf')

    const reportId = await createReport(s.owner.client, s, 'termiteManagementCert')
    await finaliseReport(s.owner.client, s, reportId, 'termiteManagementCert')

    const { url } = await s.owner.client.action(api.reportPdf.generate, {
      businessId: s.businessId,
      reportId,
    })
    expect(url).toBeTruthy()

    const res = await fetch(url!)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-')

    const text = await textOf(bytes)
    expect(text).toContain('Chemical Soil Barrier')
    expect(text).toContain('Purpose Of Termite Management Systems')
    expect(text).toContain('EXISTING STRUCTURE CERTIFICATE OF INSTALLATION')
    // The durable notice was app-invented; the verbatim certificate has none.
    expect(text).not.toContain('DO NOT REMOVE THIS NOTICE')
  })

  test('renaming the client after signing does not rewrite the signed report', async () => {
    const s = await setupBusinessWithSub('snapshot-context')

    const reportId = await createReport(s.owner.client, s, 'serviceReport')
    await finaliseReport(s.owner.client, s, reportId, 'serviceReport')
    const draftId = await createReport(s.owner.client, s, 'serviceReport')

    const before = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    const signedName = before!.context.client!.name!
    const clientId = before!.property!.clientId

    await s.owner.client.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId,
      name: 'Renamed Next Year',
    })

    // The verbatim forms print the client's name from the record rather than
    // a typed answer. Read live, this rename would edit a signed document.
    const signed = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId,
    })
    expect(signed!.context.client!.name).toBe(signedName)
    expect(signed!.property!.client!.name).toBe(signedName)

    // A draft is not signed yet, so it should pick the correction up.
    const draft = await s.owner.client.query(api.reports.get, {
      businessId: s.businessId,
      reportId: draftId,
    })
    expect(draft!.context.client!.name).toBe('Renamed Next Year')
  })
})

async function textOf(data: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  let text = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    text += content.items.map((i) => ('str' in i ? i.str : '')).join(' ')
  }
  return text.replace(/\s+/g, ' ')
}
