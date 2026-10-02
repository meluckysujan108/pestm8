import { describe, expect, test } from 'vitest'
import { fieldsOf, getTemplate, sectionsOf } from './index'
import {
  CLIENT_SIGNATURES_SHOWN,
  applyTemplateSettings,
  withoutClientSigning,
} from './settings'
import { resolveReportTemplate } from './resolve'
import { submittablePayload, validateReport } from './validate'
import type { CustomTemplateShape } from './resolve'
import type { FieldDef, TemplateId } from './types'

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

  test('a business cannot require the client’s signature — only a technician’s', () => {
    // Settings saved before the rule may name the client's slot. It asks for
    // nothing now: the client's pad is never needed to lock.
    const applied = applyTemplateSettings(serviceReport, {
      requiredSigners: ['technician', 'client'],
    })
    expect(signerSlots(applied)).toEqual(['technician'])
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

describe('the client’s signature is never needed to lock', () => {
  /** A business's own form whose author ticked Required on the client's pad. */
  const clone: CustomTemplateShape = {
    name: 'Bayside Service Report',
    shortName: 'Service',
    legalBasis: 'APVMA',
    blurb: '',
    boilerplate: '',
    sections: [
      {
        title: 'Sign off',
        fields: [
          {
            kind: 'signature',
            key: 'techSignature',
            label: 'Technician',
            slot: 'technician',
            role: 'technician',
            required: true,
          },
          {
            kind: 'signature',
            key: 'clientSignature',
            label: 'Client',
            slot: 'client',
            role: 'client',
            required: true,
          },
        ],
      },
    ],
  }

  function lockable(signedSlots: Array<string>) {
    const template = resolveReportTemplate({
      template: 'custom',
      customTemplate: clone,
      status: 'draft',
      signedSlots,
    })
    const data: Record<string, unknown> = {}
    for (const slot of signedSlots) {
      data[slot === 'client' ? 'clientSignature' : 'techSignature'] = {
        signedAt: 1790000000000,
      }
    }
    return validateReport({ template, data, signedSlots })
  }

  test('a business’s own form that ticked Required on the client’s pad locks without it', () => {
    expect(lockable(['technician']).ok).toBe(true)
  })

  test('the technician’s signature is still required', () => {
    const result = lockable([])
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues.map((issue) => issue.key)).toEqual([
      'techSignature',
    ])
  })

  test('on every built-in form, as a draft, only the technician’s pads are required', () => {
    for (const id of [
      'serviceReport',
      'timberPestInspection',
      'termiteManagementCert',
    ] as const) {
      // Once the client has signed, their pad is on the form whether or not
      // client signatures are shown — so the rule is tested either way.
      for (const signedSlots of [[], ['client']]) {
        const pads = fieldsOf(
          resolveReportTemplate({
            template: id,
            // Today's revision: an absent version means v1, whose pads differ.
            templateVersion: getTemplate(id).version,
            settings: {
              requiredSigners: ['technician', 'installer', 'client'],
            },
            status: 'draft',
            signedSlots,
          }),
        ).filter((field) => field.kind === 'signature')
        expect(pads.some((field) => field.role === 'client')).toBe(
          CLIENT_SIGNATURES_SHOWN || signedSlots.includes('client'),
        )
        for (const field of pads) {
          expect(field.required === true).toBe(field.role === 'technician')
        }
      }
    }
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
      status: 'finalised',
    })

    expect(resolved.print?.formName).toBe(serviceReport.print?.formName)
  })

  test('a draft, by contrast, follows the settings', () => {
    const resolved = resolveReportTemplate({
      template: 'serviceReport',
      templateVersion: serviceReport.version,
      settings: { print: { formName: 'Renamed Last Tuesday' } },
      status: 'draft',
    })
    expect(resolved.print?.formName).toBe('Renamed Last Tuesday')
  })
})

/**
 * Client signatures switched off (`CLIENT_SIGNATURES_SHOWN`, 1 Oct 2026): a
 * report being filled in has no client's pad, and no section that is only the
 * client's sign-off — unless the client has already signed it. A locked
 * report is left exactly as it was locked.
 *
 * The tests that go through `resolveReportTemplate` describe the switch off,
 * and stand aside while it is on; the first one says what "on" means.
 */
describe('the client’s part of a report being filled in', () => {
  const whileOff = test.skipIf(CLIENT_SIGNATURES_SHOWN)

  const termite = getTemplate('termiteManagementCert')
  const timber = getTemplate('timberPestInspection')

  /** A built-in at a given revision, as a draft or (no status) whole. */
  function resolved(
    template: TemplateId,
    templateVersion: number,
    extra: {
      status?: 'draft' | 'finalised'
      signedSlots?: Array<string>
    } = {},
  ) {
    return resolveReportTemplate({ template, templateVersion, ...extra })
  }

  const isClientPad = (field: FieldDef) =>
    field.kind === 'signature' && field.role === 'client'

  test('a draft is the whole form exactly when client signatures are shown', () => {
    const draft = resolved('termiteManagementCert', termite.version, {
      status: 'draft',
    })
    expect(draft === resolved('termiteManagementCert', termite.version)).toBe(
      CLIENT_SIGNATURES_SHOWN,
    )
  })

  whileOff('the termite certificate loses §8, and its terms are §8', () => {
    const draft = resolved('termiteManagementCert', termite.version, {
      status: 'draft',
    })
    const sections = draft.sections ?? []
    expect(sections.map((section) => section.id)).not.toContain(
      'acknowledgment',
    )
    expect(fieldsOf(draft).some(isClientPad)).toBe(false)
    // §1–§7 are the module's own objects, untouched: nothing but the client's
    // part is rebuilt, so the builder re-renders nothing else.
    expect(sections).toHaveLength(7)
    sections.forEach((section, index) => {
      expect(section).toBe(termite.sections?.[index])
    })
    expect(draft.print?.termsHeading).toBe(
      '8. TERMS AND CONDITIONS OF CERTIFICATE',
    )
  })

  whileOff('the timber report loses its client acknowledgment', () => {
    const draft = resolved('timberPestInspection', timber.version, {
      status: 'draft',
    })
    expect((draft.sections ?? []).map((section) => section.id)).not.toContain(
      'clientAcknowledgment',
    )
    expect(fieldsOf(draft).map((field) => field.key)).not.toContain(
      'acknowledgmentClientName',
    )
  })

  whileOff(
    'the service report keeps §4 and loses only the client’s pad',
    () => {
      const draft = resolved('serviceReport', serviceReport.version, {
        status: 'draft',
      })
      const recommendations = (draft.sections ?? []).find(
        (section) => section.id === 'recommendations',
      )
      const keys = recommendations?.fields.map((field) => field.key) ?? []
      expect(keys).toContain('technicianSignature')
      expect(keys).toContain('emailReportTo')
      expect(keys).not.toContain('clientSignature')

      // The v1 Service Report a few drafts are still filled in on, too.
      const v1 = resolved('serviceReport', 1, { status: 'draft' })
      expect(fieldsOf(v1).some(isClientPad)).toBe(false)
      expect(fieldsOf(v1).map((field) => field.key)).toContain(
        'technicianSignature',
      )
    },
  )

  test('a form with no client’s pad is left as it is', () => {
    for (const [template, version] of [
      ['termiteManagementCert', 1],
      ['timberPestInspection', 1],
      ['treatmentRecord', 1],
    ] as const) {
      expect(resolved(template, version, { status: 'draft' })).toBe(
        resolved(template, version),
      )
    }
  })

  test('a locked report, or a caller that does not say, gets the whole form', () => {
    // Locked without a frozen copy of its wording (`freezeTemplate` gave up):
    // it reads as it always has, §8 and all.
    for (const status of ['finalised', undefined] as const) {
      const whole = resolved('termiteManagementCert', termite.version, {
        status,
      })
      expect((whole.sections ?? []).map((section) => section.id)).toContain(
        'acknowledgment',
      )
      expect(fieldsOf(whole).some(isClientPad)).toBe(true)
      expect(whole.print?.termsHeading).toBe(
        '9. TERMS AND CONDITIONS OF CERTIFICATE',
      )
    }
  })

  test('a draft the client has already signed keeps their pad and section', () => {
    const draft = resolved('termiteManagementCert', termite.version, {
      status: 'draft',
      signedSlots: ['technician', 'client'],
    })
    expect((draft.sections ?? []).map((section) => section.id)).toContain(
      'acknowledgment',
    )
    expect(fieldsOf(draft).some(isClientPad)).toBe(true)
    expect(draft.print?.termsHeading).toBe(
      '9. TERMS AND CONDITIONS OF CERTIFICATE',
    )
  })

  test('shown, nothing is taken out', () => {
    expect(withoutClientSigning(termite, { shown: true })).toBe(termite)
  })

  test('the client’s section is found when it is the last one', () => {
    // §8 is the certificate's last section, so what is left is the first
    // seven, object for object — which once read as "nothing changed".
    const without = withoutClientSigning(termite, { shown: false })
    expect(without).not.toBe(termite)
    expect(without.sections).toHaveLength(7)
  })

  whileOff(
    'a business’s copy of a form loses the same section, ids or not',
    () => {
      // Matched by what the section holds, not by its id or number, so a clone
      // stripped of both still loses it.
      const clone: CustomTemplateShape = {
        name: 'Bayside Timber Pest Inspection',
        shortName: timber.shortName,
        legalBasis: timber.legalBasis,
        blurb: timber.blurb,
        boilerplate: timber.boilerplate,
        sections: sectionsOf(timber).map(
          ({ id: _id, number: _number, ...section }) => section,
        ),
        terms: timber.terms,
        print: timber.print,
      }
      const draft = resolveReportTemplate({
        template: 'custom',
        customTemplate: clone,
        status: 'draft',
      })
      const titles = sectionsOf(draft).map((section) => section.title)
      expect(titles).not.toContain('CLIENT ACKNOWLEDGMENT OF THIS REPORT')
      expect(titles).toHaveLength(clone.sections.length - 1)
      expect(fieldsOf(draft).some(isClientPad)).toBe(false)
    },
  )

  whileOff('a business’s own section loses only the client’s pad', () => {
    const own: CustomTemplateShape = {
      name: 'Bayside Service Report',
      shortName: 'Service',
      legalBasis: 'APVMA',
      blurb: '',
      boilerplate: '',
      sections: [
        {
          title: 'Sign off',
          fields: [
            {
              kind: 'note',
              key: 'terms',
              label: 'Terms',
              body: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Payment within 14 days.' },
                    ],
                  },
                ],
              },
            },
            { kind: 'date', key: 'serviceDate', label: 'Date of service' },
            {
              kind: 'signature',
              key: 'clientSignature',
              label: 'Client',
              slot: 'client',
              role: 'client',
            },
          ],
        },
      ],
    }
    const draft = resolveReportTemplate({
      template: 'custom',
      customTemplate: own,
      status: 'draft',
    })
    expect(
      sectionsOf(draft).map((section) => [
        section.title,
        section.fields.map((field) => field.key),
      ]),
    ).toEqual([['Sign off', ['terms', 'serviceDate']]])
  })

  whileOff(
    'a required question in the client’s section does not hold up the lock',
    () => {
      const own: CustomTemplateShape = {
        name: 'Bayside Inspection',
        shortName: 'Inspection',
        legalBasis: 'AS 4349.3',
        blurb: '',
        boilerplate: '',
        sections: [
          {
            title: 'Inspector',
            fields: [
              {
                kind: 'signature',
                key: 'inspectorSignature',
                label: 'Inspector',
                slot: 'technician',
                role: 'technician',
                required: true,
              },
            ],
          },
          {
            title: 'Client sign-off',
            fields: [
              {
                kind: 'text',
                key: 'clientSignatoryName',
                label: 'Client name',
                required: true,
              },
              {
                kind: 'signature',
                key: 'clientSignature',
                label: 'Client',
                slot: 'client',
                role: 'client',
              },
            ],
          },
        ],
      }
      const data = { inspectorSignature: { signedAt: 1790000000000 } }
      const signedSlots = ['technician']

      // The whole form asks for the client's name …
      const whole = validateReport({
        template: resolveReportTemplate({
          template: 'custom',
          customTemplate: own,
        }),
        data,
        signedSlots,
      })
      expect(whole.ok ? [] : whole.issues.map((issue) => issue.key)).toEqual([
        'clientSignatoryName',
      ])

      // … and a draft, which has no client's section to ask it in, does not.
      const draft = resolveReportTemplate({
        template: 'custom',
        customTemplate: own,
        status: 'draft',
        signedSlots,
      })
      expect(sectionsOf(draft).map((section) => section.title)).toEqual([
        'Inspector',
      ])
      expect(validateReport({ template: draft, data, signedSlots }).ok).toBe(
        true,
      )
    },
  )

  whileOff('the client’s answers are kept, not cleared as hidden', () => {
    // Left out of the form rather than hidden in it: `pruneHidden` clears a
    // hidden question's answer, and these are kept for the switch going back.
    const draft = resolved('termiteManagementCert', termite.version, {
      status: 'draft',
    })
    const payload = submittablePayload(draft, {
      installDate: '2026-09-30',
      clientSignatoryName: 'Jane Nguyen',
      clientDateSigned: '2026-09-30',
      clientSignature: { signedAt: 1790000000000 },
    })
    expect(payload).toMatchObject({
      clientSignatoryName: 'Jane Nguyen',
      clientDateSigned: '2026-09-30',
      clientSignature: { signedAt: 1790000000000 },
    })
  })
})
