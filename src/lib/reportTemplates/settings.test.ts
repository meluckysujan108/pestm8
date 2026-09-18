import { describe, expect, test } from 'vitest'
import { fieldsOf, getTemplate } from './index'
import { applyTemplateSettings } from './settings'
import { resolveReportTemplate } from './resolve'

/**
 * What a business may change about a form it did not write.
 *
 * The line this draws is the whole point: the Pest M8 forms are reproduced
 * word for word, so a correction to their wording reaches every business that
 * issues them. Settings let a business put its own cover and signing rule on
 * one WITHOUT forking that wording. Anything that would change a question or
 * an answer belongs on the other side of the line — a clone.
 */

const serviceReport = getTemplate('serviceReport')

function signerSlots(template: ReturnType<typeof getTemplate>) {
  return fieldsOf(template)
    .filter((field) => field.kind === 'signature' && field.required)
    .map((field) => (field.kind === 'signature' ? field.slot : ''))
}

describe('the parts a business owns', () => {
  test('the cover says what the business calls it', () => {
    const applied = applyTemplateSettings(serviceReport, {
      print: {
        cover: { title: 'Pest Control Service Record', subtitle: 'Bayside' },
      },
    })
    expect(applied.print?.cover?.title).toBe('Pest Control Service Record')
    expect(applied.print?.cover?.subtitle).toBe('Bayside')
    // And the rest of the print spec is untouched.
    expect(applied.print?.formName).toBe(serviceReport.print?.formName)
    expect(applied.print?.omitEmpty).toBe(true)
  })

  test('the footer and title band can be renamed', () => {
    const applied = applyTemplateSettings(serviceReport, {
      print: { formName: 'Pest Control Service Record' },
    })
    expect(applied.print?.formName).toBe('Pest Control Service Record')
    // The cover is a separate decision, not swept along with it.
    expect(applied.print?.cover?.title).toBe(serviceReport.print?.cover?.title)
  })

  test('nothing a business sets can change a question or an answer', () => {
    const applied = applyTemplateSettings(serviceReport, {
      print: { formName: 'Anything', cover: { title: 'Anything' } },
      requiredSigners: [],
    })
    const before = fieldsOf(serviceReport).map(
      (f) => `${f.kind}:${f.key}:${f.label}`,
    )
    const after = fieldsOf(applied).map((f) => `${f.kind}:${f.key}:${f.label}`)
    expect(after).toEqual(before)
  })
})

describe('who has to sign', () => {
  test('by default, whoever the form says', () => {
    expect(signerSlots(serviceReport)).toEqual(['technician'])
  })

  test('a business can require the client as well', () => {
    const applied = applyTemplateSettings(serviceReport, {
      requiredSigners: ['technician', 'client'],
    })
    expect(signerSlots(applied).sort()).toEqual(['client', 'technician'])
  })

  test('a business can require nobody — the pads stay, the insistence goes', () => {
    // For the businesses where the office locks reports the next morning. The
    // signature pad is still on the form; the app just stops refusing.
    const applied = applyTemplateSettings(serviceReport, {
      requiredSigners: [],
    })
    expect(signerSlots(applied)).toEqual([])
    const pads = fieldsOf(applied).filter((field) => field.kind === 'signature')
    expect(pads).toHaveLength(
      fieldsOf(serviceReport).filter((field) => field.kind === 'signature')
        .length,
    )
  })

  test('saying nothing leaves the form’s own rule alone', () => {
    expect(signerSlots(applyTemplateSettings(serviceReport, {}))).toEqual([
      'technician',
    ])
  })
})

describe('a signed report', () => {
  test('keeps the chrome it was signed under, whatever the business changes later', () => {
    // A snapshot is the wording AND the chrome a client received. An owner
    // renaming the form next year must not relabel a document someone already
    // has in their filing cabinet.
    const snapshot = {
      name: serviceReport.name,
      shortName: serviceReport.shortName,
      legalBasis: serviceReport.legalBasis,
      blurb: serviceReport.blurb,
      sections: serviceReport.sections ?? [],
      boilerplate: serviceReport.boilerplate,
      version: serviceReport.version,
      print: serviceReport.print,
    }

    const resolved = resolveReportTemplate({
      template: 'serviceReport',
      templateVersion: serviceReport.version,
      templateSnapshot: snapshot,
      settings: { print: { formName: 'Renamed Last Tuesday' } },
    })

    expect(resolved.print?.formName).toBe(serviceReport.print?.formName)
  })

  test('a draft, by contrast, follows the settings', () => {
    const resolved = resolveReportTemplate({
      template: 'serviceReport',
      templateVersion: serviceReport.version,
      settings: { print: { formName: 'Renamed Last Tuesday' } },
    })
    expect(resolved.print?.formName).toBe('Renamed Last Tuesday')
  })
})
