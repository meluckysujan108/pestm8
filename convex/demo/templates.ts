import { ConvexError, v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { forSelf, recordAudit } from '../lib/audit'
import {
  MAX_TEMPLATES_SCANNED,
  ensureRow,
  rewriteDraftsForRename,
} from '../lib/optionSets'
import {
  REPORT_TEMPLATES,
  RETIRED_TEMPLATES,
  getTemplate,
  sectionsOf,
} from '../../src/lib/reportTemplates'
import { customTemplateSectionsSchema } from '../../src/lib/reportTemplates/customTemplateSchema'
import {
  MAX_LIVE_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_RENAMES,
  rememberedOrder,
} from '../../src/lib/reportTemplates/optionLibraries'
import { pinnedValues } from '../../src/lib/reportTemplates/optionSets'
import {
  MAX_SNIPPETS,
  MAX_SNIPPETS_PER_FIELD,
  MAX_SNIPPET_LENGTH,
  sameSnippet,
} from '../../src/lib/reportTemplates/snippets'
import { at, demoBaseV } from './shared'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type {
  FieldDef,
  Option,
  OptionSetKey,
  SectionDef,
  TemplateId,
} from '../../src/lib/reportTemplates'
import type { DemoBase } from './shared'

/**
 * The demo's report settings: the owner's option lists, the cover and signing
 * settings on two of the built-in forms, four custom templates in four
 * different states, the phrases under the long-answer boxes, and one
 * subcontractor's picker memory.
 *
 * Every write mirrors the public mutation behind the screen that makes it
 * (optionSets, templateSettings, customTemplates, snippets), with the member
 * the record names in place of the signed-in caller and the time it would
 * have happened in place of `Date.now()`. Those handlers keep their bodies
 * inline, so the bodies are copied here line for line; where the app exports a
 * helper (ensureRow, rewriteDraftsForRename, recordAudit) it is called.
 *
 * Runs before any report exists, because reports read all of this when they
 * are started and freeze it when they are finalised.
 *
 * The content is exported so the test can make the same changes through the
 * public mutations and compare what each path leaves behind.
 */

// ───────────────────────────────────────────────────────────── content

const asOptions = (values: Array<string>): Array<Option> =>
  values.map((value) => ({ value, label: value }))

/** Exactly MAX_OPTION_LENGTH characters, with the punctuation a product name
 * carries: an ampersand, slashes, a micro sign and both kinds of bracket. */
export const LONG_PRODUCT =
  "Pestguard Duo Pro Residual & Flushing Concentrate (50 g/L Bifenthrin + 25 g/L Imidacloprid + 400 µg/L Pyriproxyfen) [commercial/industrial use only; observe the label's re-entry & withholding periods]"

/** The owner's product list: two added, three starred, one default renamed
 * (starred first, so the rename has to carry the star) and one archived. */
export const PRODUCT_CHANGES = {
  added: ['Termidor HE (Fipronil 100 g/L)', LONG_PRODUCT],
  usual: [
    'Biflex Ultra (100 g/L Bifenthrin)',
    'Ditrac All Weather Blox (0.05 g/kg Bromadiolone)',
    'Termidor HE (Fipronil 100 g/L)',
  ],
  rename: {
    from: 'Biflex Ultra (100 g/L Bifenthrin)',
    to: 'Biflex Ultra 100 SC (Bifenthrin 100 g/L)',
  },
  archived: 'Couma (0.37 g/Kg COUMATETRALYL)',
}

/** Nine starred treatments: one more than a picker's "Usually" group shows. */
export const USUAL_TREATMENTS = [
  'General Pest Control',
  'Ant Full Block Spray',
  'Ant Spot Spray',
  'Spider Spray External',
  'Cockroach Treatment',
  'German Cockroach Treatment',
  'Rodents',
  'Rodent Bait Top-Up',
  'Wasps',
]

/** What the Settings sheet sends for each form (it always sends all four).
 * The certificate has no row at all, which is not the same as a cleared one. */
export const TEMPLATE_SETTINGS: Array<{
  templateRef: string
  coverTitle: string
  coverSubtitle: string
  formName: string
  requiredSigners: Array<string>
}> = [
  {
    templateRef: 'serviceReport',
    coverTitle: 'Swan River Service Report',
    coverSubtitle: 'Pest Control · Perth metro',
    formName: 'Swan River Service Report',
    requiredSigners: ['technician'],
  },
  {
    // Nobody has to sign: the office locks these the next morning.
    templateRef: 'timberPestInspection',
    coverTitle: '',
    coverSubtitle: '',
    formName: 'Timber Pest Inspection (Swan River)',
    requiredSigners: [],
  },
]

export type TemplateContent = {
  name: string
  shortName: string
  legalBasis: string
  blurb: string
  sections: Array<SectionDef>
  boilerplate: string
}

/** A custom form built from scratch, touching most of what the builder can
 * do: a conditional required answer, a repeater with a minimum, a required
 * gallery, a signature, and the two delivery semantics. */
export const BAIT_STATION: TemplateContent = {
  name: 'Rodent Bait Station Check',
  shortName: 'Bait Check',
  legalBasis: 'APVMA',
  blurb:
    'Monthly check of every rodent bait station on site: bait used, consumption per station, activity found, photos and sign-off.',
  boilerplate:
    'Bait stations are tamper-resistant and locked. Keep children and pets away from them, and do not move or open a station; call us if one is damaged or missing.',
  sections: [
    {
      title: 'Visit',
      fields: [
        {
          kind: 'date',
          key: 'visitDate',
          label: 'Visit date',
          required: true,
          defaultToday: true,
        },
        {
          kind: 'derived',
          key: 'site',
          label: 'Site address',
          source: 'property.address',
          format: 'address',
        },
        {
          kind: 'member',
          key: 'tech',
          label: 'Technician',
          roleWord: 'Technician',
          defaultTo: 'jobAssignee',
        },
        {
          kind: 'toggle',
          key: 'sendCopy',
          label: 'Send a copy of this check to the client when you submit?',
          semantic: 'sendCopyToClient',
          printed: false,
          yes: 'Yes',
          no: 'No',
        },
      ],
    },
    {
      title: 'Bait stations',
      fields: [
        {
          kind: 'select',
          key: 'baitType',
          label: 'Bait used',
          required: true,
          options: asOptions([
            'Wax block',
            'Soft bait sachet',
            'Pellets',
            'Non-toxic monitoring block',
          ]),
        },
        {
          kind: 'number',
          key: 'stations',
          label: 'Stations checked',
          min: 0,
          max: 100,
          step: 1,
        },
        {
          kind: 'toggle',
          key: 'activity',
          label: 'Rodent activity found?',
          yes: 'Yes',
          no: 'No',
          flaggedValue: true,
        },
        {
          kind: 'area',
          key: 'activityNotes',
          label: 'Where, and what was found',
          required: true,
          rows: 3,
          visibleWhen: { when: 'activity', eq: true },
        },
        {
          kind: 'repeater',
          key: 'stationsLog',
          label: 'Station log',
          addLabel: 'Add station',
          min: 1,
          columns: [
            { kind: 'text', key: 'station', label: 'Station', required: true },
            {
              kind: 'select',
              key: 'consumption',
              label: 'Consumption',
              options: asOptions([
                'None',
                'Nibbled (under 25%)',
                'Partly eaten (25–75%)',
                'Fully eaten (over 75%)',
                'Bait missing or damaged',
              ]),
            },
          ],
        },
      ],
    },
    {
      title: 'Photos and sign-off',
      fields: [
        {
          kind: 'gallery',
          key: 'photos',
          label: 'Station photos',
          required: true,
          maxPhotos: 12,
        },
        {
          kind: 'signature',
          key: 'techSig',
          label: "Technician's signature",
          slot: 'technician',
          role: 'technician',
          required: true,
        },
        {
          kind: 'emails',
          key: 'cc',
          label: 'Also email this check to',
          semantic: 'emailTo',
          printed: false,
        },
      ],
    },
  ],
}

/** The owner's unissued edit of the bait check: renamed, and one question
 * added. Valid, so "Issue to my team" would publish it as version 2. */
export const BAIT_STATION_REVISED: TemplateContent = {
  ...BAIT_STATION,
  name: 'Rodent Bait Station Check (revised)',
  sections: withField(BAIT_STATION.sections, 'stations', {
    kind: 'toggle',
    key: 'stationsSecured',
    label: 'All stations locked and secured?',
    yes: 'Yes',
    no: 'No',
    flaggedValue: false,
  }),
}

/** A small form, retired ten days ago. */
export const POSSUM: TemplateContent = {
  name: 'Possum Exclusion Check',
  shortName: 'Possum',
  legalBasis: 'Biodiversity Conservation Act 2016 (WA)',
  blurb:
    'Entry points found and sealed, whether a one-way flap went in, and when to come back to close it.',
  boilerplate: '',
  sections: [
    {
      title: 'Inspection',
      fields: [
        {
          kind: 'date',
          key: 'checkDate',
          label: 'Date',
          required: true,
          defaultToday: true,
        },
        {
          kind: 'checks',
          key: 'entryPoints',
          label: 'Entry points found',
          options: asOptions([
            'Lifted roof tiles',
            'Gap at the fascia',
            'Missing vent cover',
            'Gap under the ridge capping',
            'Branches touching the roof',
          ]),
          extensible: true,
          addLabel: 'Add another entry point',
        },
        {
          kind: 'toggle',
          key: 'flapFitted',
          label: 'One-way flap fitted?',
          yes: 'Yes',
          no: 'No',
        },
        {
          kind: 'area',
          key: 'possumNotes',
          label: 'Notes for the client',
          rows: 3,
        },
      ],
    },
    {
      title: 'Sign-off',
      fields: [
        {
          kind: 'member',
          key: 'possumTech',
          label: 'Technician',
          roleWord: 'Technician',
          defaultTo: 'jobAssignee',
        },
        {
          kind: 'signature',
          key: 'possumSig',
          label: "Technician's signature",
          slot: 'technician',
          role: 'technician',
          required: true,
        },
      ],
    },
  ],
}

type Issue = {
  name: string
  blurb?: string
  /** Added by the owner in the editor, after the field keyed `after`. */
  after: string
  field: FieldDef
}

/** The Service Report cloned, then issued twice, renamed each time. */
export const SERVICE_CLONE: {
  source: TemplateId
  name: string
  issues: [Issue, Issue]
} = {
  source: 'serviceReport',
  name: 'Swan River Service Report (custom)',
  issues: [
    {
      name: 'Swan River Service Report — Residential',
      after: 'siteAddress',
      field: {
        kind: 'area',
        key: 'accessNotes',
        label: 'Access notes (gate code, dogs, parking)',
        rows: 3,
      },
    },
    {
      name: 'Swan River Service Report — Residential & Strata',
      blurb:
        'General pest treatment for homes and strata common property: products applied, risk assessment and sign-off.',
      after: 'accessNotes',
      field: { kind: 'text', key: 'strataPlan', label: 'Strata plan / lot' },
    },
  ],
}

/** The Timber report cloned and never issued, with an edit in progress that
 * copied a question without giving the copy its own key. */
export const TIMBER_VARIANT: {
  source: TemplateId
  name: string
  after: string
  duplicate: FieldDef
} = {
  source: 'timberPestInspection',
  name: 'Timber Inspection — site variant',
  after: 'siteDrainage',
  duplicate: {
    kind: 'radio',
    key: 'siteDrainage',
    label: 'Site Drainage (rear of block)',
    options: asOptions(['Adequate', 'Inadequate']),
    flaggedValues: ['Inadequate'],
  },
}

/** Exactly MAX_SNIPPET_LENGTH characters. */
export const LONG_PHRASE = [
  'Full internal and external general pest treatment completed.',
  'Internal: crack-and-crevice spray to skirting boards, kitchen and bathroom plinths, laundry and behind appliances; gel bait placed in kitchen cupboard hinges and under the sinks.',
  'External: perimeter barrier spray to all walls to 1 m, window and door frames, weep holes, eaves and the pergola, webs brushed down first.',
  'Roof void dusted.',
  'Keep children and pets off treated surfaces until dry (about 2 hours), avoid mopping skirting boards for 2 weeks, and expect some cockroach activity for 7–10 days while the gel works.',
  'Warranty: 3 months.',
].join(' ')

export type PhraseSpec = {
  fieldKey: string
  text: string
  by: 'owner' | 'sub'
  /** Saved on this day (from the seed's today) at this hour. */
  day: number
  hh: number
  /** Tapped this many times, the last on `lastDay`. */
  used?: { times: number; lastDay: number }
}

/**
 * Twelve on the Service Report's comments — the cap, so its box shows the
 * "12 phrases" message and no Save — two on one of the Timber report's
 * comment boxes, and one on the bait check's.
 */
export const PHRASES: Array<PhraseSpec> = [
  {
    fieldKey: 'comments',
    text: LONG_PHRASE,
    by: 'owner',
    day: -84,
    hh: 19,
    used: { times: 23, lastDay: -1 },
  },
  {
    fieldKey: 'comments',
    text: 'Cockroach activity found in kitchen cupboards and behind the fridge. Gel applied to harbourage points; expect more sightings for 7–10 days while it takes effect.',
    by: 'owner',
    day: -83,
    hh: 20,
    used: { times: 14, lastDay: -4 },
  },
  {
    fieldKey: 'comments',
    text: 'No pest activity sighted on this visit. Preventative treatment applied as per the service plan.',
    by: 'owner',
    day: -80,
    hh: 18,
    used: { times: 9, lastDay: -2 },
  },
  {
    fieldKey: 'comments',
    text: 'Rodent activity found in the roof void.\nBait stations placed: 4 (roof void ×3, garage ×1).\nKeep pets away from the garage station.\nRe-check booked in 35 days.',
    by: 'owner',
    day: -77,
    hh: 12,
    used: { times: 6, lastDay: -5 },
  },
  {
    fieldKey: 'comments',
    text: 'Ant trails along the skirting boards in the kitchen and laundry. Non-repellent spray applied outside; gel placed inside.',
    by: 'owner',
    day: -73,
    hh: 17,
    used: { times: 4, lastDay: -9 },
  },
  {
    fieldKey: 'comments',
    text: 'Spider webs brushed down from the eaves, pergola and letterbox before spraying.',
    by: 'owner',
    day: -66,
    hh: 16,
    used: { times: 11, lastDay: -3 },
  },
  {
    fieldKey: 'comments',
    text: 'Access limited: side gate locked. Treated the front and rear only; please leave the gate unlocked next visit.',
    by: 'sub',
    day: -58,
    hh: 14,
    used: { times: 3, lastDay: -6 },
  },
  {
    fieldKey: 'comments',
    text: 'Wasp nest removed from under the eaves at the rear. Area treated and the nest taken away for disposal.',
    by: 'owner',
    day: -49,
    hh: 15,
    used: { times: 2, lastDay: -12 },
  },
  {
    fieldKey: 'comments',
    text: 'Café manager très content 😊 — kitchen, coolroom door seals and bin area treated before opening, no residue left on the benches. Déjà vu behind the espresso machine 🪳, gel reapplied ✅',
    by: 'owner',
    day: -41,
    hh: 7,
    used: { times: 1, lastDay: -41 },
  },
  {
    fieldKey: 'comments',
    text: 'No termite workings sighted during this service. We recommend an annual timber pest inspection (AS 4349.3).',
    by: 'owner',
    day: -30,
    hh: 19,
  },
  {
    fieldKey: 'comments',
    text: 'Bird droppings on the ledges above the loading dock. We recommend a bird-proofing quote.',
    by: 'owner',
    day: -17,
    hh: 20,
  },
  {
    fieldKey: 'comments',
    text: 'Fleas in the carpets and on the pets: vacuum daily for two weeks and treat the pets with a vet-recommended product.',
    by: 'owner',
    day: -6,
    hh: 21,
  },
  {
    fieldKey: 'termiteWorkingsComments',
    text: 'Mud workings found on the slab edge at the rear patio. They were not disturbed. We recommend a termite management proposal.',
    by: 'owner',
    day: -52,
    hh: 19,
    used: { times: 2, lastDay: -10 },
  },
  {
    fieldKey: 'termiteWorkingsComments',
    text: 'Old, inactive workings in the subfloor. No live termites found at the time of inspection.',
    by: 'owner',
    day: -44,
    hh: 20,
  },
  {
    fieldKey: 'activityNotes',
    text: 'Fresh droppings and gnaw marks near the loading dock. Bait topped up in stations 3 and 4.',
    by: 'owner',
    day: -29,
    hh: 18,
    used: { times: 3, lastDay: -5 },
  },
]

/** The pickers the subcontractor closed, oldest first (optionSets.remember).
 * The Couma bait was chosen before the owner archived it, so it is still
 * among their five: the picker has to drop it. */
export const SUB_PICKS: Array<{ key: OptionSetKey; values: Array<string> }> = [
  {
    key: 'products',
    values: ['Ditrac All Weather Blox (0.05 g/kg Bromadiolone)'],
  },
  { key: 'products', values: ['Couma (0.37 g/Kg COUMATETRALYL)'] },
  {
    key: 'products',
    values: [
      'Clear-Out Crawling Insect Aerosol (0.6 g/kg Fipronil)',
      'Biflex Ultra 100 SC (Bifenthrin 100 g/L)',
    ],
  },
  { key: 'nextVisit', values: ['3 Months'] },
  {
    key: 'products',
    values: ['Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)'],
  },
]

/**
 * `sections` with `field` inserted after the field keyed `after`, as the
 * editor's "add a question" leaves it. Copies every level it changes: the
 * sections may be a built-in's own module objects.
 */
export function withField(
  sections: Array<SectionDef>,
  after: string,
  field: FieldDef,
): Array<SectionDef> {
  const s = sections.findIndex((section) =>
    section.fields.some((f) => f.key === after),
  )
  if (s === -1) throw new Error(`withField: no field keyed ${after}`)
  const fields = sections[s].fields
  const i = fields.findIndex((f) => f.key === after)
  return sections.map((section, j) =>
    j === s
      ? {
          ...section,
          fields: [...fields.slice(0, i + 1), field, ...fields.slice(i + 1)],
        }
      : section,
  )
}

// ──────────────────────────────────────────────────────────────── seed

export const seed = internalMutation({
  args: { base: demoBaseV },
  returns: v.object({
    customTemplates: v.record(v.string(), v.id('customReportTemplates')),
  }),
  handler: async (ctx, { base }) => {
    const { businessId } = base
    const owner = await member(ctx, base, 'owner')
    const sub = await member(ctx, base, 'sub')
    // Every template write is templates.manage, which only an owner holds.
    if (owner.role !== 'owner') throw new ConvexError('NO_ACCESS')

    const when = (day: number, hh: number, mm = 0) => at(base, day, hh, mm)
    const ownerId = owner._id

    // In the order it happened, so `_creationTime` (which the template list
    // sorts by) and the audit trail agree with the dates written on them.

    // ── Three months back: the products the business actually stocks ────
    const [termidor, longProduct] = PRODUCT_CHANGES.added
    await addOption(
      ctx,
      businessId,
      ownerId,
      'products',
      termidor,
      when(-88, 9, 40),
    )
    await addOption(
      ctx,
      businessId,
      ownerId,
      'products',
      longProduct,
      when(-88, 9, 43),
    )

    for (const [i, settings] of TEMPLATE_SETTINGS.entries()) {
      await setTemplateSettings(
        ctx,
        businessId,
        ownerId,
        settings,
        when(-87, 19, 10 + 6 * i),
      )
    }

    for (const [i, treatment] of USUAL_TREATMENTS.entries()) {
      await setUsual(
        ctx,
        businessId,
        ownerId,
        'treatments',
        treatment,
        when(-85, 20, 5 + i),
      )
    }
    for (const [i, product] of PRODUCT_CHANGES.usual.entries()) {
      await setUsual(
        ctx,
        businessId,
        ownerId,
        'products',
        product,
        when(-80, 12, 30 + i),
      )
    }

    // ── Custom forms, and the product list kept up to date around them ──
    const baitStation = await createTemplate(
      ctx,
      businessId,
      ownerId,
      BAIT_STATION,
      when(-78, 20, 0),
    )
    const serviceClone = await cloneBuiltin(
      ctx,
      businessId,
      ownerId,
      SERVICE_CLONE.source,
      SERVICE_CLONE.name,
      when(-75, 19, 30),
    )

    await renameOption(
      ctx,
      businessId,
      ownerId,
      'products',
      PRODUCT_CHANGES.rename.from,
      PRODUCT_CHANGES.rename.to,
      when(-70, 8, 0),
    )

    const possumArchived = await createTemplate(
      ctx,
      businessId,
      ownerId,
      POSSUM,
      when(-62, 18, 45),
    )

    const [firstIssue, secondIssue] = SERVICE_CLONE.issues
    await issue(
      ctx,
      businessId,
      ownerId,
      serviceClone,
      firstIssue,
      when(-60, 19, 0),
      when(-60, 19, 6),
    )

    await archiveOption(
      ctx,
      businessId,
      ownerId,
      'products',
      PRODUCT_CHANGES.archived,
      when(-40, 17, 20),
    )

    const timberDraftInvalid = await cloneBuiltin(
      ctx,
      businessId,
      ownerId,
      TIMBER_VARIANT.source,
      TIMBER_VARIANT.name,
      when(-35, 20, 10),
    )

    await issue(
      ctx,
      businessId,
      ownerId,
      serviceClone,
      secondIssue,
      when(-21, 18, 30),
      when(-21, 18, 37),
    )

    // Ten days ago, so the reports step has room for a draft started on it
    // while it was still offered.
    await archiveTemplate(ctx, businessId, possumArchived, when(-10, 16, 0))

    const timber = await requireOwn(ctx, businessId, timberDraftInvalid)
    await saveDraft(
      ctx,
      businessId,
      ownerId,
      timberDraftInvalid,
      {
        ...contentOf(timber),
        sections: withField(
          sectionsOfRow(timber),
          TIMBER_VARIANT.after,
          TIMBER_VARIANT.duplicate,
        ),
      },
      when(-3, 21, 15),
    )
    await saveDraft(
      ctx,
      businessId,
      ownerId,
      baitStation,
      BAIT_STATION_REVISED,
      when(-2, 20, 40),
    )

    // ── Phrases, as each was saved and then reached for ─────────────────
    const phrases = [...PHRASES].sort((a, b) => a.day - b.day || a.hh - b.hh)
    for (const [i, phrase] of phrases.entries()) {
      const author = phrase.by === 'sub' ? sub._id : ownerId
      const id = await saveSnippet(
        ctx,
        businessId,
        author,
        phrase.fieldKey,
        phrase.text,
        when(phrase.day, phrase.hh, (7 * i) % 60),
      )
      if (phrase.used) {
        await markUsed(
          ctx,
          businessId,
          id,
          phrase.used.times,
          when(phrase.used.lastDay, 10, (11 * i) % 60),
        )
      }
    }

    // ── The subcontractor's pickers ────────────────────────────────────
    for (const pick of SUB_PICKS) {
      await remember(ctx, sub._id, pick.key, pick.values)
    }

    return {
      customTemplates: {
        baitStation,
        serviceClone,
        possumArchived,
        timberDraftInvalid,
      },
    }
  },
})

async function member(
  ctx: MutationCtx,
  base: DemoBase,
  key: 'owner' | 'sub',
): Promise<Doc<'memberships'>> {
  const row = await ctx.db.get(base.members[key])
  // requireMembership's own test: an active member of this business.
  if (!row || row.businessId !== base.businessId || row.status !== 'active') {
    throw new ConvexError(`DEMO_MEMBER_MISSING: ${key}`)
  }
  return row
}

// ─────────────────────────────────── optionSets.ts, handler by handler

/** optionSets.ts `write`: every change stamps who and when. */
async function writeOptions(
  ctx: MutationCtx,
  rowId: Id<'optionSets'>,
  actorMembershipId: Id<'memberships'>,
  patch: Partial<Doc<'optionSets'>>,
  now: number,
) {
  await ctx.db.patch(rowId, {
    ...patch,
    updatedAt: now,
    updatedByMembershipId: actorMembershipId,
  })
}

/** optionSets.ts `record`. */
async function recordOptions(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  actorMembershipId: Id<'memberships'>,
  rowId: Id<'optionSets'>,
  action: string,
  meta: unknown,
  now: number,
) {
  await recordAudit(ctx, forSelf(actorMembershipId), {
    businessId,
    action,
    entityType: 'optionSets',
    entityId: rowId,
    meta,
    at: now,
  })
}

/** optionSets.ts `allSections`: the built-ins and every custom template,
 * archived ones included. */
async function allSections(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Array<SectionDef>> {
  const builtins = Object.values(REPORT_TEMPLATES).flatMap((template) =>
    sectionsOf(template),
  )
  const custom = await ctx.db
    .query('customReportTemplates')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .take(MAX_TEMPLATES_SCANNED + 1)
  if (custom.length > MAX_TEMPLATES_SCANNED) {
    throw new ConvexError('TOO_MANY_TEMPLATES')
  }
  return [...builtins, ...custom.flatMap(sectionsOfRow)]
}

/** optionSets.addOption. */
async function addOption(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  key: OptionSetKey,
  label: string,
  now: number,
) {
  const value = label.trim()
  if (value.length === 0 || value.length > MAX_OPTION_LENGTH) {
    throw new ConvexError('INVALID_OPTION')
  }

  const row = await ensureRow(ctx, businessId, key, ownerId)
  if (row.options.some((o) => o.value === value)) {
    throw new ConvexError('OPTION_EXISTS')
  }
  if (row.options.length >= MAX_LIVE_OPTIONS) {
    throw new ConvexError('TOO_MANY_OPTIONS')
  }

  // Written even when nothing was archived: the app leaves `archived: []`.
  const archived = (row.archived ?? []).filter((o) => o.value !== value)

  await writeOptions(
    ctx,
    row._id,
    ownerId,
    { options: [...row.options, { value, label: value }], archived },
    now,
  )
  await recordOptions(
    ctx,
    businessId,
    ownerId,
    row._id,
    'optionSet.add',
    { key, value },
    now,
  )
}

/** optionSets.setUsual. No audit row: a star changes nothing that prints. */
async function setUsual(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  key: OptionSetKey,
  value: string,
  now: number,
) {
  const row = await ensureRow(ctx, businessId, key, ownerId)
  if (!row.options.some((o) => o.value === value)) {
    throw new ConvexError('NOT_FOUND')
  }
  await writeOptions(
    ctx,
    row._id,
    ownerId,
    {
      options: row.options.map((o) =>
        o.value === value ? { ...o, usual: true } : o,
      ),
    },
    now,
  )
}

/** optionSets.renameOption, open drafts included (there are none yet, but
 * the app looks, and so does this). */
async function renameOption(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  key: OptionSetKey,
  from: string,
  to: string,
  now: number,
) {
  const target = to.trim()
  if (target === from) return
  if (target.length === 0 || target.length > MAX_OPTION_LENGTH) {
    throw new ConvexError('INVALID_OPTION')
  }

  const sections = await allSections(ctx, businessId)
  const pinned = pinnedValues(sections, key)
  if (pinned.has(from) || pinned.has(target)) {
    throw new ConvexError('OPTION_PINNED')
  }
  const blanks = sections
    .flatMap((section) => section.fields)
    .flatMap((field) => (field.kind === 'repeater' ? field.columns : [field]))
    .map((field) => ('blankOption' in field ? field.blankOption : undefined))
  if (blanks.includes(target)) throw new ConvexError('INVALID_OPTION')

  const row = await ensureRow(ctx, businessId, key, ownerId)
  if (!row.options.some((o) => o.value === from)) {
    throw new ConvexError('NOT_FOUND')
  }
  if (row.options.some((o) => o.value === target)) {
    throw new ConvexError('OPTION_EXISTS')
  }
  if ((row.archived ?? []).some((o) => o.value === target)) {
    throw new ConvexError('OPTION_EXISTS')
  }

  await ctx.db.patch(row._id, {
    options: row.options.map((o) =>
      o.value === from ? { ...o, value: target, label: target } : o,
    ),
    renames: [...row.renames, { from, to: target, at: now }].slice(
      -MAX_RENAMES,
    ),
    updatedAt: now,
    updatedByMembershipId: ownerId,
  })
  await recordAudit(ctx, forSelf(ownerId), {
    businessId,
    action: 'optionSet.rename',
    entityType: 'optionSets',
    entityId: row._id,
    meta: { key, from, to: target },
    at: now,
  })

  await rewriteDraftsForRename(ctx, {
    businessId,
    key,
    from,
    to: target,
    actorMembershipId: ownerId,
  })
}

/** optionSets.archiveOption. */
async function archiveOption(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  key: OptionSetKey,
  value: string,
  now: number,
) {
  const pinned = pinnedValues(await allSections(ctx, businessId), key)
  if (pinned.has(value)) throw new ConvexError('OPTION_PINNED')

  const row = await ensureRow(ctx, businessId, key, ownerId)
  const option = row.options.find((o) => o.value === value)
  if (!option) throw new ConvexError('NOT_FOUND')
  if (row.options.length === 1) throw new ConvexError('LAST_OPTION')

  await writeOptions(
    ctx,
    row._id,
    ownerId,
    {
      options: row.options.filter((o) => o.value !== value),
      archived: [...(row.archived ?? []), { value, label: option.label }],
    },
    now,
  )
  await recordOptions(
    ctx,
    businessId,
    ownerId,
    row._id,
    'optionSet.archive',
    { key, value },
    now,
  )
}

/** optionSets.remember: the member's own last five per list. */
async function remember(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
  key: OptionSetKey,
  values: Array<string>,
) {
  const me = await ctx.db.get(membershipId)
  if (!me) throw new ConvexError('NOT_FOUND')

  const recent = { ...(me.reportPrefs?.recent ?? {}) }
  const before = recent[key] ?? []
  const picked = values
    .map((value) => value.trim())
    .filter((value) => value !== '' && value.length <= MAX_OPTION_LENGTH)
  const next = rememberedOrder(before, picked)

  const same =
    next.length === before.length &&
    next.every((value, i) => value === before[i])
  if (same) return

  recent[key] = next
  await ctx.db.patch(me._id, { reportPrefs: { recent } })
}

// ─────────────────────────────────────────── templateSettings.set

async function setTemplateSettings(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  fields: (typeof TEMPLATE_SETTINGS)[number],
  now: number,
) {
  const { templateRef } = fields
  const print = {
    ...(trimmed(fields.formName) ? { formName: trimmed(fields.formName) } : {}),
    ...(trimmed(fields.coverTitle) || trimmed(fields.coverSubtitle)
      ? {
          cover: {
            ...(trimmed(fields.coverTitle)
              ? { title: trimmed(fields.coverTitle) }
              : {}),
            ...(trimmed(fields.coverSubtitle)
              ? { subtitle: trimmed(fields.coverSubtitle) }
              : {}),
          },
        }
      : {}),
  }

  const patch = {
    businessId,
    templateRef,
    ...(Object.keys(print).length > 0 ? { print } : { print: undefined }),
    requiredSigners: fields.requiredSigners,
    updatedByMembershipId: ownerId,
    updatedAt: now,
  }

  // An upsert, as the app's is: two rows for one form make `.unique()` throw
  // in every report of that form.
  const existing = await ctx.db
    .query('templateSettings')
    .withIndex('by_business_template', (q) =>
      q.eq('businessId', businessId).eq('templateRef', templateRef),
    )
    .unique()

  if (existing) await ctx.db.patch(existing._id, patch)
  else await ctx.db.insert('templateSettings', patch)
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text === undefined || text === '' ? undefined : text
}

// ─────────────────────────────────────────── customTemplates.ts

/** Its published sections, as optionSets.ts reads them. */
function sectionsOfRow(row: Doc<'customReportTemplates'>): Array<SectionDef> {
  return (row.sections ?? []) as Array<SectionDef>
}

/** What the editor sends with every draft: the row's current words, edited. */
function contentOf(row: Doc<'customReportTemplates'>): TemplateContent {
  return {
    name: row.name,
    shortName: row.shortName,
    legalBasis: row.legalBasis,
    blurb: row.blurb,
    sections: sectionsOfRow(row),
    boilerplate: row.boilerplate,
  }
}

async function requireOwn(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  templateId: Id<'customReportTemplates'>,
) {
  const doc = await ctx.db.get(templateId)
  if (!doc || doc.businessId !== businessId) throw new ConvexError('NOT_FOUND')
  return doc
}

/** customTemplates.create: issued as version 1, with no history row. */
async function createTemplate(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  content: TemplateContent,
  now: number,
) {
  const parsed = customTemplateSectionsSchema.safeParse(content.sections)
  if (!parsed.success) throw new ConvexError('INVALID_TEMPLATE')

  return ctx.db.insert('customReportTemplates', {
    businessId,
    name: content.name,
    shortName: content.shortName,
    legalBasis: content.legalBasis,
    blurb: content.blurb,
    sections: parsed.data,
    boilerplate: content.boilerplate,
    createdByMembershipId: ownerId,
    updatedByMembershipId: ownerId,
    publishedVersion: 1,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  })
}

/** customTemplates.cloneBuiltin: no version, publish stamp or editor yet,
 * which readers take as version 1. */
async function cloneBuiltin(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  sourceTemplateId: TemplateId,
  name: string,
  now: number,
) {
  if (RETIRED_TEMPLATES.has(sourceTemplateId)) {
    throw new ConvexError('TEMPLATE_RETIRED')
  }
  const source = getTemplate(sourceTemplateId)

  return ctx.db.insert('customReportTemplates', {
    businessId,
    name,
    shortName: source.shortName,
    legalBasis: source.legalBasis,
    blurb: source.blurb,
    sections: sectionsOf(source),
    boilerplate: source.boilerplate,
    terms: source.terms,
    print: source.print,
    createdByMembershipId: ownerId,
    createdAt: now,
    updatedAt: now,
  })
}

/** customTemplates.saveDraft: stored as sent, unvalidated. */
async function saveDraft(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  templateId: Id<'customReportTemplates'>,
  draft: TemplateContent,
  now: number,
) {
  const existing = await requireOwn(ctx, businessId, templateId)
  await ctx.db.patch(existing._id, {
    draft: {
      name: draft.name,
      shortName: draft.shortName,
      legalBasis: draft.legalBasis,
      blurb: draft.blurb,
      sections: draft.sections,
      boilerplate: draft.boilerplate,
      savedAt: now,
      savedByMembershipId: ownerId,
    },
    updatedAt: now,
    updatedByMembershipId: ownerId,
  })
}

/** customTemplates.publish: the draft becomes the next version, and the
 * history gets a row carrying the template's own terms and print. */
async function publish(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  templateId: Id<'customReportTemplates'>,
  now: number,
) {
  const existing = await requireOwn(ctx, businessId, templateId)
  const draft = existing.draft
  if (!draft) throw new ConvexError('NOTHING_TO_PUBLISH')

  const parsed = customTemplateSectionsSchema.safeParse(draft.sections)
  if (!parsed.success) throw new ConvexError('INVALID_TEMPLATE')

  const version = (existing.publishedVersion ?? 1) + 1

  await ctx.db.patch(existing._id, {
    name: draft.name,
    shortName: draft.shortName,
    legalBasis: draft.legalBasis,
    blurb: draft.blurb,
    sections: parsed.data,
    boilerplate: draft.boilerplate,
    draft: undefined,
    publishedVersion: version,
    publishedAt: now,
    updatedAt: now,
    updatedByMembershipId: ownerId,
  })

  // recordVersion: terms and print only when the row has them.
  const { terms, print } = existing
  await ctx.db.insert('customReportTemplateVersions', {
    businessId,
    templateId: existing._id,
    version,
    name: draft.name,
    shortName: draft.shortName,
    legalBasis: draft.legalBasis,
    blurb: draft.blurb,
    sections: parsed.data,
    boilerplate: draft.boilerplate,
    ...(terms !== undefined ? { terms } : {}),
    ...(print !== undefined ? { print } : {}),
    publishedByMembershipId: ownerId,
    publishedAt: now,
  })
}

/** An edit saved in the editor, then issued a few minutes later. */
async function issue(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  ownerId: Id<'memberships'>,
  templateId: Id<'customReportTemplates'>,
  change: Issue,
  savedAt: number,
  publishedAt: number,
) {
  const row = await requireOwn(ctx, businessId, templateId)
  const current = contentOf(row)
  await saveDraft(
    ctx,
    businessId,
    ownerId,
    templateId,
    {
      ...current,
      name: change.name,
      blurb: change.blurb ?? current.blurb,
      sections: withField(current.sections, change.after, change.field),
    },
    savedAt,
  )
  await publish(ctx, businessId, ownerId, templateId, publishedAt)
}

/** customTemplates.archive: the stamp and updatedAt, nothing else. */
async function archiveTemplate(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  templateId: Id<'customReportTemplates'>,
  now: number,
) {
  await requireOwn(ctx, businessId, templateId)
  await ctx.db.patch(templateId, { archivedAt: now, updatedAt: now })
}

// ──────────────────────────────────────────────────────── snippets.ts

/** snippets.save, with its limits: trimmed, 600 characters, 12 per box, 200
 * per business, and the same words twice is the one already saved. */
async function saveSnippet(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  authorId: Id<'memberships'>,
  fieldKey: string,
  text: string,
  now: number,
): Promise<Id<'reportSnippets'>> {
  const trimmedText = text.trim()
  if (trimmedText === '' || trimmedText.length > MAX_SNIPPET_LENGTH) {
    throw new ConvexError('INVALID_SNIPPET')
  }
  if (fieldKey.length === 0 || fieldKey.length > 128) {
    throw new ConvexError('INVALID_SNIPPET')
  }

  const existing = await ctx.db
    .query('reportSnippets')
    .withIndex('by_business_field', (q) =>
      q.eq('businessId', businessId).eq('fieldKey', fieldKey),
    )
    .take(MAX_SNIPPETS_PER_FIELD + 1)

  const already = existing.find((row) => sameSnippet(row.text, trimmedText))
  if (already) return already._id

  if (existing.length >= MAX_SNIPPETS_PER_FIELD) {
    throw new ConvexError('TOO_MANY_SNIPPETS')
  }

  const held = await ctx.db
    .query('reportSnippets')
    .withIndex('by_business_field', (q) => q.eq('businessId', businessId))
    .take(MAX_SNIPPETS)
  if (held.length >= MAX_SNIPPETS) throw new ConvexError('TOO_MANY_SNIPPETS')

  return ctx.db.insert('reportSnippets', {
    businessId,
    fieldKey,
    text: trimmedText,
    createdByMembershipId: authorId,
    usedCount: 0,
    createdAt: now,
  })
}

/** snippets.used, `times` over: the count, and when it was last reached for. */
async function markUsed(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  snippetId: Id<'reportSnippets'>,
  times: number,
  lastUsedAt: number,
) {
  const row = await ctx.db.get(snippetId)
  if (!row || row.businessId !== businessId) return
  await ctx.db.patch(snippetId, {
    usedCount: row.usedCount + times,
    lastUsedAt,
  })
}
